from __future__ import annotations

import socket
import time
from typing import Any, Dict, List

import pytest

from python.plugin import SerialAdapter

from .conftest import (
    FakeSerial,
    find_free_port,
    recv_json_lines,
    wait_for,
)


# ---------------------------------------------------------------------------
# Basic adapter
# ---------------------------------------------------------------------------


def test_endpoints_available(adapter_with_tcp: SerialAdapter):
    telemetry = adapter_with_tcp.get_tcp_endpoint()
    control = adapter_with_tcp.get_control_endpoint()
    assert telemetry is not None and telemetry[1] > 0
    assert control is not None and control[1] > 0


def test_endpoints_separated(adapter_with_tcp: SerialAdapter):
    telemetry = adapter_with_tcp.get_tcp_endpoint()
    control = adapter_with_tcp.get_control_endpoint()
    assert telemetry is not None
    assert control is not None
    assert telemetry[1] != control[1]


def test_poll_returns_none_for_fragment(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b'{"value":10')
    time.sleep(0.05)
    assert adapter_with_tcp.poll() is None


def test_poll_all_returns_frames(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b'{"value":10}|{"value":20}|')
    assert wait_for(lambda: len(adapter_with_tcp.get_last_n_frames(2)) >= 2)

    frames = adapter_with_tcp.poll_all()
    assert len(frames) >= 2
    assert frames[0]["raw"] == '{"value":10}'
    assert frames[1]["raw"] == '{"value":20}'
    assert frames[0]["parsed"]["value"] == 10
    assert frames[1]["parsed"]["value"] == 20


def test_frame_meta(adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial):
    fake_serial.feed(b'{"value":10}|')
    assert wait_for(lambda: adapter_with_tcp.get_latest_frame() is not None)

    frames = adapter_with_tcp.poll_all()
    meta = frames[0]["meta"]
    assert isinstance(meta, dict)
    assert meta["source"] == "serial"
    assert meta["size"] == len(b'{"value":10}')


def test_backward_compat_top_level_keys(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b'{"value":10}|{"value":20}|')
    assert wait_for(lambda: len(adapter_with_tcp.get_last_n_frames(2)) >= 2)

    frames = adapter_with_tcp.poll_all()
    assert frames[0]["value"] == 10
    assert frames[1]["value"] == 20


# ---------------------------------------------------------------------------
# TCP channels
# ---------------------------------------------------------------------------


def test_tcp_telemetry_broadcast(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    telemetry_client: socket.socket,
):
    fake_serial.feed(b'{"value":10}|{"value":20}|')
    assert wait_for(lambda: len(adapter_with_tcp.get_last_n_frames(2)) >= 2)

    lines = recv_json_lines(telemetry_client, expected=2, timeout=2.0)
    assert len(lines) >= 2
    assert lines[0]["parsed"]["value"] == 10
    assert lines[1]["parsed"]["value"] == 20


def test_tcp_control_forwarding(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    control_client: socket.socket,
):
    control_client.sendall(b'{"motor_pwm":120}\n')
    assert wait_for(
        lambda: any(b'"motor_pwm":120' in item for item in fake_serial.writes),
        timeout=2.0,
    )


def test_tcp_control_rejection(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    control_client: socket.socket,
):
    writes_before = len(fake_serial.writes)
    control_client.sendall(b'{"shutdown":1}\n')
    time.sleep(0.1)
    assert not any(
        b'"shutdown":1' in item for item in fake_serial.writes[writes_before:]
    )


def test_tcp_whitelisted_command(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    control_client: socket.socket,
):
    control_client.sendall(b'{"target_velocity":3.5}\n')
    assert wait_for(
        lambda: any(
            b'"target_velocity":3.5' in item for item in fake_serial.writes
        ),
        timeout=2.0,
    )


def test_telemetry_readonly(
    adapter_with_tcp: SerialAdapter,
    telemetry_client: socket.socket,
):
    telemetry_client.sendall(b'{"cmd":"status"}\n')
    time.sleep(0.1)
    try:
        response = telemetry_client.recv(4096)
    except socket.timeout:
        response = b""
    assert response == b""


def test_control_no_telemetry_leak(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    control_client: socket.socket,
):
    fake_serial.feed(b'{"value":99}|')
    assert wait_for(lambda: adapter_with_tcp.get_latest_frame() is not None)
    time.sleep(0.1)
    try:
        leaked = control_client.recv(4096)
    except socket.timeout:
        leaked = b""
    assert leaked == b""


# ---------------------------------------------------------------------------
# Status & stats
# ---------------------------------------------------------------------------


_STATUS_REQUIRED_FIELDS = {
    "rx_rate",
    "tx_rate",
    "connected_clients",
    "ring_buffer_usage_ratio",
    "control_commands_accepted",
    "control_commands_rejected",
}


