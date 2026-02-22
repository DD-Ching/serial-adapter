from __future__ import annotations

from collections import deque
import json
import socket
import threading
import time
from typing import Any, Callable, Deque, Dict, List, Optional

try:
    from plugins.serial_adapter.plugin import RingBuffer, SerialAdapter
except ImportError:
    import os
    import sys

    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from plugins.serial_adapter.plugin import RingBuffer, SerialAdapter


class _FakeSerial:
    def __init__(self) -> None:
        self._chunks: Deque[bytearray] = deque()
        self._lock = threading.Lock()
        self.writes: List[bytes] = []
        self.closed = False

    @property
    def in_waiting(self) -> int:
        with self._lock:
            if not self._chunks:
                return 0
            return len(self._chunks[0])

    def read(self, size: int) -> bytes:
        if size <= 0:
            return b""
        with self._lock:
            if not self._chunks:
                return b""
            head = self._chunks[0]
            chunk = bytes(head[:size])
            del head[:size]
            if not head:
                self._chunks.popleft()
            return chunk

    def readline(self) -> bytes:
        with self._lock:
            if not self._chunks:
                return b""
            return bytes(self._chunks.popleft())

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        return len(data)

    def flush(self) -> None:
        return

    def close(self) -> None:
        self.closed = True

    def feed(self, data: bytes) -> None:
        with self._lock:
            self._chunks.append(bytearray(data))


