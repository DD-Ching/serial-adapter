from __future__ import annotations

from collections import deque
import copy
import json
import threading
import time
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

try:
    import serial  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    serial = None

try:
    from .ring_buffer import (
        DEFAULT_BUFFER_SIZE,
        DEFAULT_FRAME_DELIMITER,
        DEFAULT_MAX_FRAMES,
        RingBuffer,
    )
    from .statistics import RollingStatistics
    from .tcp_server import TcpBroadcastServer, TcpControlServer, TcpTelemetryServer
except ImportError:
    from plugins.serial_adapter.ring_buffer import (
        DEFAULT_BUFFER_SIZE,
        DEFAULT_FRAME_DELIMITER,
        DEFAULT_MAX_FRAMES,
        RingBuffer,
    )
    from plugins.serial_adapter.statistics import RollingStatistics
    from plugins.serial_adapter.tcp_server import (
        TcpBroadcastServer,
        TcpControlServer,
        TcpTelemetryServer,
    )


__all__ = [
    "DEFAULT_BUFFER_SIZE",
    "DEFAULT_FRAME_DELIMITER",
    "DEFAULT_MAX_FRAMES",
    "DEFAULT_ALLOWED_COMMANDS",
    "DEFAULT_MAX_CONTROL_RATE",
    "RingBuffer",
    "RollingStatistics",
    "TcpTelemetryServer",
    "TcpControlServer",
    "TcpBroadcastServer",
    "SerialAdapter",
]

DEFAULT_ALLOWED_COMMANDS: tuple[str, ...] = ("motor_pwm", "target_velocity")
DEFAULT_MAX_CONTROL_RATE = 50