def test_get_status_fields(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    telemetry_client: socket.socket,
    control_client: socket.socket,
):
    # Send a whitelisted + a rejected command so counters are non-zero.
    control_client.sendall(b'{"motor_pwm":120}\n')
    assert wait_for(
        lambda: any(b'"motor_pwm":120' in item for item in fake_serial.writes),
        timeout=2.0,
    )
    control_client.sendall(b'{"motor_pwm":121}\n')
    assert wait_for(
        lambda: any(b'"motor_pwm":121' in item for item in fake_serial.writes),
        timeout=2.0,
    )
    control_client.sendall(b'{"shutdown":1}\n')
    time.sleep(0.1)

    status = adapter_with_tcp.get_status()
    assert _STATUS_REQUIRED_FIELDS.issubset(status.keys())
    assert isinstance(status["rx_rate"], (int, float))
    assert isinstance(status["tx_rate"], (int, float))
    assert int(status["connected_clients"]) >= 2
    ratio = float(status["ring_buffer_usage_ratio"])
    assert 0.0 <= ratio <= 1.0
    assert int(status["control_commands_accepted"]) >= 2
    assert int(status["control_commands_rejected"]) >= 1


def test_invalid_json_frame(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b"not-json|")
    assert wait_for(
        lambda: (
            isinstance(adapter_with_tcp.get_latest_frame(), dict)
            and adapter_with_tcp.get_latest_frame().get("raw") == "not-json"
        ),
        timeout=2.0,
    )
    invalid = adapter_with_tcp.poll()
    assert invalid is not None
    assert invalid["raw"] == "not-json"
    assert invalid["parsed"] is None


def test_statistics(adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial):
    fake_serial.feed(b'{"value":10}|{"value":20}|')
    assert wait_for(lambda: len(adapter_with_tcp.get_last_n_frames(2)) >= 2)
    # Drain pending frames so stats are computed.
    adapter_with_tcp.poll_all()

    stats = adapter_with_tcp.get_statistics()
    assert stats["mean"] == 15.0
    assert stats["min"] == 10.0
    assert stats["max"] == 20.0
    assert stats["delta"] == 10.0
    value_stats = stats["fields"]["value"]
    assert isinstance(value_stats, dict)
    assert value_stats["mean"] == 15.0


def test_callback_triggered(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    callback_frames: List[Dict[str, Any]] = []
    adapter_with_tcp.register_callback(lambda frame: callback_frames.append(frame))

    fake_serial.feed(b'{"value":10}|{"value":20}|not-json|')
    assert wait_for(lambda: len(callback_frames) >= 3, timeout=2.0)


def test_read_compatibility(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b'{"value":30}|')
    assert wait_for(
        lambda: any(
            frame.get("value") == 30
            for frame in adapter_with_tcp.get_last_n_frames(1)
        )
    )
    compat = adapter_with_tcp.read()
    assert compat is not None
    assert compat["value"] == 30


# ---------------------------------------------------------------------------
# Rate limiting (separate fixture, no TCP)
# ---------------------------------------------------------------------------


@pytest.fixture()
def rate_adapter():
    adapter = SerialAdapter(
        "mock",
        9600,
        enable_tcp=False,
        unsafe_passthrough=True,
        max_control_rate=2,
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    yield adapter, fake
    adapter.disconnect()


def test_control_rate_limit(rate_adapter):
    adapter, fake = rate_adapter
    adapter._handle_control_command({"custom_control": 1})  # type: ignore[attr-defined]
    adapter._handle_control_command({"custom_control": 2})  # type: ignore[attr-defined]
    adapter._handle_control_command({"custom_control": 3})  # type: ignore[attr-defined]
    assert len(fake.writes) == 2


def test_control_rate_limit_reset(rate_adapter):
    adapter, fake = rate_adapter
    adapter._handle_control_command({"custom_control": 1})  # type: ignore[attr-defined]
    adapter._handle_control_command({"custom_control": 2})  # type: ignore[attr-defined]
    time.sleep(1.05)
    adapter._handle_control_command({"custom_control": 3})  # type: ignore[attr-defined]
    assert len(fake.writes) == 3


# ---------------------------------------------------------------------------
# Combined mode (separate fixture)
# ---------------------------------------------------------------------------


def test_combined_tcp_port_compat():
    compat_port = find_free_port()
    adapter = SerialAdapter(
        "mock",
        9600,
        frame_delimiter="|",
        tcp_port=compat_port,
        enable_tcp=True,
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    adapter.start()

    try:
        telemetry_ep = adapter.get_tcp_endpoint()
        control_ep = adapter.get_control_endpoint()
        assert telemetry_ep is not None
        assert control_ep is not None
        assert telemetry_ep[1] == control_ep[1]

        client = socket.create_connection(telemetry_ep, timeout=2.0)
        client.settimeout(0.2)
        try:
            fake.feed(b'{"value":77}|')
            assert wait_for(lambda: len(adapter.get_last_n_frames(1)) >= 1)
            lines = recv_json_lines(client, expected=1, timeout=2.0)
            assert lines and lines[0]["parsed"]["value"] == 77

            client.sendall(b'{"motor_pwm":55}\n')
            assert wait_for(
                lambda: any(
                    b'"motor_pwm":55' in item for item in fake.writes
                ),
                timeout=2.0,
            )
        finally:
            client.close()
    finally:
        adapter.disconnect()
