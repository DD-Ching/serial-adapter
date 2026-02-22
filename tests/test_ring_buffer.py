from __future__ import annotations

from python.plugin import RingBuffer


def test_fragment_kept_until_delimiter():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1')
    assert ring.peek_frame() is None


def test_max_frames_trimming():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|{"value":3}|{"value":4}|')
    assert ring.read_frame() == b'{"value":2}'


def test_peek_frame():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|{"value":3}|{"value":4}|')
    ring.read_frame()  # consume first
    assert ring.peek_frame() == b'{"value":3}'


def test_get_last_n():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|{"value":3}|{"value":4}|')
    last_two = ring.get_last_n(2)
    assert last_two == [b'{"value":3}', b'{"value":4}']


def test_clear():
    ring = RingBuffer(buffer_size=64, max_frames=3, frame_delimiter="|")
    ring.append(b'{"value":1}|{"value":2}|')
    ring.clear()
    assert ring.read_frame() is None