class SerialAdapter:
    """Universal Telemetry Adapter v3: serial transport + TCP observer transport."""

    def __init__(
        self,
        port: str,
        baudrate: int,
        *,
        buffer_size: int = DEFAULT_BUFFER_SIZE,
        frame_delimiter: bytes | str = DEFAULT_FRAME_DELIMITER,
        max_frames: int = DEFAULT_MAX_FRAMES,
        tcp_host: str = "127.0.0.1",
        telemetry_port: int = 9000,
        control_port: int = 9001,
        tcp_port: Optional[int] = None,
        enable_tcp: bool = True,
        unsafe_passthrough: bool = False,
        allowed_commands: Optional[List[str]] = None,
        max_control_rate: int = DEFAULT_MAX_CONTROL_RATE,
    ) -> None:
        self._port = port
        self._baudrate = int(baudrate)
        self._max_frames = int(max_frames)
        self._unsafe_passthrough = bool(unsafe_passthrough)
        if allowed_commands is None:
            self._allowed_commands = set(DEFAULT_ALLOWED_COMMANDS)
        else:
            self._allowed_commands = {str(cmd) for cmd in allowed_commands if str(cmd)}
        self._max_control_rate = int(max_control_rate)
        self._control_timestamps: Deque[float] = deque()
        self._rx_timestamps: Deque[float] = deque()
        self._tx_timestamps: Deque[float] = deque()
        self._control_commands_accepted = 0
        self._control_commands_rejected = 0

        self._serial: Optional[Any] = None
        self._ring_buffer = RingBuffer(
            buffer_size=buffer_size,
            max_frames=max_frames,
            frame_delimiter=frame_delimiter,
        )
        self._statistics = RollingStatistics(window_size=max_frames)

        self._latest_frame: Optional[Dict[str, Any]] = None
        self._frame_history: Deque[Dict[str, Any]] = deque(maxlen=self._max_frames)
        self._pending_frames: Deque[Dict[str, Any]] = deque()
        self._callbacks: List[Callable[[Dict[str, Any]], None]] = []

        self._serial_lock = threading.Lock()
        self._frame_lock = threading.Lock()
        self._callback_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._control_lock = threading.Lock()
        self._status_lock = threading.Lock()

        self._reader_stop = threading.Event()
        self._reader_thread: Optional[threading.Thread] = None
        self._reader_sleep_s = 0.002

        self._telemetry_server: Optional[TcpTelemetryServer] = None
        self._control_server: Optional[TcpControlServer] = None
        self._compat_server: Optional[TcpBroadcastServer] = None

        if not enable_tcp:
            return

        if tcp_port is not None:
            # Backward-compatible combined channel mode.
            self._compat_server = TcpBroadcastServer(
                host=tcp_host,
                port=int(tcp_port),
                command_handler=self._handle_control_command,
            )
            return

        if int(telemetry_port) == int(control_port):
            raise ValueError("telemetry_port and control_port must differ")

        self._telemetry_server = TcpTelemetryServer(
            host=tcp_host,
            port=int(telemetry_port),
        )
        self._control_server = TcpControlServer(
            host=tcp_host,
            port=int(control_port),
            command_handler=self._handle_control_command,
        )

    def _reset_runtime_state(self) -> None:
        self._ring_buffer.clear()
        self._statistics.clear()
        with self._control_lock:
            self._control_timestamps.clear()
        with self._status_lock:
            self._rx_timestamps.clear()
            self._tx_timestamps.clear()
            self._control_commands_accepted = 0
            self._control_commands_rejected = 0
        with self._frame_lock:
            self._latest_frame = None
            self._frame_history.clear()
            self._pending_frames.clear()

    def connect(self) -> bool:
        """Open serial transport and start reader + TCP threads."""
        with self._state_lock:
            if self._serial is not None:
                return True
            if serial is None:
                raise RuntimeError("pyserial is not available")
            try:
                # timeout=0 keeps reads non-blocking for the reader loop.
                self._serial = serial.Serial(self._port, self._baudrate, timeout=0)
            except Exception as exc:
                raise RuntimeError(f"Failed to open serial port: {self._port}") from exc

            self._reset_runtime_state()
            self._start_locked()
            return True

    def start(self) -> None:
        """Start reader/TCP threads when serial transport is already assigned."""
        with self._state_lock:
            if self._serial is None:
                raise RuntimeError("Serial not connected")
            self._start_locked()

    def _start_locked(self) -> None:
        if self._reader_thread is not None and self._reader_thread.is_alive():
            return

        if self._compat_server is not None:
            self._compat_server.start()
        else:
            if self._telemetry_server is not None:
                self._telemetry_server.start()
            if self._control_server is not None:
                self._control_server.start()

        self._reader_stop.clear()
        self._reader_thread = threading.Thread(
            target=self._reader_loop,
            name="serial-adapter-reader",
            daemon=True,
        )
        self._reader_thread.start()

    def stop(self) -> None:
        """Stop reader/TCP threads while keeping the serial handle open."""
        self._stop_threads()

    def _stop_threads(self) -> None:
        thread: Optional[threading.Thread]
        with self._state_lock:
            self._reader_stop.set()
            thread = self._reader_thread
            self._reader_thread = None

        if thread is not None:
            thread.join(timeout=2.0)

        if self._compat_server is not None:
            self._compat_server.stop()
        else:
            if self._telemetry_server is not None:
                self._telemetry_server.stop()
            if self._control_server is not None:
                self._control_server.stop()

    def disconnect(self) -> None:
        """Stop worker threads and close serial transport."""
        self._stop_threads()

        with self._serial_lock:
            if self._serial is not None:
                try:
                    self._serial.close()
                finally:
                    self._serial = None

        self._reset_runtime_state()

    def register_callback(self, fn: Callable[[Dict[str, Any]], None]) -> None:
        if not callable(fn):
            raise TypeError("callback must be callable")
        with self._callback_lock:
            self._callbacks.append(fn)

    def _notify_callbacks(self, frame: Dict[str, Any]) -> None:
        with self._callback_lock:
            callbacks = list(self._callbacks)
        for callback in callbacks:
            try:
                callback(frame)
            except Exception:
                # Observers are best-effort and must not block telemetry flow.
                continue

    def _read_serial_chunk_nonblocking(self) -> bytes:
        with self._serial_lock:
            if self._serial is None:
                raise RuntimeError("Serial not connected")

            waiting = getattr(self._serial, "in_waiting", None)
            if waiting is not None:
                try:
                    waiting_count = int(waiting)
                except Exception:
                    waiting_count = 0

                if waiting_count <= 0:
                    return b""

                read_fn = getattr(self._serial, "read", None)
                if callable(read_fn):
                    chunk = read_fn(waiting_count)
                else:
                    chunk = self._serial.readline()
            else:
                read_fn = getattr(self._serial, "read", None)
                if callable(read_fn):
                    chunk = read_fn(4096)
                else:
                    chunk = self._serial.readline()

        if not chunk:
            return b""
        if not isinstance(chunk, (bytes, bytearray)):
            raise TypeError("serial read must return bytes")
        return bytes(chunk)

    def _build_frame(self, frame_bytes: bytes) -> Dict[str, Any]:
        raw = frame_bytes.decode("utf-8", errors="replace")
        parsed: Optional[Dict[str, Any]] = None
        try:
            payload = json.loads(raw)
            if isinstance(payload, dict):
                parsed = payload
        except json.JSONDecodeError:
            parsed = None

        frame: Dict[str, Any] = {
            "timestamp": time.time(),
            "raw": raw,
            "parsed": parsed,
            "meta": {
                "size": len(frame_bytes),
                "source": "serial",
            },
        }
        if parsed is not None:
            frame.update(parsed)
        return frame

    def _publish_frame(self, frame: Dict[str, Any]) -> None:
        with self._frame_lock:
            self._latest_frame = frame
            self._frame_history.append(frame)
            if len(self._pending_frames) >= self._max_frames:
                self._pending_frames.popleft()
            self._pending_frames.append(frame)

        self._record_rx_event()
        self._statistics.update(frame)
        self._notify_callbacks(frame)
        if self._compat_server is not None:
            self._compat_server.enqueue_frame(frame)
        elif self._telemetry_server is not None:
            self._telemetry_server.enqueue_frame(frame)

    def _process_chunk(self, chunk: bytes) -> List[Dict[str, Any]]:
        if chunk:
            self._ring_buffer.append(chunk)

        frames: List[Dict[str, Any]] = []
        while True:
            frame_bytes = self._ring_buffer.read_frame()
            if frame_bytes is None:
                break
            frame = self._build_frame(frame_bytes)
            self._publish_frame(frame)
            frames.append(frame)
        return frames

    def _reader_loop(self) -> None:
        while not self._reader_stop.is_set():
            try:
                chunk = self._read_serial_chunk_nonblocking()
                emitted = self._process_chunk(chunk)
                if not chunk and not emitted:
                    time.sleep(self._reader_sleep_s)
            except RuntimeError:
                if self._reader_stop.is_set():
                    break
                time.sleep(self._reader_sleep_s)
            except Exception:
                time.sleep(self._reader_sleep_s)

    def poll(self) -> Optional[Dict[str, Any]]:
        """Non-blocking read of one structured frame."""
        reader_alive = self._reader_thread is not None and self._reader_thread.is_alive()
        if not reader_alive:
            chunk = self._read_serial_chunk_nonblocking()
            self._process_chunk(chunk)

        with self._frame_lock:
            if not self._pending_frames:
                return None
            frame = self._pending_frames.popleft()
        return copy.deepcopy(frame)

    def poll_all(self) -> List[Dict[str, Any]]:
        """Return all currently available structured frames."""
        reader_alive = self._reader_thread is not None and self._reader_thread.is_alive()
        if not reader_alive:
            chunk = self._read_serial_chunk_nonblocking()
            self._process_chunk(chunk)

        with self._frame_lock:
            frames = list(self._pending_frames)
            self._pending_frames.clear()
        return [copy.deepcopy(frame) for frame in frames]

    def read(self) -> Optional[Dict[str, Any]]:
        """Backward-compatible alias for poll()."""
        return self.poll()

    def write(self, data: Dict[str, Any]) -> bool:
        """Write control/command payload to serial transport as JSON frame."""
        if not isinstance(data, dict):
            raise TypeError("data must be a dict")

        payload = json.dumps(
            data,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8") + self._ring_buffer.frame_delimiter

        with self._serial_lock:
            if self._serial is None:
                raise RuntimeError("Serial not connected")
            self._serial.write(payload)
            flush_fn = getattr(self._serial, "flush", None)
            if callable(flush_fn):
                flush_fn()
        return True

    def _handle_control_command(self, command: Dict[str, Any]) -> None:
        if not self._is_control_command_allowed(command):
            self._record_control_rejected()
            return
        if not self._consume_control_rate_slot():
            self._record_control_rejected()
            return
        try:
            self.write(command)
        except Exception:
            # Control path is best-effort.
            self._record_control_rejected()
            return
        self._record_control_accepted()

    def _is_control_command_allowed(self, command: Dict[str, Any]) -> bool:
        if self._unsafe_passthrough:
            return True
        return all(key in self._allowed_commands for key in command.keys())

    def _consume_control_rate_slot(self) -> bool:
        if self._max_control_rate <= 0:
            return True
        now = time.monotonic()
        window_start = now - 1.0
        with self._control_lock:
            while self._control_timestamps and self._control_timestamps[0] < window_start:
                self._control_timestamps.popleft()
            if len(self._control_timestamps) >= self._max_control_rate:
                return False
            self._control_timestamps.append(now)
            return True

    def _record_rx_event(self) -> None:
        now = time.monotonic()
        with self._status_lock:
            self._rx_timestamps.append(now)
            self._prune_timestamps_locked(self._rx_timestamps, now)

    def _record_control_accepted(self) -> None:
        now = time.monotonic()
        with self._status_lock:
            self._control_commands_accepted += 1
            self._tx_timestamps.append(now)
            self._prune_timestamps_locked(self._tx_timestamps, now)

    def _record_control_rejected(self) -> None:
        with self._status_lock:
            self._control_commands_rejected += 1

    def _prune_timestamps_locked(self, queue: Deque[float], now: float) -> None:
        cutoff = now - 1.0
        while queue and queue[0] < cutoff:
            queue.popleft()

    def _handle_telemetry_request(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if payload.get("cmd") != "status":
            return None
        return self.get_status()

    def get_latest_frame(self) -> Optional[Dict[str, Any]]:
        with self._frame_lock:
            if self._latest_frame is None:
                return None
            return copy.deepcopy(self._latest_frame)

    def get_last_n_frames(self, n: int) -> List[Dict[str, Any]]:
        if int(n) <= 0:
            return []
        with self._frame_lock:
            frames = list(self._frame_history)[-int(n) :]
        return [copy.deepcopy(frame) for frame in frames]

    def get_statistics(self) -> Dict[str, Any]:
        return self._statistics.snapshot()

    def get_status(self) -> Dict[str, Any]:
        now = time.monotonic()
        with self._status_lock:
            self._prune_timestamps_locked(self._rx_timestamps, now)
            self._prune_timestamps_locked(self._tx_timestamps, now)
            rx_rate = float(len(self._rx_timestamps))
            tx_rate = float(len(self._tx_timestamps))
            control_commands_accepted = int(self._control_commands_accepted)
            control_commands_rejected = int(self._control_commands_rejected)

        if self._compat_server is not None:
            connected_clients = self._compat_server.get_client_count()
        else:
            connected_clients = 0
            if self._telemetry_server is not None:
                connected_clients += self._telemetry_server.get_client_count()
            if self._control_server is not None:
                connected_clients += self._control_server.get_client_count()

        return {
            "rx_rate": rx_rate,
            "tx_rate": tx_rate,
            "connected_clients": int(connected_clients),
            "ring_buffer_usage_ratio": self._ring_buffer.usage_ratio,
            "control_commands_accepted": control_commands_accepted,
            "control_commands_rejected": control_commands_rejected,
        }

    def get_tcp_endpoint(self) -> Optional[Tuple[str, int]]:
        if self._compat_server is not None:
            return (self._compat_server.bound_host, self._compat_server.bound_port)
        if self._telemetry_server is None:
            return None
        return (self._telemetry_server.bound_host, self._telemetry_server.bound_port)

    def get_control_endpoint(self) -> Optional[Tuple[str, int]]:
        if self._compat_server is not None:
            return (self._compat_server.bound_host, self._compat_server.bound_port)
        if self._control_server is None:
            return None
        return (self._control_server.bound_host, self._control_server.bound_port)
