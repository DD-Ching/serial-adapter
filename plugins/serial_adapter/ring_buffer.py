from __future__ import annotations

from collections import deque
import threading
from typing import Deque, List, Optional

DEFAULT_BUFFER_SIZE = 512 * 1024
DEFAULT_MAX_FRAMES = 10
DEFAULT_FRAME_DELIMITER = b"\n"


def normalize_frame_delimiter(frame_delimiter: bytes | str) -> bytes:
    if isinstance(frame_delimiter, str):
        delimiter = frame_delimiter.encode("utf-8")
    elif isinstance(frame_delimiter, bytes):
        delimiter = frame_delimiter
    else:
        raise TypeError("frame_delimiter must be bytes or str")

    if not delimiter:
        raise ValueError("frame_delimiter must not be empty")
    return delimiter


class RingBuffer:
    """Thread-safe frame ring buffer with delimiter-based extraction."""

    def __init__(
        self,
        *,
        buffer_size: int = DEFAULT_BUFFER_SIZE,
        max_frames: int = DEFAULT_MAX_FRAMES,
        frame_delimiter: bytes | str = DEFAULT_FRAME_DELIMITER,
    ) -> None:
        if int(buffer_size) <= 0:
            raise ValueError("buffer_size must be positive")
        if int(max_frames) <= 0:
            raise ValueError("max_frames must be positive")

        self._buffer_size = int(buffer_size)
        self._max_frames = int(max_frames)
        self._frame_delimiter = normalize_frame_delimiter(frame_delimiter)
        self._buffer = bytearray()
        self._pending_frames: Deque[bytes] = deque()
        self._history_frames: Deque[bytes] = deque(maxlen=self._max_frames)
        self._lock = threading.Lock()

    @property
    def frame_delimiter(self) -> bytes:
        return self._frame_delimiter

    @property
    def usage_ratio(self) -> float:
        with self._lock:
            return min(1.0, float(len(self._buffer)) / float(self._buffer_size))

    def append(self, data: bytes) -> None:
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("append() requires bytes-like input")
        if not data:
            return

        with self._lock:
            self._buffer.extend(data)
            if len(self._buffer) > self._buffer_size:
                overflow = len(self._buffer) - self._buffer_size
                del self._buffer[:overflow]

            delimiter = self._frame_delimiter
            delimiter_len = len(delimiter)
            while True:
                idx = self._buffer.find(delimiter)
                if idx < 0:
                    break

                frame = bytes(self._buffer[:idx])
                del self._buffer[: idx + delimiter_len]
                if len(self._pending_frames) >= self._max_frames:
                    self._pending_frames.popleft()
                self._pending_frames.append(frame)
                self._history_frames.append(frame)

    def read_frame(self) -> Optional[bytes]:
        with self._lock:
            if not self._pending_frames:
                return None
            return self._pending_frames.popleft()

    def peek_frame(self) -> Optional[bytes]:
        with self._lock:
            if not self._pending_frames:
                return None
            return self._pending_frames[0]

    def clear(self) -> None:
        with self._lock:
            self._buffer.clear()
            self._pending_frames.clear()
            self._history_frames.clear()

    def get_last_n(self, n: int) -> List[bytes]:
        if int(n) <= 0:
            return []
        with self._lock:
            return list(self._history_frames)[-int(n) :]