def _wait_for(predicate: Callable[[], bool], timeout: float = 2.0, interval: float = 0.01) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _recv_json_lines(sock: socket.socket, expected: int, timeout: float = 2.0) -> List[Dict[str, Any]]:
    deadline = time.time() + timeout
    buffer = b""
    lines: List[Dict[str, Any]] = []
    while time.time() < deadline and len(lines) < expected:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            raw_line, buffer = buffer.split(b"\n", 1)
            if not raw_line.strip():
                continue
            try:
                parsed = json.loads(raw_line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                lines.append(parsed)
    return lines


def _is_status_payload(payload: Dict[str, Any]) -> bool:
    required = {
        "rx_rate",
        "tx_rate",
        "connected_clients",
        "ring_buffer_usage_ratio",
        "control_commands_accepted",
        "control_commands_rejected",
    }
    return required.issubset(payload.keys())


def run_self_test() -> None:
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b"{\"value\":1")
    if ring.peek_frame() is not None:
        raise RuntimeError("RingBuffer should keep fragmented frame until delimiter")
    ring.append(b"}|{\"value\":2}|{\"value\":3}|{\"value\":4}|")
    if ring.read_frame() != b"{\"value\":2}":
        raise RuntimeError("RingBuffer max_frames trimming failed")
    if ring.peek_frame() != b"{\"value\":3}":
        raise RuntimeError("RingBuffer peek_frame() mismatch")
    last_two = ring.get_last_n(2)
    if last_two != [b"{\"value\":3}", b"{\"value\":4}"]:
        raise RuntimeError("RingBuffer get_last_n() mismatch")
    ring.clear()
    if ring.read_frame() is not None:
        raise RuntimeError("RingBuffer clear() failed")

    telemetry_port = _find_free_port()
    control_port = _find_free_port()
    while control_port == telemetry_port:
        control_port = _find_free_port()

    adapter = SerialAdapter(
        "mock",
        9600,
        buffer_size=1024,
        frame_delimiter="|",
        max_frames=20,
        tcp_host="127.0.0.1",
        telemetry_port=telemetry_port,
        control_port=control_port,
        enable_tcp=True,
    )
    fake = _FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    callback_frames: List[Dict[str, Any]] = []
    adapter.register_callback(lambda frame: callback_frames.append(frame))
    adapter.start()

    telemetry_endpoint = adapter.get_tcp_endpoint()
    control_endpoint = adapter.get_control_endpoint()
    if telemetry_endpoint is None or telemetry_endpoint[1] <= 0:
        raise RuntimeError("Telemetry endpoint is not available")
    if control_endpoint is None or control_endpoint[1] <= 0:
        raise RuntimeError("Control endpoint is not available")
    if telemetry_endpoint[1] != telemetry_port:
        raise RuntimeError("Telemetry endpoint should bind to configured telemetry_port")
    if control_endpoint[1] != control_port:
        raise RuntimeError("Control endpoint should bind to configured control_port")
    if telemetry_endpoint[1] == control_endpoint[1]:
        raise RuntimeError("Telemetry and control ports must be separated")

    telemetry_client = socket.create_connection(telemetry_endpoint, timeout=2.0)
    telemetry_client.settimeout(0.2)
    control_client = socket.create_connection(control_endpoint, timeout=2.0)
    control_client.settimeout(0.2)

    try:
        fake.feed(b"{\"value\":10")
        time.sleep(0.05)
        if adapter.poll() is not None:
            raise RuntimeError("poll() should return None for fragmented payload")

        fake.feed(b"}|{\"value\":20}|")
        if not _wait_for(lambda: len(adapter.get_last_n_frames(2)) >= 2):
            raise RuntimeError("Did not receive expected telemetry frames")

        frames = adapter.poll_all()
        if len(frames) < 2:
            raise RuntimeError("poll_all() should return all available frames")

        first = frames[0]
        second = frames[1]
        if first.get("raw") != "{\"value\":10}" or second.get("raw") != "{\"value\":20}":
            raise RuntimeError("poll_all() frame ordering mismatch")
        if first.get("parsed", {}).get("value") != 10 or second.get("parsed", {}).get("value") != 20:
            raise RuntimeError("poll_all() parsed payload mismatch")
        if first.get("value") != 10 or second.get("value") != 20:
            raise RuntimeError("Backward-compatible top-level parsed keys missing")

        meta = first.get("meta")
        if not isinstance(meta, dict) or meta.get("source") != "serial":
            raise RuntimeError("Frame meta source mismatch")
        if meta.get("size") != len(b"{\"value\":10}"):
            raise RuntimeError("Frame meta size mismatch")

        broadcast_lines = _recv_json_lines(telemetry_client, expected=2, timeout=2.0)
        if len(broadcast_lines) < 2:
            raise RuntimeError("TCP broadcast did not deliver expected frames")
        if broadcast_lines[0].get("parsed", {}).get("value") != 10:
            raise RuntimeError("TCP broadcast frame 1 parsed mismatch")
        if broadcast_lines[1].get("parsed", {}).get("value") != 20:
            raise RuntimeError("TCP broadcast frame 2 parsed mismatch")

        # Control channel forwards commands to serial.
        control_client.sendall(b"{\"motor_pwm\":120}\n")
        if not _wait_for(lambda: any(b"\"motor_pwm\":120" in item for item in fake.writes), timeout=2.0):
            raise RuntimeError("TCP control input was not written to serial transport")

        # Non-whitelisted command is rejected by default safety policy.
        writes_before = len(fake.writes)
        control_client.sendall(b"{\"shutdown\":1}\n")
        time.sleep(0.1)
        if any(b"\"shutdown\":1" in item for item in fake.writes[writes_before:]):
            raise RuntimeError("Disallowed control command should be rejected")

        # Whitelisted target_velocity command is accepted.
        control_client.sendall(b"{\"target_velocity\":3.5}\n")
        if not _wait_for(
            lambda: any(b"\"target_velocity\":3.5" in item for item in fake.writes),
            timeout=2.0,
        ):
            raise RuntimeError("Whitelisted control command was not forwarded")

        status_snapshot = adapter.get_status()
        if not _is_status_payload(status_snapshot):
            raise RuntimeError("get_status() missing required fields")
        if not isinstance(status_snapshot.get("rx_rate"), (int, float)):
            raise RuntimeError("get_status() rx_rate type mismatch")
        if not isinstance(status_snapshot.get("tx_rate"), (int, float)):
            raise RuntimeError("get_status() tx_rate type mismatch")
        if int(status_snapshot.get("connected_clients", 0)) < 2:
            raise RuntimeError("get_status() connected_clients mismatch")
        ratio = float(status_snapshot.get("ring_buffer_usage_ratio", -1.0))
        if ratio < 0.0 or ratio > 1.0:
            raise RuntimeError("get_status() ring_buffer_usage_ratio out of range")
        if int(status_snapshot.get("control_commands_accepted", 0)) < 2:
            raise RuntimeError("get_status() accepted counter mismatch")
        if int(status_snapshot.get("control_commands_rejected", 0)) < 1:
            raise RuntimeError("get_status() rejected counter mismatch")

        # Telemetry channel is read-only and must not respond to commands.
        telemetry_client.sendall(b"{\"cmd\":\"status\"}\n")
        time.sleep(0.1)
        try:
            telemetry_response = telemetry_client.recv(4096)
        except socket.timeout:
            telemetry_response = b""
        if telemetry_response:
            raise RuntimeError("Telemetry channel should not send command responses")

        # Telemetry channel is read-only and must not forward commands.
        writes_before = len(fake.writes)
        telemetry_client.sendall(b"{\"motor_pwm\":999}\n")
        time.sleep(0.1)
        if any(b"\"motor_pwm\":999" in item for item in fake.writes[writes_before:]):
            raise RuntimeError("Telemetry channel forwarded commands unexpectedly")

        # Control channel must not receive telemetry broadcasts.
        try:
            leaked = control_client.recv(4096)
        except socket.timeout:
            leaked = b""
        if leaked:
            raise RuntimeError("Control channel received telemetry unexpectedly")

        fake.feed(b"not-json|")
        if not _wait_for(
            lambda: (
                isinstance(adapter.get_latest_frame(), dict)
                and adapter.get_latest_frame().get("raw") == "not-json"
            ),
            timeout=2.0,
        ):
            raise RuntimeError("No latest frame after invalid payload")
        invalid = adapter.poll()
        if invalid is None or invalid.get("raw") != "not-json":
            raise RuntimeError("poll() invalid frame handling failed")
        if invalid.get("parsed") is not None:
            raise RuntimeError("Invalid JSON frame should set parsed=None")

        stats = adapter.get_statistics()
        if stats.get("mean") != 15.0:
            raise RuntimeError("Statistics mean mismatch")
        if stats.get("min") != 10.0:
            raise RuntimeError("Statistics min mismatch")
        if stats.get("max") != 20.0:
            raise RuntimeError("Statistics max mismatch")
        if stats.get("delta") != 10.0:
            raise RuntimeError("Statistics delta mismatch")
        value_stats = stats.get("fields", {}).get("value")
        if not isinstance(value_stats, dict):
            raise RuntimeError("Statistics field summary missing")
        if value_stats.get("mean") != 15.0:
            raise RuntimeError("Field statistics mean mismatch")

        if len(callback_frames) < 3:
            raise RuntimeError("Observer callback was not triggered for all frames")

        fake.feed(b"{\"value\":30}|")
        if not _wait_for(lambda: any(frame.get("value") == 30 for frame in adapter.get_last_n_frames(1))):
            raise RuntimeError("Compatibility frame not received")
        compat = adapter.read()
        if compat is None or compat.get("value") != 30:
            raise RuntimeError("read() compatibility path failed")
    finally:
        try:
            telemetry_client.close()
        finally:
            try:
                control_client.close()
            finally:
                adapter.disconnect()

    # Control rate limit and unsafe passthrough behavior.
    rate_adapter = SerialAdapter(
        "mock",
        9600,
        enable_tcp=False,
        unsafe_passthrough=True,
        max_control_rate=2,
    )
    fake_rate = _FakeSerial()
    rate_adapter._serial = fake_rate  # type: ignore[attr-defined]

    rate_adapter._handle_control_command({"custom_control": 1})  # type: ignore[attr-defined]
    rate_adapter._handle_control_command({"custom_control": 2})  # type: ignore[attr-defined]
    rate_adapter._handle_control_command({"custom_control": 3})  # type: ignore[attr-defined]
    if len(fake_rate.writes) != 2:
        raise RuntimeError("Control rate limit should reject commands above threshold")

    time.sleep(1.05)
    rate_adapter._handle_control_command({"custom_control": 4})  # type: ignore[attr-defined]
    if len(fake_rate.writes) != 3:
        raise RuntimeError("Control rate limit window did not reset")

    rate_adapter.disconnect()

    # Backward compatibility: combined channel via tcp_port still works.
    compat_port = _find_free_port()
    adapter_combined = SerialAdapter(
        "mock",
        9600,
        frame_delimiter="|",
        tcp_port=compat_port,
        enable_tcp=True,
    )
    fake_combined = _FakeSerial()
    adapter_combined._serial = fake_combined  # type: ignore[attr-defined]
    adapter_combined.start()

    combined_telemetry = adapter_combined.get_tcp_endpoint()
    combined_control = adapter_combined.get_control_endpoint()
    if combined_telemetry is None or combined_control is None:
        raise RuntimeError("Combined compatibility endpoint missing")
    if combined_telemetry[1] != combined_control[1]:
        raise RuntimeError("Combined compatibility mode should share one TCP port")

    combined_client = socket.create_connection(combined_telemetry, timeout=2.0)
    combined_client.settimeout(0.2)
    try:
        fake_combined.feed(b"{\"value\":77}|")
        if not _wait_for(lambda: len(adapter_combined.get_last_n_frames(1)) >= 1):
            raise RuntimeError("Combined mode did not ingest telemetry")
        combined_lines = _recv_json_lines(combined_client, expected=1, timeout=2.0)
        if not combined_lines or combined_lines[0].get("parsed", {}).get("value") != 77:
            raise RuntimeError("Combined mode telemetry broadcast mismatch")

        combined_client.sendall(b"{\"motor_pwm\":55}\n")
        if not _wait_for(
            lambda: any(b"\"motor_pwm\":55" in item for item in fake_combined.writes),
            timeout=2.0,
        ):
            raise RuntimeError("Combined mode control forwarding mismatch")
    finally:
        try:
            combined_client.close()
        finally:
            adapter_combined.disconnect()

    if not fake.closed:
        raise RuntimeError("disconnect() did not close serial transport")

    print("SERIAL ADAPTER TEST PASSED")


def main() -> None:
    run_self_test()


if __name__ == "__main__":
    main()
