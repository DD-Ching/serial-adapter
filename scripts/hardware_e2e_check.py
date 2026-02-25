#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

PROBE_SEQUENCE = ("STATUS?", "IMU_ON", "TELEMETRY_ON", "STREAM_ON", "IMU?")
IMU_KEYS = ("ax", "ay", "az", "gx", "gy", "gz")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Strict hardware E2E check for serial-adapter runtime: "
            "handshake -> observe -> drive -> verify summary."
        )
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--control-port", type=int, default=9001)
    parser.add_argument("--telemetry-port", type=int, default=9000)
    parser.add_argument("--timeout-s", type=float, default=3.0)
    parser.add_argument("--observe-s", type=float, default=2.5)
    parser.add_argument("--drive-angle", type=int, default=90)
    parser.add_argument("--skip-drive", action="store_true")
    return parser


def _recv_line(sock: socket.socket, timeout_s: float) -> Optional[str]:
    sock.settimeout(max(0.2, timeout_s))
    data = b""
    while True:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            return None
        if not chunk:
            return None
        data += chunk
        if b"\n" in data:
            raw = data.split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
            return raw or None


def _send_control(host: str, port: int, payload: Dict[str, Any], timeout_s: float) -> Tuple[bool, Optional[Dict[str, Any]], Optional[str]]:
    try:
        with socket.create_connection((host, int(port)), timeout=max(0.2, timeout_s)) as sock:
            line = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8") + b"\n"
            sock.sendall(line)
            reply = _recv_line(sock, timeout_s=timeout_s)
    except OSError as exc:
        return False, None, str(exc)

    if reply is None:
        return False, None, "no_ack"
    try:
        parsed = json.loads(reply)
    except json.JSONDecodeError:
        return False, None, f"non_json_ack:{reply}"
    return bool(parsed.get("ok") is True), parsed, None


def _extract_numeric(payload: Dict[str, Any]) -> Dict[str, float]:
    parsed = payload.get("parsed")
    source = parsed if isinstance(parsed, dict) else payload
    out: Dict[str, float] = {}
    for key in IMU_KEYS + ("servo",):
        value = source.get(key)
        if isinstance(value, (int, float)):
            out[key] = float(value)
    return out


def _observe(host: str, port: int, timeout_s: float) -> Dict[str, Any]:
    frames = 0
    parsed_samples = 0
    seen: Dict[str, int] = {key: 0 for key in IMU_KEYS}
    servo_seen = 0
    latest: Optional[Dict[str, Any]] = None

    started = time.time()
    with socket.create_connection((host, int(port)), timeout=max(0.2, timeout_s)) as sock:
        sock.settimeout(0.4)
        buf = b""
        while time.time() - started < timeout_s:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                text = raw.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                frames += 1
                numeric = _extract_numeric(payload)
                if numeric:
                    parsed_samples += 1
                for key in IMU_KEYS:
                    if key in numeric:
                        seen[key] += 1
                if "servo" in numeric:
                    servo_seen += 1
                latest = {
                    "ts": payload.get("ts", payload.get("timestamp")),
                    "raw": str(payload.get("raw", ""))[:160],
                    "parsed": numeric,
                }

    return {
        "frames": frames,
        "parsed_samples": parsed_samples,
        "seen_fields": seen,
        "servo_samples": servo_seen,
        "has_ax_ay_az": all(seen[k] > 0 for k in ("ax", "ay", "az")),
        "latest": latest,
    }


def main() -> int:
    args = _build_parser().parse_args()

    report: Dict[str, Any] = {
        "type": "hardware_e2e_check",
        "ok": False,
        "handshake": {},
        "control": {},
        "telemetry": {},
        "diagnosis": "",
        "next_step": "",
        "errors": [],
    }

    ok_status, ack_status, err_status = _send_control(
        args.host, args.control_port, {"__adapter_cmd": "status"}, args.timeout_s
    )
    report["control"]["status_ok"] = ok_status
    report["control"]["status_ack"] = ack_status
    if err_status:
        report["errors"].append(f"status:{err_status}")

    ok_caps, ack_caps, err_caps = _send_control(
        args.host, args.control_port, {"__adapter_cmd": "capabilities"}, args.timeout_s
    )
    report["control"]["capabilities_ok"] = ok_caps
    report["control"]["capabilities_ack"] = ack_caps
    if err_caps:
        report["errors"].append(f"capabilities:{err_caps}")

    probe_results: List[Dict[str, Any]] = []
    for line in PROBE_SEQUENCE:
        ok_probe, ack_probe, err_probe = _send_control(
            args.host,
            args.control_port,
            {"cmd": "raw_line", "line": line, "source_id": "hardware_e2e", "priority": 25, "lease_ms": 4500},
            args.timeout_s,
        )
        probe_results.append(
            {
                "line": line,
                "ok": ok_probe,
                "reason": None if ack_probe is None else ack_probe.get("reason"),
                "error": err_probe,
            }
        )
        time.sleep(0.08)
    report["handshake"]["probe_results"] = probe_results

    if not args.skip_drive:
        ok_drive, ack_drive, err_drive = _send_control(
            args.host,
            args.control_port,
            {"servo_pos": int(args.drive_angle), "source_id": "hardware_e2e", "priority": 25, "lease_ms": 4500},
            args.timeout_s,
        )
        report["control"]["drive_ok"] = ok_drive
        report["control"]["drive_ack"] = ack_drive
        if err_drive:
            report["errors"].append(f"drive:{err_drive}")
    else:
        report["control"]["drive_ok"] = None
        report["control"]["drive_ack"] = None

    try:
        telemetry = _observe(args.host, args.telemetry_port, timeout_s=float(args.observe_s))
    except OSError as exc:
        telemetry = {"frames": 0, "parsed_samples": 0, "seen_fields": {}, "has_ax_ay_az": False, "latest": None}
        report["errors"].append(f"telemetry:{exc}")
    report["telemetry"] = telemetry

    status_ok = bool(report["control"].get("status_ok"))
    caps_ok = bool(report["control"].get("capabilities_ok"))
    drive_ok = report["control"].get("drive_ok")
    if drive_ok is None:
        drive_ok = True

    if not status_ok or not caps_ok:
        report["diagnosis"] = "control_channel_unhealthy"
        report["next_step"] = "Ensure OpenClaw gateway is running and serial-adapter plugin is loaded."
    elif not bool(drive_ok):
        report["diagnosis"] = "drive_command_not_accepted"
        report["next_step"] = "Check control allowlist/rate-limit and runtime control ACK reason."
    elif telemetry.get("frames", 0) <= 0:
        report["diagnosis"] = "serial_silent_no_telemetry_bytes"
        report["next_step"] = (
            "COM is connected but no telemetry bytes arrived. Verify firmware is the IMU telemetry firmware "
            "at 115200 and not a silent/autonomous-only sketch."
        )
    elif not bool(telemetry.get("has_ax_ay_az")):
        report["diagnosis"] = "telemetry_without_required_imu_fields"
        report["next_step"] = "Telemetry exists but ax/ay/az missing. Enable MPU6050 telemetry fields in firmware."
    else:
        report["diagnosis"] = "e2e_ok"
        report["next_step"] = "Handshake/observe/drive path verified."

    report["ok"] = report["diagnosis"] == "e2e_ok"
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
