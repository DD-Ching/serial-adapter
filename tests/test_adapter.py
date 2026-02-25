from __future__ import annotations

import json
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


def test_tcp_control_raw_numeric_line_forwarding(
    adapter_with_tcp: SerialAdapter,
    fake_serial: FakeSerial,
    control_client: socket.socket,
):
    control_client.sendall(b"90\n")
    assert wait_for(
        lambda: any(item == b"90|" for item in fake_serial.writes),
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
    "control_lease",
    "auto_probe",
    "telemetry_last_rx_s_ago",
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
    auto_probe = status["auto_probe"]
    assert isinstance(auto_probe, dict)
    assert auto_probe["enabled"] is True
    assert isinstance(auto_probe["sequence"], list)


def test_auto_probe_sends_handshake_on_connect():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False, unsafe_passthrough=True)
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    adapter._reset_runtime_state()  # type: ignore[attr-defined]

    sent = adapter._send_next_auto_probe(reason="test", force=True)  # type: ignore[attr-defined]
    assert sent is True
    assert any(item in fake.writes for item in [b"STATUS?\n", b"IMU_ON\n", b"TELEMETRY_ON\n", b"STREAM_ON\n", b"IMU?\n"])


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


def test_key_value_text_frame_parsing(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b"ax:-12872 ay:-1744 az:7788 gx:-656 gy:335 gz:96 servo:103|")
    assert wait_for(lambda: adapter_with_tcp.get_latest_frame() is not None, timeout=2.0)

    frame = adapter_with_tcp.poll()
    assert frame is not None
    assert frame["parsed"] is not None
    assert frame["parsed"]["ax"] == -12872
    assert frame["parsed"]["ay"] == -1744
    assert frame["parsed"]["az"] == 7788
    assert frame["parsed"]["servo"] == 103
    assert frame["ax"] == -12872
    assert frame["servo"] == 103


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
# Control queue during COM contention/pause
# ---------------------------------------------------------------------------


def test_control_is_queued_while_serial_paused_and_flushed_after_resume():
    adapter = SerialAdapter(
        "mock",
        9600,
        enable_tcp=False,
        unsafe_passthrough=True,
        max_control_rate=10,
        max_queued_control=8,
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    adapter.pause_serial(hold_s=0)

    ack = adapter._handle_control_command({"custom_control": 1})  # type: ignore[attr-defined]
    assert isinstance(ack, dict)
    assert ack["ok"] is True
    assert ack["reason"] == "queued"

    status_before = adapter.get_status()
    assert status_before["serial_paused"] is True
    assert status_before["queued_control_count"] == 1
    assert status_before["control_commands_queued"] >= 1

    adapter.resume_serial()
    adapter._serial = fake  # type: ignore[attr-defined]
    flushed = adapter._flush_queued_control(max_items=8)  # type: ignore[attr-defined]
    assert flushed >= 1
    assert any(b'"custom_control":1' in item for item in fake.writes)

    status_after = adapter.get_status()
    assert status_after["serial_paused"] is False
    assert status_after["queued_control_count"] == 0


def test_control_queue_full_is_rejected():
    adapter = SerialAdapter(
        "mock",
        9600,
        enable_tcp=False,
        unsafe_passthrough=True,
        max_control_rate=10,
        max_queued_control=1,
    )
    adapter.pause_serial(hold_s=0)

    ack1 = adapter._handle_control_command({"custom_control": 1})  # type: ignore[attr-defined]
    ack2 = adapter._handle_control_command({"custom_control": 2})  # type: ignore[attr-defined]
    assert isinstance(ack1, dict) and ack1["ok"] is True and ack1["reason"] == "queued"
    assert isinstance(ack2, dict) and ack2["ok"] is False and ack2["reason"] == "queue_full"

    status = adapter.get_status()
    assert status["queued_control_count"] == 1
    assert status["queued_control_dropped"] >= 1


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


# ---------------------------------------------------------------------------
# Validation & edge cases
# ---------------------------------------------------------------------------


def test_same_telemetry_control_port_raises():
    port = find_free_port()
    with pytest.raises(ValueError, match="differ"):
        SerialAdapter(
            "mock", 9600, telemetry_port=port, control_port=port, enable_tcp=True
        )


def test_register_callback_non_callable_raises():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False)
    with pytest.raises(TypeError, match="callable"):
        adapter.register_callback("not a function")  # type: ignore[arg-type]


def test_get_latest_frame_none_initially(adapter_with_tcp: SerialAdapter):
    assert adapter_with_tcp.get_latest_frame() is None


def test_get_last_n_frames_zero(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b'{"value":1}|')
    assert wait_for(lambda: adapter_with_tcp.get_latest_frame() is not None)
    assert adapter_with_tcp.get_last_n_frames(0) == []


def test_write_non_dict_raises():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False)
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    with pytest.raises(TypeError, match="dict"):
        adapter.write("not a dict")  # type: ignore[arg-type]


def test_write_sends_json_to_serial():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False)
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    adapter.write({"motor_pwm": 100})
    assert len(fake.writes) == 1
    payload = fake.writes[0]
    assert b"motor_pwm" in payload
    assert b"100" in payload


def test_write_without_serial_raises():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False)
    with pytest.raises(RuntimeError, match="not connected"):
        adapter.write({"cmd": "test"})


# ---------------------------------------------------------------------------
# No-TCP mode
# ---------------------------------------------------------------------------


def test_no_tcp_endpoints_none():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False)
    assert adapter.get_tcp_endpoint() is None
    assert adapter.get_control_endpoint() is None


