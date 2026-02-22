from __future__ import annotations

from collections import deque
import json
import select
import socket
import threading
from typing import Any, Callable, Deque, Dict, Optional


def _normalize_delimiter(frame_delimiter: bytes | str) -> bytes:
    if isinstance(frame_delimiter, str):
        delimiter = frame_delimiter.encode("utf-8")
    elif isinstance(frame_delimiter, bytes):
        delimiter = frame_delimiter
    else:
        raise TypeError("frame_delimiter must be bytes or str")

    if not delimiter:
        raise ValueError("frame_delimiter must not be empty")
    return delimiter


class _TcpJsonServerCore:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        frame_delimiter: bytes | str,
        broadcast_enabled: bool,
        command_enabled: bool,
        command_handler: Optional[Callable[[Dict[str, Any]], None]] = None,
        request_handler: Optional[Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
    ) -> None:
        self._host = host
        self._port = int(port)
        self._frame_delimiter = _normalize_delimiter(frame_delimiter)
        self._broadcast_enabled = bool(broadcast_enabled)
        self._command_enabled = bool(command_enabled)
        self._command_handler = command_handler
        self._request_handler = request_handler

        self._server_socket: Optional[socket.socket] = None
        self._clients: Dict[socket.socket, bytearray] = {}
        self._outgoing: Dict[socket.socket, Deque[bytes]] = {}
        self._broadcast_queue: Deque[bytes] = deque()

        self._running = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._state_lock = threading.Lock()
        self._clients_lock = threading.Lock()
        self._queue_lock = threading.Lock()
        self._bound_port = self._port

    @property
    def bound_host(self) -> str:
        return self._host

    @property
    def bound_port(self) -> int:
        return self._bound_port

    def is_running(self) -> bool:
        return self._running.is_set()

    def get_client_count(self) -> int:
        with self._clients_lock:
            return len(self._clients)

    def start(self) -> None:
        with self._state_lock:
            if self._running.is_set():
                return

            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((self._host, self._port))
            server.listen()
            server.setblocking(False)
            self._server_socket = server
            self._bound_port = int(server.getsockname()[1])
            self._running.set()

            self._thread = threading.Thread(
                target=self._run_loop,
                name="serial-adapter-tcp",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        thread: Optional[threading.Thread]
        with self._state_lock:
            if not self._running.is_set():
                return
            self._running.clear()
            thread = self._thread
            self._thread = None

        if thread is not None:
            thread.join(timeout=2.0)

        with self._clients_lock:
            sockets = list(self._clients.keys())
            for client in sockets:
                self._close_client(client)

        if self._server_socket is not None:
            try:
                self._server_socket.close()
            except OSError:
                pass
            self._server_socket = None

        with self._queue_lock:
            self._broadcast_queue.clear()

    def enqueue_frame(self, frame: Dict[str, Any]) -> None:
        if not self._broadcast_enabled:
            return

        payload = json.dumps(
            frame,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8") + self._frame_delimiter

        with self._queue_lock:
            self._broadcast_queue.append(payload)

    def _run_loop(self) -> None:
        while self._running.is_set():
            if self._broadcast_enabled:
                self._distribute_pending_broadcasts()
            self._poll_once(timeout=0.05)

    def _poll_once(self, timeout: float) -> None:
        server = self._server_socket
        if server is None:
            return

        with self._clients_lock:
            clients = list(self._clients.keys())
            readable = [server] + clients
            writable = [client for client in clients if self._outgoing.get(client)]
            exceptional = list(clients)

        try:
            read_ready, write_ready, err_ready = select.select(
                readable,
                writable,
                exceptional,
                timeout,
            )
        except OSError:
            return

        for sock in read_ready:
            if sock is server:
                self._accept_clients()
            else:
                self._read_client(sock)

        for sock in write_ready:
            self._flush_client(sock)

        for sock in err_ready:
            with self._clients_lock:
                self._close_client(sock)

    def _accept_clients(self) -> None:
        server = self._server_socket
        if server is None:
            return

        while True:
            try:
                client, _ = server.accept()
            except BlockingIOError:
                break
            except OSError:
                break

            client.setblocking(False)
            with self._clients_lock:
                self._clients[client] = bytearray()
                self._outgoing[client] = deque()

    def _read_client(self, client: socket.socket) -> None:
        try:
            data = client.recv(4096)
        except BlockingIOError:
            return
        except OSError:
            with self._clients_lock:
                self._close_client(client)
            return

        if not data:
            with self._clients_lock:
                self._close_client(client)
            return

        if not self._command_enabled and self._request_handler is None:
            # No readable protocol on this channel.
            return

        with self._clients_lock:
            buf = self._clients.get(client)
            if buf is None:
                return
            buf.extend(data)
            lines = self._extract_lines(buf)

        for line in lines:
            self._handle_client_line(client, line)

    def _extract_lines(self, buffer: bytearray) -> list[bytes]:
        lines: list[bytes] = []
        delimiter = self._frame_delimiter
        delimiter_len = len(delimiter)
        while True:
            idx = buffer.find(delimiter)
            if idx < 0:
                break
            line = bytes(buffer[:idx])
            del buffer[: idx + delimiter_len]
            lines.append(line)
        return lines

    def _handle_client_line(self, client: socket.socket, line: bytes) -> None:
        if not line.strip():
            return

        try:
            payload = json.loads(line.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return

        if not isinstance(payload, dict):
            return

        if self._request_handler is not None:
            try:
                response = self._request_handler(payload)
            except Exception:
                response = None
            if isinstance(response, dict):
                self._enqueue_client_payload(client, response)
                return

        if not self._command_enabled or self._command_handler is None:
            return

        try:
            self._command_handler(payload)
        except Exception:
            # Control input path is best-effort.
            return

    def _enqueue_client_payload(self, client: socket.socket, payload: Dict[str, Any]) -> None:
        data = json.dumps(
            payload,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8") + self._frame_delimiter
        with self._clients_lock:
            queue = self._outgoing.get(client)
            if queue is None:
                return
            queue.append(data)

    def _flush_client(self, client: socket.socket) -> None:
        while True:
            with self._clients_lock:
                queue = self._outgoing.get(client)
                if not queue:
                    return
                payload = queue[0]

            try:
                sent = client.send(payload)
            except BlockingIOError:
                return
            except OSError:
                with self._clients_lock:
                    self._close_client(client)
                return

            if sent <= 0:
                with self._clients_lock:
                    self._close_client(client)
                return

            with self._clients_lock:
                queue = self._outgoing.get(client)
                if queue is None or not queue:
                    return
                if sent < len(queue[0]):
                    queue[0] = queue[0][sent:]
                    return
                queue.popleft()
                if not queue:
                    return

    def _distribute_pending_broadcasts(self) -> None:
        if not self._broadcast_enabled:
            return

        with self._queue_lock:
            if not self._broadcast_queue:
                return
            messages = list(self._broadcast_queue)
            self._broadcast_queue.clear()

        with self._clients_lock:
            for client in list(self._clients.keys()):
                queue = self._outgoing.get(client)
                if queue is None:
                    continue
                queue.extend(messages)

    def _close_client(self, client: socket.socket) -> None:
        self._clients.pop(client, None)
        self._outgoing.pop(client, None)
        try:
            client.close()
        except OSError:
            pass


class TcpTelemetryServer(_TcpJsonServerCore):
    """Read-only telemetry broadcast server."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 9000,
        *,
        frame_delimiter: bytes | str = b"\n",
        request_handler: Optional[Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
    ) -> None:
        super().__init__(
            host=host,
            port=port,
            frame_delimiter=frame_delimiter,
            broadcast_enabled=True,
            command_enabled=False,
            command_handler=None,
            request_handler=request_handler,
        )


class TcpControlServer(_TcpJsonServerCore):
    """Write-only control command server."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 9001,
        *,
        frame_delimiter: bytes | str = b"\n",
        command_handler: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        super().__init__(
            host=host,
            port=port,
            frame_delimiter=frame_delimiter,
            broadcast_enabled=False,
            command_enabled=True,
            command_handler=command_handler,
            request_handler=None,
        )


class TcpBroadcastServer(_TcpJsonServerCore):
    """Compatibility server: combined telemetry broadcast + control input."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 9000,
        *,
        frame_delimiter: bytes | str = b"\n",
        command_handler: Optional[Callable[[Dict[str, Any]], None]] = None,
        request_handler: Optional[Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = None,
    ) -> None:
        super().__init__(
            host=host,
            port=port,
            frame_delimiter=frame_delimiter,
            broadcast_enabled=True,
            command_enabled=True,
            command_handler=command_handler,
            request_handler=request_handler,
        )
