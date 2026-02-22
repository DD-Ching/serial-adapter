from __future__ import annotations

import argparse
import json
import socket
import threading
import time
import tracemalloc
from collections import deque
from typing import Any, Deque, Dict, Optional, Tuple

try:
    from plugins.serial_adapter.plugin import DEFAULT_BUFFER_SIZE, SerialAdapter
except ImportError:
    import os
    import sys

    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from plugins.serial_adapter.plugin import DEFAULT_BUFFER_SIZE, SerialAdapter


class _FakeSerial:
    def __init__(self) -> None:
        self._chunks: Deque[bytearray] = deque()
        self._pending_bytes = 0
        self._lock = threading.Lock()
        self.closed = False
        self.writes = 0

    @property
    def in_waiting(self) -> int:
        with self._lock:
            return self._pending_bytes

    def read(self, size: int) -> bytes:
        if size <= 0:
            return b""
        with self._lock:
            if not self._chunks:
                return b""
            remaining = size
            out = bytearray()
            while self._chunks and remaining > 0:
                head = self._chunks[0]
                take = min(len(head), remaining)
                out.extend(head[:take])
                del head[:take]
                self._pending_bytes -= take
                remaining -= take
                if not head:
                    self._chunks.popleft()
            return bytes(out)

    def write(self, data: bytes) -> int:
        self.writes += 1
        return len(data)

    def flush(self) -> None:
        return

    def close(self) -> None:
        self.closed = True

    def feed(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self._chunks.append(bytearray(data))
            self._pending_bytes += len(data)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _estimate_ring_usage(adapter: SerialAdapter) -> Dict[str, int]:
    ring = adapter._ring_buffer  # type: ignore[attr-defined]
    with ring._lock:  # type: ignore[attr-defined]
        buffer_bytes = len(ring._buffer)  # type: ignore[attr-defined]
        pending_frames_bytes = sum(len(frame) for frame in ring._pending_frames)  # type: ignore[attr-defined]
        history_frames_bytes = sum(len(frame) for frame in ring._history_frames)  # type: ignore[attr-defined]
        capacity_bytes = int(ring._buffer_size)  # type: ignore[attr-defined]
    return {
        "buffer_bytes": int(buffer_bytes),
        "pending_frames_bytes": int(pending_frames_bytes),
        "history_frames_bytes": int(history_frames_bytes),
        "capacity_bytes": int(capacity_bytes),
    }


def _compute_memory_stability(memory_samples: list[int], buffer_size: int) -> Tuple[bool, Dict[str, int]]:
    if not memory_samples:
        return True, {"baseline": 0, "tail": 0, "growth": 0, "allowed_growth": int(buffer_size)}

    window = max(1, int(len(memory_samples) * 0.2))
    baseline = int(sum(memory_samples[:window]) / window)
    tail = int(sum(memory_samples[-window:]) / window)
    growth = tail - baseline
    allowed_growth = max(int(buffer_size), int(baseline * 0.35) + 128 * 1024)
    return growth <= allowed_growth, {
        "baseline": baseline,
        "tail": tail,
        "growth": int(growth),
        "allowed_growth": int(allowed_growth),
    }


def run_stability_test(
    *,
    duration_s: float = 600.0,
    telemetry_rate_hz: float = 100.0,
    control_rate_hz: float = 10.0,
    buffer_size: int = DEFAULT_BUFFER_SIZE,
    tcp_host: str = "127.0.0.1",
    telemetry_port: Optional[int] = None,
    control_port: Optional[int] = None,
    allow_short_run: bool = False,
) -> Dict[str, Any]:
    if duration_s <= 0:
        raise ValueError("duration_s must be positive")
    if telemetry_rate_hz <= 0:
        raise ValueError("telemetry_rate_hz must be positive")
    if control_rate_hz <= 0:
        raise ValueError("control_rate_hz must be positive")
    if buffer_size <= 0:
        raise ValueError("buffer_size must be positive")
    if duration_s < 600.0 and not allow_short_run:
        raise ValueError("duration_s must be at least 600 seconds (10 minutes)")

    telemetry_port = int(telemetry_port) if telemetry_port is not None else _find_free_port()
    control_port = int(control_port) if control_port is not None else _find_free_port()
    while control_port == telemetry_port:
        control_port = _find_free_port()

    adapter = SerialAdapter(
        "mock",
        9600,
        buffer_size=int(buffer_size),
        frame_delimiter=b"\n",
        max_frames=128,
        tcp_host=tcp_host,
        telemetry_port=telemetry_port,
        control_port=control_port,
        enable_tcp=True,
    )
    fake = _FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    adapter.start()

    telemetry_endpoint = adapter.get_tcp_endpoint()
    control_endpoint = adapter.get_control_endpoint()
    if telemetry_endpoint is None or control_endpoint is None:
        adapter.disconnect()
        raise RuntimeError("telemetry/control endpoints are not available")

    if telemetry_endpoint[1] == control_endpoint[1]:
        adapter.disconnect()
        raise RuntimeError("telemetry and control ports must be separated")

    lock = threading.Lock()
    stop_event = threading.Event()
    telemetry_connected = threading.Event()
    control_connected = threading.Event()
    feeder_done = threading.Event()

    sent_frames = 0
    frames_received = 0
    dropped_by_gap = 0
    last_received_seq: Optional[int] = None
    control_commands_sent = 0
    last_telemetry_activity = time.monotonic()
    last_control_activity = time.monotonic()

    telemetry_error: Optional[BaseException] = None
    control_error: Optional[BaseException] = None
    feeder_error: Optional[BaseException] = None

    def telemetry_client() -> None:
        nonlocal telemetry_error, frames_received, dropped_by_gap, last_received_seq, last_telemetry_activity
        buffer = b""
        try:
            with socket.create_connection(telemetry_endpoint, timeout=5.0) as sock:
                sock.settimeout(1.0)
                telemetry_connected.set()
                while not stop_event.is_set():
                    try:
                        chunk = sock.recv(4096)
                    except socket.timeout:
                        continue
                    if not chunk:
                        if not stop_event.is_set():
                            raise RuntimeError("telemetry connection closed unexpectedly")
                        break
                    buffer += chunk
                    while b"\n" in buffer:
                        raw_line, buffer = buffer.split(b"\n", 1)
                        if not raw_line.strip():
                            continue
                        try:
                            payload = json.loads(raw_line.decode("utf-8", errors="replace"))
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(payload, dict):
                            continue
                        seq = payload.get("seq")
                        if not isinstance(seq, int):
                            continue
                        with lock:
                            if last_received_seq is not None and seq > (last_received_seq + 1):
                                dropped_by_gap += seq - (last_received_seq + 1)
                            last_received_seq = seq
                            frames_received += 1
                            last_telemetry_activity = time.monotonic()
        except BaseException as exc:  # pragma: no cover - runtime safety path
            telemetry_error = exc
            telemetry_connected.set()

    def control_client() -> None:
        nonlocal control_error, control_commands_sent, last_control_activity
        interval = 1.0 / control_rate_hz
        next_deadline = time.perf_counter()
        sent_local = 0
        try:
            with socket.create_connection(control_endpoint, timeout=5.0) as sock:
                control_connected.set()
                while not stop_event.is_set():
                    cmd = {"target_velocity": round((sent_local % 50) / 10.0, 2)}
                    payload = (
                        json.dumps(
                            cmd,
                            separators=(",", ":"),
                            ensure_ascii=True,
                            allow_nan=False,
                        ).encode("utf-8")
                        + b"\n"
                    )
                    sock.sendall(payload)
                    sent_local += 1
                    with lock:
                        control_commands_sent += 1
                        last_control_activity = time.monotonic()

                    next_deadline += interval
                    sleep_s = next_deadline - time.perf_counter()
                    if sleep_s > 0:
                        time.sleep(sleep_s)
                    else:
                        next_deadline = time.perf_counter()
        except BaseException as exc:  # pragma: no cover - runtime safety path
            control_error = exc
            control_connected.set()

    end_time = time.perf_counter() + duration_s

    def feeder() -> None:
        nonlocal feeder_error, sent_frames
        interval = 1.0 / telemetry_rate_hz
        next_deadline = time.perf_counter()
        seq = 0
        try:
            while not stop_event.is_set():
                now = time.perf_counter()
                if now >= end_time:
                    break
                payload = {"seq": seq, "value": seq % 1000, "ts": now}
                encoded = (
                    json.dumps(
                        payload,
                        separators=(",", ":"),
                        ensure_ascii=True,
                        allow_nan=False,
                    ).encode("utf-8")
                    + b"\n"
                )
                fake.feed(encoded)
                with lock:
                    sent_frames += 1
                seq += 1

                next_deadline += interval
                sleep_s = next_deadline - time.perf_counter()
                if sleep_s > 0:
                    time.sleep(sleep_s)
                else:
                    next_deadline = time.perf_counter()
        except BaseException as exc:  # pragma: no cover - runtime safety path
            feeder_error = exc
        finally:
            feeder_done.set()

    telemetry_thread = threading.Thread(target=telemetry_client, name="serial-adapter-stability-telemetry", daemon=True)
    control_thread = threading.Thread(target=control_client, name="serial-adapter-stability-control", daemon=True)
    feeder_thread = threading.Thread(target=feeder, name="serial-adapter-stability-feeder", daemon=True)

    telemetry_thread.start()
    control_thread.start()

    if not telemetry_connected.wait(timeout=10.0):
        stop_event.set()
        adapter.disconnect()
        raise RuntimeError("failed to establish telemetry client connection")
    if not control_connected.wait(timeout=10.0):
        stop_event.set()
        adapter.disconnect()
        raise RuntimeError("failed to establish control client connection")

    if telemetry_error is not None:
        stop_event.set()
        adapter.disconnect()
        raise RuntimeError(f"telemetry client failed to start: {telemetry_error}") from telemetry_error
    if control_error is not None:
        stop_event.set()
        adapter.disconnect()
        raise RuntimeError(f"control client failed to start: {control_error}") from control_error

    tracemalloc.start()
    memory_samples: list[int] = []
    max_ring_bytes = 0
    ring_overflow_detected = False
    reader_exited = False
    deadlock_detected = False
    final_ring = _estimate_ring_usage(adapter)

    feeder_thread.start()

    try:
        while not feeder_done.is_set():
            if telemetry_error is not None or control_error is not None or feeder_error is not None:
                break

            reader = adapter._reader_thread  # type: ignore[attr-defined]
            if reader is None or not reader.is_alive():
                reader_exited = True
                break

            ring_state = _estimate_ring_usage(adapter)
            final_ring = ring_state
            ring_bytes = int(ring_state["buffer_bytes"])
            if ring_bytes > max_ring_bytes:
                max_ring_bytes = ring_bytes
            if ring_bytes > int(buffer_size):
                ring_overflow_detected = True
                break

            current_bytes, _ = tracemalloc.get_traced_memory()
            memory_samples.append(int(current_bytes))

            now = time.monotonic()
            with lock:
                telemetry_stall = (now - last_telemetry_activity) > 5.0 and sent_frames > 0
                control_stall = (now - last_control_activity) > 5.0 and control_commands_sent > 0
            if telemetry_stall or control_stall:
                deadlock_detected = True
                break

            time.sleep(1.0)
    finally:
        stop_event.set()
        feeder_thread.join(timeout=5.0)
        telemetry_thread.join(timeout=5.0)
        control_thread.join(timeout=5.0)
        current_bytes, peak_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        if feeder_thread.is_alive() or telemetry_thread.is_alive() or control_thread.is_alive():
            deadlock_detected = True

    status_snapshot = adapter.get_status()
    final_ring = _estimate_ring_usage(adapter)
    adapter.disconnect()

    with lock:
        sent = int(sent_frames)
        received = int(frames_received)
        gap_drops = int(dropped_by_gap)
        last_seq = last_received_seq
        control_sent = int(control_commands_sent)

    tail_drop = 0
    if isinstance(last_seq, int) and sent > 0 and last_seq < (sent - 1):
        tail_drop = (sent - 1) - last_seq
    elif last_seq is None and sent > 0:
        tail_drop = sent

    frames_dropped = max(gap_drops + tail_drop, max(0, sent - received))

    memory_stable, memory_stability = _compute_memory_stability(memory_samples, int(buffer_size))

    no_crash = telemetry_error is None and control_error is None and feeder_error is None
    passed = no_crash and (not deadlock_detected) and (not reader_exited) and (not ring_overflow_detected) and memory_stable

    return {
        "passed": bool(passed),
        "duration_s": float(duration_s),
        "telemetry_rate_hz": float(telemetry_rate_hz),
        "control_rate_hz": float(control_rate_hz),
        "no_crash": bool(no_crash),
        "no_deadlock": bool(not deadlock_detected),
        "no_thread_exit": bool(not reader_exited),
        "ring_within_limit": bool(not ring_overflow_detected),
        "memory_stable": bool(memory_stable),
        "frames_sent": int(sent),
        "frames_received": int(received),
        "frames_dropped": int(frames_dropped),
        "control_commands_sent": int(control_sent),
        "max_ring_buffer_bytes": int(max_ring_bytes),
        "ring_buffer_capacity_bytes": int(buffer_size),
        "final_buffer_usage": {
            "buffer_bytes": int(final_ring["buffer_bytes"]),
            "pending_frames_bytes": int(final_ring["pending_frames_bytes"]),
            "history_frames_bytes": int(final_ring["history_frames_bytes"]),
            "usage_ratio": float(status_snapshot.get("ring_buffer_usage_ratio", 0.0)),
        },
        "memory": {
            "tracemalloc_current_bytes": int(current_bytes),
            "tracemalloc_peak_bytes": int(peak_bytes),
            "samples_collected": int(len(memory_samples)),
            "stability": memory_stability,
        },
        "errors": {
            "telemetry_client": None if telemetry_error is None else str(telemetry_error),
            "control_client": None if control_error is None else str(control_error),
            "feeder": None if feeder_error is None else str(feeder_error),
        },
        "endpoints": {
            "telemetry": f"{telemetry_endpoint[0]}:{telemetry_endpoint[1]}",
            "control": f"{control_endpoint[0]}:{control_endpoint[1]}",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Long-duration stability test for serial_adapter")
    parser.add_argument("--duration-s", type=float, default=600.0, help="Test duration in seconds (default: 600)")
    parser.add_argument("--rate-hz", type=float, default=100.0, help="Telemetry stream rate in Hz (default: 100)")
    parser.add_argument("--control-rate-hz", type=float, default=10.0, help="Control command rate in Hz (default: 10)")
    parser.add_argument(
        "--buffer-size",
        type=int,
        default=DEFAULT_BUFFER_SIZE,
        help="Ring buffer size in bytes (default: 512*1024)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="TCP host bind address (default: 127.0.0.1)")
    parser.add_argument("--telemetry-port", type=int, default=0, help="Telemetry TCP port (default: auto/free)")
    parser.add_argument("--control-port", type=int, default=0, help="Control TCP port (default: auto/free)")
    parser.add_argument(
        "--allow-short-run",
        action="store_true",
        help="Allow duration shorter than 10 minutes (for quick smoke tests)",
    )
    args = parser.parse_args()

    telemetry_port = None if int(args.telemetry_port) <= 0 else int(args.telemetry_port)
    control_port = None if int(args.control_port) <= 0 else int(args.control_port)

    result = run_stability_test(
        duration_s=float(args.duration_s),
        telemetry_rate_hz=float(args.rate_hz),
        control_rate_hz=float(args.control_rate_hz),
        buffer_size=int(args.buffer_size),
        tcp_host=str(args.host),
        telemetry_port=telemetry_port,
        control_port=control_port,
        allow_short_run=bool(args.allow_short_run),
    )

    print("SERIAL ADAPTER STABILITY TEST RESULT")
    print(json.dumps(result, indent=2, sort_keys=True))

    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