def test_no_tcp_poll_works():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False, frame_delimiter="|")
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]
    adapter.start()
    try:
        fake.feed(b'{"value":42}|')
        assert wait_for(lambda: adapter.get_latest_frame() is not None)
        frame = adapter.poll()
        assert frame is not None
        assert frame["parsed"]["value"] == 42
    finally:
        adapter.disconnect()


# ---------------------------------------------------------------------------
# Disconnect cleanup
# ---------------------------------------------------------------------------


def test_disconnect_clears_state(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    fake_serial.feed(b'{"value":10}|')
    assert wait_for(lambda: adapter_with_tcp.get_latest_frame() is not None)
    adapter_with_tcp.disconnect()
    assert adapter_with_tcp.get_latest_frame() is None
    assert adapter_with_tcp.get_last_n_frames(10) == []


# ---------------------------------------------------------------------------
# Multiple callbacks
# ---------------------------------------------------------------------------


def test_multiple_callbacks(
    adapter_with_tcp: SerialAdapter, fake_serial: FakeSerial
):
    results_a: List[Dict[str, Any]] = []
    results_b: List[Dict[str, Any]] = []
    adapter_with_tcp.register_callback(lambda f: results_a.append(f))
    adapter_with_tcp.register_callback(lambda f: results_b.append(f))

    fake_serial.feed(b'{"value":1}|')
    assert wait_for(lambda: len(results_a) >= 1 and len(results_b) >= 1)


# ---------------------------------------------------------------------------
# Control command allow/deny
# ---------------------------------------------------------------------------


def test_allowed_commands_custom_list():
    adapter = SerialAdapter(
        "mock",
        9600,
        enable_tcp=False,
        allowed_commands=["set_speed"],
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    # Allowed
    adapter._handle_control_command({"set_speed": 100})  # type: ignore[attr-defined]
    assert len(fake.writes) == 1

    # Denied (not in custom list)
    adapter._handle_control_command({"motor_pwm": 50})  # type: ignore[attr-defined]
    assert len(fake.writes) == 1  # no new write


def test_unsafe_passthrough_allows_all():
    adapter = SerialAdapter(
        "mock", 9600, enable_tcp=False, unsafe_passthrough=True
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    adapter._handle_control_command({"anything": 1})  # type: ignore[attr-defined]
    adapter._handle_control_command({"shutdown": 1})  # type: ignore[attr-defined]
    assert len(fake.writes) == 2


# ---------------------------------------------------------------------------
# Control source arbitration lease
# ---------------------------------------------------------------------------


def test_control_source_lease_blocks_anonymous_commands():
    adapter = SerialAdapter(
        "mock", 9600, enable_tcp=False, unsafe_passthrough=True, max_control_rate=20
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    ack_owner = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 1, "source_id": "intent-a", "priority": 10, "lease_ms": 3000}
    )
    ack_anonymous = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 2}
    )

    assert isinstance(ack_owner, dict)
    assert ack_owner["ok"] is True
    assert isinstance(ack_anonymous, dict)
    assert ack_anonymous["ok"] is False
    assert ack_anonymous["reason"] == "lease_held_by_other"
    assert len(fake.writes) == 1


def test_control_source_lease_can_be_preempted_by_higher_priority():
    adapter = SerialAdapter(
        "mock", 9600, enable_tcp=False, unsafe_passthrough=True, max_control_rate=20
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    ack_a = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 1, "source_id": "source-a", "priority": 0, "lease_ms": 3000}
    )
    ack_b = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 2, "source_id": "source-b", "priority": 5, "lease_ms": 3000}
    )
    ack_a_again = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 3, "source_id": "source-a", "priority": 0, "lease_ms": 3000}
    )

    assert isinstance(ack_a, dict) and ack_a["ok"] is True
    assert isinstance(ack_b, dict) and ack_b["ok"] is True
    assert isinstance(ack_a_again, dict)
    assert ack_a_again["ok"] is False
    assert ack_a_again["reason"] == "lease_held_by_other"
    assert len(fake.writes) == 2


def test_control_source_lease_expires_and_releases():
    adapter = SerialAdapter(
        "mock", 9600, enable_tcp=False, unsafe_passthrough=True, max_control_rate=20
    )
    fake = FakeSerial()
    adapter._serial = fake  # type: ignore[attr-defined]

    ack_owner = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 1, "source_id": "source-a", "priority": 1, "lease_ms": 3000}
    )
    assert isinstance(ack_owner, dict) and ack_owner["ok"] is True

    with adapter._control_lock:  # type: ignore[attr-defined]
        adapter._control_lease_expires_monotonic = time.monotonic() - 1.0  # type: ignore[attr-defined]

    ack_anonymous = adapter._handle_control_command(  # type: ignore[attr-defined]
        {"custom_control": 2}
    )
    assert isinstance(ack_anonymous, dict) and ack_anonymous["ok"] is True
    assert len(fake.writes) == 2
    status = adapter.get_status()
    assert isinstance(status["control_lease"], dict)
    assert status["control_lease"]["active"] is False


# ---------------------------------------------------------------------------
# Status counters
# ---------------------------------------------------------------------------


def test_status_initial_values():
    adapter = SerialAdapter("mock", 9600, enable_tcp=False)
    status = adapter.get_status()
    assert status["rx_rate"] == 0.0
    assert status["tx_rate"] == 0.0
    assert status["connected_clients"] == 0
    assert status["control_commands_accepted"] == 0
    assert status["control_commands_rejected"] == 0
    assert 0.0 <= status["ring_buffer_usage_ratio"] <= 1.0
