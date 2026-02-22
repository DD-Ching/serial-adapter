from __future__ import annotations

import argparse
import json
import threading
import time
import tracemalloc
from collections import deque
from typing import Any, Deque, Dict, Optional

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


def _estimate_ring_memory(adapter: SerialAdapter) -> Dict[str, int]:
    ring = adapter._ring_buffer  # type: ignore[attr-defined]
    with ring._lock:  # type: ignore[attr-defined]
        buffer_bytes = len(ring._buffer)  # type: ignore[attr-defined]
        pending_frames_bytes = sum(len(frame) for frame in ring._pending_frames)  # type: ignore[attr-defined]
        history_frames_bytes = sum(len(frame) for frame in ring._history_frames)  # type: ignore[attr-defined]
    return {
        "buffer_bytes": int(buffer_bytes),
        "pending_frames_bytes": int(pending_frames_bytes),
        "history_frames_bytes": int(history_frames_bytes),
    }


def run_stress_test(
    *,
    duration_s: float = 300.0,
    rate_hz: float = 100.0,
    buffer_size: int = DEFAULT_BUFFER_SIZE,
) -> Dict[str, Any]:
    if duration_s <= 0:
        raise ValueError("duration_s must be positive")
    if rate_hz <= 0:
        raise ValueError("rate_hz must be positive")
    if buffer_size <= 0:
        raise ValueError("buffer_size must be positive")

    adapter = SerialAdapter(
        "mock",
        9600,
        buffer_size=int(buffer_size),
        frame_delimiter=b"\n",
        max_frames=64,
        enable_tcp=False,
    )
    fake = _FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    stats_lock = threading.Lock()
    sent_frames = 0
    processed_frames = 0
    dropped_by_gap = 0
    first_seq: Optional[int] = None
    last_seq: Optional[int] = None
    feeder_error: Optional[BaseException] = None

    def on_frame(frame: Dict[str, Any]) -> None:
        nonlocal processed_frames, dropped_by_gap, first_seq, last_seq
        parsed = frame.get("parsed")
        if not isinstance(parsed, dict):
            return
        seq = parsed.get("seq")
        if not isinstance(seq, int):
            return

        with stats_lock:
            if first_seq is None:
                first_seq = seq
            if last_seq is not None and seq > (last_seq + 1):
                dropped_by_gap += seq - (last_seq + 1)
            last_seq = seq
            processed_frames += 1

    adapter.register_callback(on_frame)

    stop_feeder = threading.Event()

    def feeder() -> None:
        nonlocal sent_frames, feeder_error
        seq = 0
        interval = 1.0 / rate_hz
        next_deadline = time.perf_counter()
        try:
            while not stop_feeder.is_set():
                now = time.perf_counter()
                if now >= end_time:
                    break
                payload = {"seq": seq, "value": seq % 1000, "t": now}
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
                with stats_lock:
                    sent_frames += 1
                seq += 1

                next_deadline += interval
                sleep_s = next_deadline - time.perf_counter()
                if sleep_s > 0:
                    time.sleep(sleep_s)
                else:
                    # Catch up without accumulating drift if scheduler is late.
                    next_deadline = time.perf_counter()
        except BaseException as exc:  # pragma: no cover - defensive runtime capture
            feeder_error = exc

    tracemalloc.start()
    max_ring_bytes = 0
    reader_exited = False
    deadlock_detected = False
    ring_overflow_detected = False
    final_ring = {"buffer_bytes": 0, "pending_frames_bytes": 0, "history_frames_bytes": 0}

    adapter.start()
    start_time = time.perf_counter()
    end_time = start_time + duration_s
    feeder_thread = threading.Thread(target=feeder, name="serial-adapter-stress-feeder", daemon=True)
    feeder_thread.start()

    try:
        while feeder_thread.is_alive():
            reader = adapter._reader_thread  # type: ignore[attr-defined]
            if reader is None or not reader.is_alive():
                reader_exited = True
                break

            ring_memory = _estimate_ring_memory(adapter)
            ring_bytes = ring_memory["buffer_bytes"]
            final_ring = ring_memory
            if ring_bytes > max_ring_bytes:
                max_ring_bytes = ring_bytes
            if ring_bytes > buffer_size:
                ring_overflow_detected = True
                break
            time.sleep(0.05)

        stop_feeder.set()
        feeder_thread.join(timeout=5.0)
        if feeder_thread.is_alive():
            deadlock_detected = True

        # Allow the reader thread to drain pending serial chunks.
        drain_deadline = time.perf_counter() + 2.0
        while time.perf_counter() < drain_deadline:
            with stats_lock:
                done = processed_frames >= sent_frames
            if done:
                break
            time.sleep(0.01)

        if not reader_exited:
            reader = adapter._reader_thread  # type: ignore[attr-defined]
            if reader is None or not reader.is_alive():
                reader_exited = True

        current_bytes, peak_bytes = tracemalloc.get_traced_memory()
    finally:
        adapter.disconnect()
        tracemalloc.stop()

    with stats_lock:
        sent = int(sent_frames)
        processed = int(processed_frames)
        dropped_gap = int(dropped_by_gap)
        first = first_seq
        last = last_seq

    head_missing = first if isinstance(first, int) and first > 0 else 0
    tail_missing = 0
    if isinstance(last, int) and sent > 0 and last < (sent - 1):
        tail_missing = (sent - 1) - last
    elif last is None and sent > 0:
        tail_missing = sent

    dropped = max(dropped_gap + head_missing + tail_missing, max(0, sent - processed))

    passed = not (
        reader_exited
        or deadlock_detected
        or ring_overflow_detected
        or feeder_error is not None
    )

    return {
        "passed": passed,
        "duration_s": float(duration_s),
        "rate_hz": float(rate_hz),
        "frames_sent": sent,
        "frames_processed": processed,
        "frames_dropped": int(dropped),
        "no_crash": feeder_error is None,
        "no_deadlock": not deadlock_detected,
        "no_thread_exit": not reader_exited,
        "ring_within_limit": not ring_overflow_detected,
        "max_ring_buffer_bytes": int(max_ring_bytes),
        "ring_buffer_capacity_bytes": int(buffer_size),
        "final_memory_estimate": {
            "ring_buffer_bytes": int(final_ring["buffer_bytes"]),
            "ring_pending_frames_bytes": int(final_ring["pending_frames_bytes"]),
            "ring_history_frames_bytes": int(final_ring["history_frames_bytes"]),
            "tracemalloc_current_bytes": int(current_bytes),
            "tracemalloc_peak_bytes": int(peak_bytes),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Stress test for serial_adapter plugin")
    parser.add_argument("--duration-s", type=float, default=300.0, help="Test duration in seconds (default: 300)")
    parser.add_argument("--rate-hz", type=float, default=100.0, help="Telemetry rate in Hz (default: 100)")
    parser.add_argument(
        "--buffer-size",
        type=int,
        default=DEFAULT_BUFFER_SIZE,
        help="Ring buffer size in bytes (default: 512*1024)",
    )
    args = parser.parse_args()

    result = run_stress_test(
        duration_s=float(args.duration_s),
        rate_hz=float(args.rate_hz),
        buffer_size=int(args.buffer_size),
    )

    print("SERIAL ADAPTER STRESS TEST RESULT")
    print(json.dumps(result, indent=2, sort_keys=True))

    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
