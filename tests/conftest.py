from __future__ import annotations

from collections import deque
import json
import socket
import threading
import time
from typing import Any, Callable, Deque, Dict, List

import pytest

from python.plugin import RingBuffer, SerialAdapter


class FakeSerial:
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


def wait_for(
    predicate: Callable[[], bool], timeout: float = 2.0, interval: float = 0.01
) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(interval)
    return False


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def recv_json_lines(
    sock: socket.socket, expected: int, timeout: float = 2.0
) -> List[Dict[str, Any]]:
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


@pytest.fixture()
def fake_serial() -> FakeSerial:
    return FakeSerial()


@pytest.fixture()
def adapter_with_tcp(fake_serial: FakeSerial):
    telemetry_port = find_free_port()
    control_port = find_free_port()
    while control_port == telemetry_port:
        control_port = find_free_port()

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
    adapter._serial = fake_serial  # type: ignore[attr-defined]
    adapter.start()
    yield adapter
    adapter.disconnect()


@pytest.fixture()
def telemetry_client(adapter_with_tcp: SerialAdapter):
    endpoint = adapter_with_tcp.get_tcp_endpoint()
    assert endpoint is not None
    sock = socket.create_connection(endpoint, timeout=2.0)
    sock.settimeout(0.2)
    yield sock
    sock.close()


@pytest.fixture()
def control_client(adapter_with_tcp: SerialAdapter):
    endpoint = adapter_with_tcp.get_control_endpoint()
    assert endpoint is not None
    sock = socket.create_connection(endpoint, timeout=2.0)
    sock.settimeout(0.2)
    yield sock
    sock.close()
