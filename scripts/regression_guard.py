#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from typing import Any, Dict, Optional, Tuple

SENSOR_KEYS = ("ax", "ay", "az", "gx", "gy", "gz")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Hardware regression guard: verify control ACK + observer telemetry "
            "without flooding logs."
        )
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--control-port", type=int, default=9001)
    parser.add_argument("--telemetry-port", type=int, default=9000)
    parser.add_argument("--timeout-s", type=float, default=3.0)
    parser.add_argument("--angle", type=int, default=90)
    parser.add_argument("--no-servo", action="store_true")
    return parser


def _json_line(sock: socket.socket, obj: Dict[str, Any]) -> None:
    payload = (
        json.dumps(
            obj,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )
    sock.sendall(payload)


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
            line = data.split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
            return line or None


def send_control(host: str, port: int, cmd: Dict[str, Any], timeout_s: float) -> Tuple[bool, Optional[Dict[str, Any]], Optional[str]]:
    try:
        with socket.create_connection((host, port), timeout=max(0.2, timeout_s)) as sock:
            _json_line(sock, cmd)
            line = _recv_line(sock, timeout_s=timeout_s)
    except OSError as exc:
        return False, None, str(exc)

    if line is None:
        return False, None, "no_ack"

    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return False, None, f"non_json_ack:{line}"

    return bool(parsed.get("ok") is True), parsed, None


def extract_values(frame: Dict[str, Any]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    parsed = frame.get("parsed")
    source = parsed if isinstance(parsed, dict) else frame
    for key in SENSOR_KEYS:
        value = source.get(key)
        if isinstance(value, (int, float)):
            out[key] = float(value)
    return out


def observe_telemetry(host: str, port: int, timeout_s: float) -> Dict[str, Any]:
    started = time.time()
    frames = 0
    parsed_samples = 0
    seen: Dict[str, int] = {k: 0 for k in SENSOR_KEYS}

    with socket.create_connection((host, port), timeout=max(0.2, timeout_s)) as sock:
        sock.settimeout(0.5)
        buffer = b""
        while time.time() - started < timeout_s:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                raw, buffer = buffer.split(b"\n", 1)
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
                values = extract_values(payload)
                if values:
                    parsed_samples += 1
                for key in values.keys():
                    seen[key] += 1

    return {
        "frames": frames,
        "parsed_samples": parsed_samples,
        "seen_fields": seen,
        "has_ax_ay_az": all(seen[k] > 0 for k in ("ax", "ay", "az")),
    }


def main() -> int:
    args = build_parser().parse_args()
    report: Dict[str, Any] = {
        "type": "regression_guard",
        "ok": False,
        "control": {},
        "telemetry": {},
        "errors": [],
    }

    ok_status, status_ack, status_err = send_control(
        args.host,
        int(args.control_port),
        {"__adapter_cmd": "status"},
        timeout_s=float(args.timeout_s),
    )
    report["control"]["status_ok"] = ok_status
    report["control"]["status_ack"] = status_ack
    if status_err:
        report["errors"].append(f"status:{status_err}")

    ok_caps, caps_ack, caps_err = send_control(
        args.host,
        int(args.control_port),
        {"__adapter_cmd": "capabilities"},
        timeout_s=float(args.timeout_s),
    )
    report["control"]["capabilities_ok"] = ok_caps
    report["control"]["capabilities_ack"] = caps_ack
    if caps_err:
        report["errors"].append(f"capabilities:{caps_err}")

    if not args.no_servo:
        ok_servo, servo_ack, servo_err = send_control(
            args.host,
            int(args.control_port),
            {"servo_pos": int(args.angle)},
            timeout_s=float(args.timeout_s),
        )
        report["control"]["servo_ok"] = ok_servo
        report["control"]["servo_ack"] = servo_ack
        if servo_err:
            report["errors"].append(f"servo:{servo_err}")
    else:
        report["control"]["servo_ok"] = None
        report["control"]["servo_ack"] = None

    try:
        telemetry = observe_telemetry(
            args.host,
            int(args.telemetry_port),
            timeout_s=float(args.timeout_s),
        )
        report["telemetry"] = telemetry
    except OSError as exc:
        report["telemetry"] = {"frames": 0, "parsed_samples": 0}
        report["errors"].append(f"telemetry:{exc}")

    control_ok = bool(report["control"].get("status_ok")) and bool(
        report["control"].get("capabilities_ok")
    )
    if report["control"].get("servo_ok") is not None:
        control_ok = control_ok and bool(report["control"].get("servo_ok"))

    telemetry_ok = bool(report["telemetry"].get("frames", 0) > 0) and bool(
        report["telemetry"].get("has_ax_ay_az")
    )
    report["ok"] = control_ok and telemetry_ok

    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
