from __future__ import annotations

import copy
import json
import re
import threading
import time
from collections import deque
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
    from statistics import RollingStatistics  # type: ignore[no-rebase]

    from ring_buffer import (  # type: ignore[no-rebase]
        DEFAULT_BUFFER_SIZE,
        DEFAULT_FRAME_DELIMITER,
        DEFAULT_MAX_FRAMES,
        RingBuffer,
    )
    from tcp_server import (  # type: ignore[no-rebase]
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
DEFAULT_REOPEN_INTERVAL_S = 2.0
DEFAULT_MAX_QUEUED_CONTROL = 128
RAW_CONTROL_PATTERN = re.compile(
    r"^(?:A-?\d{1,4}|P-?\d{1,5}|-?\d{1,4})$",
    flags=re.IGNORECASE,
)
PROBE_CONTROL_COMMANDS = {
    "IMU?",
    "IMU_ON",
    "TELEMETRY_ON",
    "STREAM_ON",
    "ANGLE?",
    "STATUS?",
}
KEY_VALUE_NUMERIC_PATTERN = re.compile(
    r"([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)"
)

ADAPTER_CMD_KEY = "__adapter_cmd"
ADAPTER_CMD_PAUSE = "pause"
ADAPTER_CMD_RESUME = "resume"
ADAPTER_CMD_STATUS = "status"
ADAPTER_CMD_CAPABILITIES = "capabilities"

CONTROL_META_SOURCE_ID = "source_id"
CONTROL_META_PRIORITY = "priority"
CONTROL_META_LEASE_MS = "lease_ms"
DEFAULT_CONTROL_LEASE_MS = 5000
MIN_CONTROL_LEASE_MS = 200
MAX_CONTROL_LEASE_MS = 120000

AUTO_PROBE_SEQUENCE: tuple[str, ...] = (
    "STATUS?",
    "IMU_ON",
    "TELEMETRY_ON",
    "STREAM_ON",
    "IMU?",
)
AUTO_PROBE_IDLE_INTERVAL_S = 1.5
AUTO_PROBE_MIN_GAP_S = 0.35
AUTO_PROBE_MAX_BACKOFF_S = 30.0


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
        max_queued_control: int = DEFAULT_MAX_QUEUED_CONTROL,
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
        self._max_queued_control = max(1, int(max_queued_control))
        self._control_timestamps: Deque[float] = deque()
        self._rx_timestamps: Deque[float] = deque()
        self._tx_timestamps: Deque[float] = deque()
        self._control_commands_accepted = 0
        self._control_commands_rejected = 0
        self._control_commands_queued = 0
        self._queued_control_dropped = 0
        self._control_lease_owner: Optional[str] = None
        self._control_lease_priority = 0
        self._control_lease_expires_monotonic = 0.0
        self._last_rx_monotonic = 0.0
        self._last_probe_monotonic = 0.0
        self._last_probe_line: Optional[str] = None
        self._last_probe_reason: Optional[str] = None
        self._probe_sent_count = 0
        self._next_probe_index = 0
        self._auto_probe_backoff_s = float(AUTO_PROBE_IDLE_INTERVAL_S)
        self._auto_probe_fail_streak = 0

        self._serial: Optional[Any] = None
        self._serial_reopen_interval_s = float(DEFAULT_REOPEN_INTERVAL_S)
        self._next_reopen_monotonic = 0.0
        self._serial_paused = False
        self._pause_until_monotonic: Optional[float] = None
        self._serial_reconnect_attempts = 0
        self._serial_last_error: Optional[str] = None
        self._ring_buffer = RingBuffer(
            buffer_size=buffer_size,
            max_frames=max_frames,
            frame_delimiter=frame_delimiter,
        )
        self._statistics = RollingStatistics(window_size=max_frames)

        self._latest_frame: Optional[Dict[str, Any]] = None
        self._frame_history: Deque[Dict[str, Any]] = deque(maxlen=self._max_frames)
        self._pending_frames: Deque[Dict[str, Any]] = deque()
        self._queued_control: Deque[Tuple[str, Any]] = deque()
        self._callbacks: List[Callable[[Dict[str, Any]], None]] = []

        self._serial_lock = threading.Lock()
        self._frame_lock = threading.Lock()
        self._callback_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._control_lock = threading.Lock()
        self._queue_lock = threading.Lock()
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
        self._serial_reconnect_attempts = 0
        self._serial_last_error = None
        self._next_reopen_monotonic = 0.0
        self._serial_paused = False
        self._pause_until_monotonic = None
        with self._control_lock:
            self._control_timestamps.clear()
            self._control_lease_owner = None
            self._control_lease_priority = 0
            self._control_lease_expires_monotonic = 0.0
        with self._status_lock:
            self._rx_timestamps.clear()
            self._tx_timestamps.clear()
            self._control_commands_accepted = 0
            self._control_commands_rejected = 0
            self._control_commands_queued = 0
            self._queued_control_dropped = 0
            self._last_rx_monotonic = 0.0
            self._last_probe_monotonic = 0.0
            self._last_probe_line = None
            self._last_probe_reason = None
            self._probe_sent_count = 0
            self._next_probe_index = 0
            self._auto_probe_backoff_s = float(AUTO_PROBE_IDLE_INTERVAL_S)
            self._auto_probe_fail_streak = 0
        with self._queue_lock:
            self._queued_control.clear()
        with self._frame_lock:
            self._latest_frame = None
            self._frame_history.clear()
            self._pending_frames.clear()

    def _set_serial_error(self, message: Optional[str]) -> None:
        with self._state_lock:
            self._serial_last_error = message

    def _close_serial_transport(self) -> None:
        with self._serial_lock:
            if self._serial is None:
                return
            try:
                self._serial.close()
            except Exception:
                pass
            finally:
                self._serial = None

    def _open_serial_transport(self, *, raise_on_error: bool) -> bool:
        if serial is None:
            raise RuntimeError("pyserial is not available")

        with self._serial_lock:
            if self._serial is not None:
                return True
            try:
                # timeout=0 keeps reads non-blocking for the reader loop.
                self._serial = serial.Serial(self._port, self._baudrate, timeout=0)
            except Exception as exc:
                self._serial = None
                self._set_serial_error(f"{type(exc).__name__}: {exc}")
                if raise_on_error:
                    raise RuntimeError(
                        f"Failed to open serial port: {self._port}"
                    ) from exc
                return False

        self._set_serial_error(None)
        return True

    def pause_serial(self, hold_s: Optional[float] = None) -> None:
        hold_seconds: Optional[float]
        if hold_s is None:
            hold_seconds = None
        else:
            try:
                parsed = float(hold_s)
            except Exception:
                parsed = 0.0
            hold_seconds = parsed if parsed > 0 else None

        with self._state_lock:
            self._serial_paused = True
            self._pause_until_monotonic = (
                time.monotonic() + hold_seconds if hold_seconds is not None else None
            )
            self._next_reopen_monotonic = 0.0

        self._ring_buffer.clear()
        self._close_serial_transport()

    def resume_serial(self) -> None:
        with self._state_lock:
            self._serial_paused = False
            self._pause_until_monotonic = None
            self._next_reopen_monotonic = 0.0
            self._serial_reconnect_attempts = 0
            self._serial_last_error = None

    def _maybe_reopen_serial(self) -> bool:
        now = time.monotonic()
        with self._state_lock:
            if self._serial_paused:
                if (
                    self._pause_until_monotonic is not None
                    and now >= self._pause_until_monotonic
                ):
                    self._serial_paused = False
                    self._pause_until_monotonic = None
                else:
                    return False
            if now < self._next_reopen_monotonic:
                return False
            self._next_reopen_monotonic = now + self._serial_reopen_interval_s

        ok = self._open_serial_transport(raise_on_error=False)
        if ok:
            with self._state_lock:
                self._serial_reconnect_attempts = 0
                self._serial_last_error = None
            self._ring_buffer.clear()
            self._send_next_auto_probe(reason="reopen", force=True)
            return True

        with self._state_lock:
            self._serial_reconnect_attempts += 1
        return False

    def _handle_serial_lost(self, exc: Exception) -> None:
        now = time.monotonic()
        with self._state_lock:
            if self._serial_paused:
                return
            self._serial_last_error = f"{type(exc).__name__}: {exc}"
            self._serial_reconnect_attempts += 1
            self._next_reopen_monotonic = now + self._serial_reopen_interval_s
        self._ring_buffer.clear()
        self._close_serial_transport()

    def _should_send_auto_probe(self, *, force: bool) -> bool:
        if force:
            return True
        now = time.monotonic()
        with self._control_lock:
            self._expire_control_lease_locked(now)
            if self._control_lease_owner is not None:
                # Do not inject probe traffic while an external control source
                # holds the lane.
                return False
        with self._status_lock:
            if now - self._last_probe_monotonic < AUTO_PROBE_MIN_GAP_S:
                return False
            idle_threshold = max(
                float(AUTO_PROBE_IDLE_INTERVAL_S),
                float(self._auto_probe_backoff_s),
            )
            if self._last_rx_monotonic <= 0.0:
                return True
            return (now - self._last_rx_monotonic) >= idle_threshold

    def _send_next_auto_probe(self, *, reason: str, force: bool = False) -> bool:
        if not AUTO_PROBE_SEQUENCE:
            return False
        if not self._should_send_auto_probe(force=force):
            return False

        with self._status_lock:
            line = AUTO_PROBE_SEQUENCE[
                self._next_probe_index % len(AUTO_PROBE_SEQUENCE)
            ]
            self._next_probe_index = (self._next_probe_index + 1) % len(
                AUTO_PROBE_SEQUENCE
            )

        try:
            self.write_raw_line(line)
        except Exception as exc:
            self._handle_serial_lost(exc)
            return False

        now = time.monotonic()
        with self._status_lock:
            self._last_probe_monotonic = now
            self._last_probe_line = line
            self._last_probe_reason = str(reason)
            self._probe_sent_count += 1
            if reason == "idle":
                self._auto_probe_fail_streak = min(
                    int(self._auto_probe_fail_streak) + 1, 16
                )
                self._auto_probe_backoff_s = min(
                    float(AUTO_PROBE_MAX_BACKOFF_S),
                    float(AUTO_PROBE_IDLE_INTERVAL_S)
                    * (2.0 ** float(self._auto_probe_fail_streak)),
                )
            else:
                # Connect/reopen/manual probes reset backoff window.
                self._auto_probe_fail_streak = 0
                self._auto_probe_backoff_s = float(AUTO_PROBE_IDLE_INTERVAL_S)
        return True

    def connect(self) -> bool:
        """Open serial transport and start reader + TCP threads."""
        with self._state_lock:
            if self._serial is not None:
                return True
        self._open_serial_transport(raise_on_error=True)
        with self._state_lock:
            self._reset_runtime_state()
            self._start_locked()
        self._send_next_auto_probe(reason="connect", force=True)
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
        self._close_serial_transport()
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
        ts_ms = int(time.time() * 1000)
        parsed: Optional[Dict[str, Any]] = None
        try:
            payload = json.loads(raw)
            if isinstance(payload, dict):
                parsed = payload
        except json.JSONDecodeError:
            parsed = self._try_parse_key_value_text(raw)

        frame: Dict[str, Any] = {
            "ts": ts_ms,
            "timestamp": time.time(),
            "raw": raw,
            "parsed": parsed,
            "meta": {
                "size": len(frame_bytes),
                "source": "serial",
            },
        }
        if parsed is not None:
            for key, value in parsed.items():
                if key in {"ts", "timestamp", "raw", "parsed", "meta"}:
                    continue
                frame[key] = value
        return frame

    def _try_parse_key_value_text(self, raw: str) -> Optional[Dict[str, Any]]:
        text = str(raw).strip()
        if not text:
            return None

        matches = KEY_VALUE_NUMERIC_PATTERN.findall(text)
        if not matches:
            return None

        out: Dict[str, Any] = {}
        for key, numeric_text in matches:
            normalized_key = str(key).strip().lower()
            if not normalized_key:
                continue
            try:
                value = float(numeric_text)
            except ValueError:
                continue
            if value.is_integer():
                out[normalized_key] = int(value)
            else:
                out[normalized_key] = float(value)

        if not out:
            return None
        return out

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
                with self._serial_lock:
                    has_serial = self._serial is not None
                if not has_serial and not self._maybe_reopen_serial():
                    time.sleep(self._reader_sleep_s)
                    continue
                has_serial = True

                chunk = self._read_serial_chunk_nonblocking()
                emitted = self._process_chunk(chunk)
                if has_serial:
                    self._flush_queued_control(max_items=8)
                    if not chunk and not emitted:
                        self._send_next_auto_probe(reason="idle")
                if not chunk and not emitted:
                    time.sleep(self._reader_sleep_s)
            except RuntimeError as exc:
                if self._reader_stop.is_set():
                    break
                self._handle_serial_lost(exc)
                time.sleep(self._reader_sleep_s)
            except Exception as exc:
                self._handle_serial_lost(exc)
                time.sleep(self._reader_sleep_s)

    def poll(self) -> Optional[Dict[str, Any]]:
        """Non-blocking read of one structured frame."""
        reader_alive = (
            self._reader_thread is not None and self._reader_thread.is_alive()
        )
        if not reader_alive:
            if not self._maybe_reopen_serial():
                return None
            chunk = self._read_serial_chunk_nonblocking()
            self._process_chunk(chunk)
            self._flush_queued_control(max_items=8)

        with self._frame_lock:
            if not self._pending_frames:
                return None
            frame = self._pending_frames.popleft()
        return copy.deepcopy(frame)

    def poll_all(self) -> List[Dict[str, Any]]:
        """Return all currently available structured frames."""
        reader_alive = (
            self._reader_thread is not None and self._reader_thread.is_alive()
        )
        if not reader_alive:
            if not self._maybe_reopen_serial():
                return []
            chunk = self._read_serial_chunk_nonblocking()
            self._process_chunk(chunk)
            self._flush_queued_control(max_items=8)

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

        with self._serial_lock:
            has_serial = self._serial is not None
        if not has_serial:
            self._maybe_reopen_serial()

        payload = (
            json.dumps(
                data,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            ).encode("utf-8")
            + self._ring_buffer.frame_delimiter
        )

        with self._serial_lock:
            if self._serial is None:
                raise RuntimeError("Serial not connected")
            self._serial.write(payload)
            flush_fn = getattr(self._serial, "flush", None)
            if callable(flush_fn):
                flush_fn()
        return True

    def write_raw_line(self, line: str) -> bool:
        """Write a single text command line to serial transport."""
        normalized = str(line).replace("\r", "").replace("\n", "").strip()
        if not normalized:
            raise ValueError("raw line must not be empty")

        payload = normalized.encode("utf-8") + self._ring_buffer.frame_delimiter
        with self._serial_lock:
            if self._serial is None:
                raise RuntimeError("Serial not connected")
            self._serial.write(payload)
            flush_fn = getattr(self._serial, "flush", None)
            if callable(flush_fn):
                flush_fn()
        return True

    def _normalize_raw_control_line(self, value: Any) -> Optional[str]:
        text = str(value).replace("\r", "").replace("\n", "").strip()
        if not text:
            return None

        upper = text.upper()
        if upper in PROBE_CONTROL_COMMANDS:
            return upper

        if not RAW_CONTROL_PATTERN.fullmatch(text):
            return None

        head = upper[0]
        if head == "A":
            try:
                angle = int(float(text[1:]))
            except ValueError:
                return None
            if angle < 0 or angle > 180:
                return None
            return f"A{angle}"

        if head == "P":
            try:
                pulse = int(float(text[1:]))
            except ValueError:
                return None
            if pulse < 500 or pulse > 2500:
                return None
            return f"P{pulse}"

        try:
            angle = int(float(text))
        except ValueError:
            return None
        if angle < 0 or angle > 180:
            return None
        return str(angle)

    def _normalize_source_id(self, value: Any) -> Optional[str]:
        text = str(value).strip() if value is not None else ""
        if not text:
            return None
        if len(text) > 64:
            return text[:64]
        return text

    def _normalize_priority(self, value: Any) -> int:
        if isinstance(value, bool):
            return 0
        if isinstance(value, (int, float)):
            parsed = int(value)
            return max(-100, min(parsed, 100))
        return 0

    def _normalize_lease_ms(self, value: Any) -> int:
        if isinstance(value, bool):
            return DEFAULT_CONTROL_LEASE_MS
        if isinstance(value, (int, float)):
            parsed = int(value)
        else:
            return DEFAULT_CONTROL_LEASE_MS
        return max(MIN_CONTROL_LEASE_MS, min(parsed, MAX_CONTROL_LEASE_MS))

    def _strip_control_metadata(self, command: Dict[str, Any]) -> Dict[str, Any]:
        cleaned = dict(command)
        cleaned.pop(CONTROL_META_SOURCE_ID, None)
        cleaned.pop(CONTROL_META_PRIORITY, None)
        cleaned.pop(CONTROL_META_LEASE_MS, None)
        return cleaned

    def _expire_control_lease_locked(self, now: float) -> None:
        if self._control_lease_owner is None:
            return
        if now < self._control_lease_expires_monotonic:
            return
        self._control_lease_owner = None
        self._control_lease_priority = 0
        self._control_lease_expires_monotonic = 0.0

    def _authorize_control_source(
        self, command: Dict[str, Any]
    ) -> Tuple[bool, str, Dict[str, Any]]:
        source_id = self._normalize_source_id(command.get(CONTROL_META_SOURCE_ID))
        priority = self._normalize_priority(command.get(CONTROL_META_PRIORITY))
        lease_ms = self._normalize_lease_ms(command.get(CONTROL_META_LEASE_MS))
        now = time.monotonic()

        with self._control_lock:
            self._expire_control_lease_locked(now)
            current_owner = self._control_lease_owner
            current_priority = self._control_lease_priority
            current_expires = self._control_lease_expires_monotonic

            if source_id is None:
                if current_owner is None:
                    return (
                        True,
                        "no_source",
                        {
                            "owner": None,
                            "priority": 0,
                            "remaining_s": None,
                        },
                    )
                return (
                    False,
                    "lease_held_by_other",
                    {
                        "owner": current_owner,
                        "priority": current_priority,
                        "remaining_s": max(0.0, current_expires - now),
                    },
                )

            if current_owner is None:
                self._control_lease_owner = source_id
                self._control_lease_priority = priority
                self._control_lease_expires_monotonic = now + (lease_ms / 1000.0)
                return (
                    True,
                    "lease_acquired",
                    {
                        "owner": source_id,
                        "priority": priority,
                        "remaining_s": lease_ms / 1000.0,
                    },
                )

            if current_owner == source_id:
                # Same source refreshes lease.
                self._control_lease_priority = max(current_priority, priority)
                self._control_lease_expires_monotonic = now + (lease_ms / 1000.0)
                return (
                    True,
                    "lease_refreshed",
                    {
                        "owner": source_id,
                        "priority": self._control_lease_priority,
                        "remaining_s": lease_ms / 1000.0,
                    },
                )

            if priority > current_priority:
                # Higher priority source can preempt.
                self._control_lease_owner = source_id
                self._control_lease_priority = priority
                self._control_lease_expires_monotonic = now + (lease_ms / 1000.0)
                return (
                    True,
                    "lease_preempted",
                    {
                        "owner": source_id,
                        "priority": priority,
                        "remaining_s": lease_ms / 1000.0,
                    },
                )

            return (
                False,
                "lease_held_by_other",
                {
                    "owner": current_owner,
                    "priority": current_priority,
                    "remaining_s": max(0.0, current_expires - now),
                },
            )

    def _convert_servo_alias_to_raw_line(
        self, command: Dict[str, Any]
    ) -> Optional[str]:
        if len(command) != 1:
            return None
        if "servo_pos" in command or "servo_angle" in command:
            key = "servo_pos" if "servo_pos" in command else "servo_angle"
            return self._normalize_raw_control_line(f"A{command[key]}")
        if "servo_pulse" in command or "pulse_us" in command:
            key = "servo_pulse" if "servo_pulse" in command else "pulse_us"
            return self._normalize_raw_control_line(f"P{command[key]}")
        return None

    def _handle_control_command(
        self, command: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        runtime_cmd = command.get(ADAPTER_CMD_KEY)
        if isinstance(runtime_cmd, str) and runtime_cmd.strip():
            return self._handle_runtime_command(command)

        normalized_command = self._strip_control_metadata(command)
        lease_ok, lease_reason, lease_info = self._authorize_control_source(command)
        if not lease_ok:
            self._record_control_rejected()
            return {
                "type": "control_ack",
                "ok": False,
                "reason": lease_reason,
                "lease": lease_info,
                "status": self.get_status(),
            }

        cmd = normalized_command.get("cmd")
        if isinstance(cmd, str):
            cmd_name = cmd.strip().lower()
            if cmd_name in {"raw_line", "serial_raw", "raw"}:
                line = self._normalize_raw_control_line(normalized_command.get("line"))
                if line is None:
                    self._record_control_rejected()
                    return {
                        "type": "control_ack",
                        "ok": False,
                        "reason": "invalid_raw_line",
                        "lease": lease_info,
                        "status": self.get_status(),
                    }
                if not self._consume_control_rate_slot():
                    self._record_control_rejected()
                    return {
                        "type": "control_ack",
                        "ok": False,
                        "reason": "rate_limited",
                        "lease": lease_info,
                        "status": self.get_status(),
                    }
                dispatch = self._dispatch_control_payload("raw", line)
                if not dispatch["ok"]:
                    self._record_control_rejected()
                    return {
                        "type": "control_ack",
                        "ok": False,
                        "reason": dispatch["reason"],
                        "lease": lease_info,
                        "status": self.get_status(),
                    }
                return {
                    "type": "control_ack",
                    "ok": True,
                    "reason": str(dispatch["reason"]),
                    "line": line,
                    "lease": lease_info,
                    "queued_control_count": dispatch.get("queued_control_count"),
                    "status": self.get_status(),
                }

        servo_line = self._convert_servo_alias_to_raw_line(normalized_command)
        if servo_line is not None:
            if not self._consume_control_rate_slot():
                self._record_control_rejected()
                return {
                    "type": "control_ack",
                    "ok": False,
                    "reason": "rate_limited",
                    "lease": lease_info,
                    "status": self.get_status(),
                }
            dispatch = self._dispatch_control_payload("raw", servo_line)
            if not dispatch["ok"]:
                self._record_control_rejected()
                return {
                    "type": "control_ack",
                    "ok": False,
                    "reason": dispatch["reason"],
                    "lease": lease_info,
                    "status": self.get_status(),
                }
            return {
                "type": "control_ack",
                "ok": True,
                "reason": str(dispatch["reason"]),
                "line": servo_line,
                "lease": lease_info,
                "queued_control_count": dispatch.get("queued_control_count"),
                "status": self.get_status(),
            }

        if not self._is_control_command_allowed(normalized_command):
            self._record_control_rejected()
            return {
                "type": "control_ack",
                "ok": False,
                "reason": "not_allowlisted",
                "lease": lease_info,
                "status": self.get_status(),
            }
        if not self._consume_control_rate_slot():
            self._record_control_rejected()
            return {
                "type": "control_ack",
                "ok": False,
                "reason": "rate_limited",
                "lease": lease_info,
                "status": self.get_status(),
            }
        dispatch = self._dispatch_control_payload("json", normalized_command)
        if not dispatch["ok"]:
            self._record_control_rejected()
            return {
                "type": "control_ack",
                "ok": False,
                "reason": dispatch["reason"],
                "lease": lease_info,
                "status": self.get_status(),
            }
        return {
            "type": "control_ack",
            "ok": True,
            "reason": str(dispatch["reason"]),
            "lease": lease_info,
            "queued_control_count": dispatch.get("queued_control_count"),
            "status": self.get_status(),
        }

    def _dispatch_control_payload(self, mode: str, payload: Any) -> Dict[str, Any]:
        if mode not in {"raw", "json"}:
            raise ValueError(f"unsupported control mode: {mode}")

        with self._serial_lock:
            has_serial = self._serial is not None
        if not has_serial and not self._maybe_reopen_serial():
            return self._queue_control_payload(mode, payload)

        try:
            if mode == "raw":
                self.write_raw_line(str(payload))
                reason = "sent_raw"
            else:
                self.write(payload)
                reason = "sent"
            self._record_control_accepted()
            return {"ok": True, "reason": reason}
        except Exception as exc:
            self._handle_serial_lost(exc)
            queued = self._queue_control_payload(mode, payload)
            if queued["ok"]:
                return queued
            return {"ok": False, "reason": "serial_unavailable"}

    def _queue_control_payload(self, mode: str, payload: Any) -> Dict[str, Any]:
        queued_payload: Any
        if mode == "raw":
            queued_payload = str(payload)
        else:
            if not isinstance(payload, dict):
                return {"ok": False, "reason": "invalid_payload"}
            queued_payload = copy.deepcopy(payload)

        with self._queue_lock:
            if len(self._queued_control) >= self._max_queued_control:
                with self._status_lock:
                    self._queued_control_dropped += 1
                return {"ok": False, "reason": "queue_full"}
            self._queued_control.append((mode, queued_payload))
            queue_size = len(self._queued_control)
        with self._status_lock:
            self._control_commands_queued += 1
        return {
            "ok": True,
            "reason": "queued",
            "queued_control_count": queue_size,
        }

    def _flush_queued_control(self, max_items: int = 8) -> int:
        if max_items <= 0:
            return 0
        sent = 0
        while sent < max_items:
            with self._queue_lock:
                if not self._queued_control:
                    break
                mode, payload = self._queued_control[0]
            try:
                if mode == "raw":
                    self.write_raw_line(str(payload))
                else:
                    self.write(payload)
            except Exception as exc:
                self._handle_serial_lost(exc)
                break
            with self._queue_lock:
                if self._queued_control:
                    self._queued_control.popleft()
            self._record_control_accepted()
            sent += 1
        return sent

    def _handle_runtime_command(self, command: Dict[str, Any]) -> Dict[str, Any]:
        action = str(command.get(ADAPTER_CMD_KEY, "")).strip().lower()

        if action == ADAPTER_CMD_PAUSE:
            hold_s_raw = command.get("hold_s")
            hold_s: Optional[float]
            if isinstance(hold_s_raw, (int, float)):
                hold_s = float(hold_s_raw)
            else:
                hold_s = None
            self.pause_serial(hold_s=hold_s)
            return {
                "type": "adapter_runtime_ack",
                "ok": True,
                "action": ADAPTER_CMD_PAUSE,
                "hold_s": hold_s if hold_s is not None and hold_s > 0 else None,
                "status": self.get_status(),
            }

        if action == ADAPTER_CMD_RESUME:
            self.resume_serial()
            # Kick an immediate reopen attempt if possible.
            self._maybe_reopen_serial()
            return {
                "type": "adapter_runtime_ack",
                "ok": True,
                "action": ADAPTER_CMD_RESUME,
                "status": self.get_status(),
            }

        if action == ADAPTER_CMD_STATUS:
            return {
                "type": "adapter_runtime_ack",
                "ok": True,
                "action": ADAPTER_CMD_STATUS,
                "status": self.get_status(),
            }

        if action == ADAPTER_CMD_CAPABILITIES:
            return {
                "type": "adapter_runtime_ack",
                "ok": True,
                "action": ADAPTER_CMD_CAPABILITIES,
                "capabilities": self.get_capabilities(),
                "status": self.get_status(),
            }

        return {
            "type": "adapter_runtime_ack",
            "ok": False,
            "error": f"unknown {ADAPTER_CMD_KEY}: {action}",
            "status": self.get_status(),
        }

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
            while (
                self._control_timestamps and self._control_timestamps[0] < window_start
            ):
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
            self._last_rx_monotonic = now
            self._auto_probe_fail_streak = 0
            self._auto_probe_backoff_s = float(AUTO_PROBE_IDLE_INTERVAL_S)

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

    def _handle_telemetry_request(
        self, payload: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
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
            control_commands_queued = int(self._control_commands_queued)
            queued_control_dropped = int(self._queued_control_dropped)
            last_rx_monotonic = float(self._last_rx_monotonic)
            last_probe_monotonic = float(self._last_probe_monotonic)
            last_probe_line = self._last_probe_line
            last_probe_reason = self._last_probe_reason
            probe_sent_count = int(self._probe_sent_count)
            auto_probe_backoff_s = float(self._auto_probe_backoff_s)
            auto_probe_fail_streak = int(self._auto_probe_fail_streak)
        with self._control_lock:
            self._expire_control_lease_locked(now)
            lease_owner = self._control_lease_owner
            lease_priority = int(self._control_lease_priority)
            lease_expires = float(self._control_lease_expires_monotonic)
        with self._queue_lock:
            queued_control_count = int(len(self._queued_control))

        with self._serial_lock:
            serial_connected = self._serial is not None

        with self._state_lock:
            serial_paused = bool(self._serial_paused)
            reconnect_attempts = int(self._serial_reconnect_attempts)
            serial_last_error = self._serial_last_error
            pause_until = self._pause_until_monotonic
        pause_remaining_s: Optional[float]
        if serial_paused and pause_until is not None:
            pause_remaining_s = max(0.0, pause_until - now)
        else:
            pause_remaining_s = None

        lease_remaining_s: Optional[float]
        if lease_owner is not None:
            lease_remaining_s = max(0.0, lease_expires - now)
        else:
            lease_remaining_s = None
        telemetry_last_rx_s_ago: Optional[float]
        if last_rx_monotonic > 0.0:
            telemetry_last_rx_s_ago = max(0.0, now - last_rx_monotonic)
        else:
            telemetry_last_rx_s_ago = None
        probe_last_sent_s_ago: Optional[float]
        if last_probe_monotonic > 0.0:
            probe_last_sent_s_ago = max(0.0, now - last_probe_monotonic)
        else:
            probe_last_sent_s_ago = None

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
            "control_commands_queued": control_commands_queued,
            "queued_control_count": queued_control_count,
            "queued_control_dropped": queued_control_dropped,
            "serial_connected": serial_connected,
            "serial_paused": serial_paused,
            "serial_pause_remaining_s": pause_remaining_s,
            "serial_reconnect_attempts": reconnect_attempts,
            "serial_last_error": serial_last_error,
            "serial_port": self._port,
            "serial_baudrate": int(self._baudrate),
            "telemetry_last_rx_s_ago": telemetry_last_rx_s_ago,
            "auto_probe": {
                "enabled": True,
                "sequence": list(AUTO_PROBE_SEQUENCE),
                "sent_count": probe_sent_count,
                "last_line": last_probe_line,
                "last_reason": last_probe_reason,
                "last_sent_s_ago": probe_last_sent_s_ago,
                "backoff_s": auto_probe_backoff_s,
                "fail_streak": auto_probe_fail_streak,
            },
            "control_lease": {
                "owner": lease_owner,
                "priority": lease_priority,
                "remaining_s": lease_remaining_s,
                "active": lease_owner is not None,
            },
            "degraded": (not serial_connected) or serial_paused,
        }

    def get_capabilities(self) -> Dict[str, Any]:
        telemetry_endpoint = self.get_tcp_endpoint()
        control_endpoint = self.get_control_endpoint()
        return {
            "runtime_protocol_version": "1.0",
            "transport": {
                "telemetry": "tcp_jsonl",
                "control": "tcp_jsonl",
                "telemetry_endpoint": (
                    {
                        "host": telemetry_endpoint[0],
                        "port": int(telemetry_endpoint[1]),
                    }
                    if telemetry_endpoint
                    else None
                ),
                "control_endpoint": (
                    {
                        "host": control_endpoint[0],
                        "port": int(control_endpoint[1]),
                    }
                    if control_endpoint
                    else None
                ),
            },
            "telemetry": {
                "raw_forward_enabled": True,
                "known_numeric_fields": [
                    "ax",
                    "ay",
                    "az",
                    "gx",
                    "gy",
                    "gz",
                    "servo",
                    "target_velocity",
                    "motor_pwm",
                ],
                "llm_observer_mode": "summary_only_recommended",
                "auto_probe": {
                    "enabled": True,
                    "sequence": list(AUTO_PROBE_SEQUENCE),
                    "idle_interval_s": float(AUTO_PROBE_IDLE_INTERVAL_S),
                    "min_gap_s": float(AUTO_PROBE_MIN_GAP_S),
                    "max_backoff_s": float(AUTO_PROBE_MAX_BACKOFF_S),
                    "purpose": (
                        "wake telemetry streaming firmware and reduce manual retries"
                    ),
                },
            },
            "control": {
                "unsafe_passthrough": bool(self._unsafe_passthrough),
                "allowlist_enabled": not bool(self._unsafe_passthrough),
                "allowed_commands": sorted(self._allowed_commands),
                "source_arbitration": {
                    "metadata_keys": [
                        CONTROL_META_SOURCE_ID,
                        CONTROL_META_PRIORITY,
                        CONTROL_META_LEASE_MS,
                    ],
                    "default_lease_ms": int(DEFAULT_CONTROL_LEASE_MS),
                    "max_lease_ms": int(MAX_CONTROL_LEASE_MS),
                    "priority_range": [-100, 100],
                    "behavior": (
                        "Commands with source_id acquire/refresh lease;"
                        " higher priority can preempt;"
                        " anonymous commands are blocked while lease is active."
                    ),
                },
                "raw_line_protocol": {
                    "angle": "A<0..180> or <0..180>",
                    "pulse": "P<500..2500>",
                    "probe_examples": sorted(PROBE_CONTROL_COMMANDS),
                },
                "max_control_rate_per_sec": int(self._max_control_rate),
            },
            "runtime_commands": [
                ADAPTER_CMD_PAUSE,
                ADAPTER_CMD_RESUME,
                ADAPTER_CMD_STATUS,
                ADAPTER_CMD_CAPABILITIES,
            ],
            "safety": {
                "queue_on_serial_unavailable": True,
                "max_queued_control": int(self._max_queued_control),
            },
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
