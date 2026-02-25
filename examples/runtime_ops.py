#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
import sys
from typing import Any, Dict, Optional, Tuple


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Runtime control helper for serial-adapter (avoids shell JSON quoting issues)."
        )
    )
    parser.add_argument("--host", default="127.0.0.1", help="Control host")
    parser.add_argument("--port", type=int, default=9001, help="Control port")
    parser.add_argument(
        "--timeout",
        type=float,
        default=1.0,
        help="Socket timeout in seconds",
    )

    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("status", help="Get adapter runtime status")
    sub.add_parser("capabilities", help="Get adapter capability declaration")

    pause = sub.add_parser("pause", help="Pause adapter and release COM handle")
    pause.add_argument(
        "--hold-s",
        type=float,
        default=None,
        help="Optional auto-resume hold time in seconds",
    )

    sub.add_parser("resume", help="Resume adapter serial connection attempts")

    servo = sub.add_parser("servo", help="Send servo angle command")
    servo.add_argument("--angle", type=int, required=True, help="Servo angle (0-180)")

    raw = sub.add_parser("raw", help="Send raw serial line via control channel")
    raw.add_argument("--line", required=True, help="Raw line, for example IMU? or A90")

    set_cmd = sub.add_parser("set", help="Send allowlisted numeric control command")
    set_cmd.add_argument(
        "--target",
        required=True,
        choices=["target_velocity", "motor_pwm", "servo_pos", "servo_angle"],
        help="Control target",
    )
    set_cmd.add_argument("--value", type=float, required=True, help="Numeric value")

    return parser


def build_command(args: argparse.Namespace) -> Dict[str, Any]:
    if args.action == "status":
        return {"__adapter_cmd": "status"}

    if args.action == "capabilities":
        return {"__adapter_cmd": "capabilities"}

    if args.action == "pause":
        command: Dict[str, Any] = {"__adapter_cmd": "pause"}
        if args.hold_s is not None:
            command["hold_s"] = float(args.hold_s)
        return command

    if args.action == "resume":
        return {"__adapter_cmd": "resume"}

    if args.action == "servo":
        if args.angle < 0 or args.angle > 180:
            raise ValueError("servo angle must be between 0 and 180")
        return {"servo_pos": int(args.angle)}

    if args.action == "raw":
        return {"cmd": "raw_line", "line": str(args.line)}

    if args.action == "set":
        if args.target in {"servo_pos", "servo_angle"}:
            angle = int(args.value)
            if angle < 0 or angle > 180:
                raise ValueError("servo angle must be between 0 and 180")
            return {"servo_pos": angle}

        if args.target == "motor_pwm":
            return {"motor_pwm": int(args.value)}

        return {args.target: float(args.value)}

    raise ValueError(f"unsupported action: {args.action}")


def send_command(
    host: str,
    port: int,
    command: Dict[str, Any],
    timeout_s: float,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    payload = (
        json.dumps(
            command,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )

    with socket.create_connection((host, port), timeout=max(timeout_s, 0.2)) as sock:
        sock.settimeout(max(timeout_s, 0.2))
        sock.sendall(payload)
        data = b""
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            data += chunk
            if b"\n" in data:
                break

    if not data:
        return None, None

    line = data.split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
    if not line:
        return None, None

    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return None, line
    return parsed, line


def main() -> int:
    args = build_parser().parse_args()
    try:
        command = build_command(args)
    except Exception as exc:
        print(
            json.dumps(
                {"type": "runtime_ops_error", "ok": False, "error": str(exc)},
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 2

    try:
        ack_json, ack_line = send_command(
            host=args.host,
            port=int(args.port),
            command=command,
            timeout_s=float(args.timeout),
        )
    except OSError as exc:
        print(
            json.dumps(
                {
                    "type": "runtime_ops_error",
                    "ok": False,
                    "error": str(exc),
                    "next_step": "Check control port listener and COM occupancy.",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 3

    if ack_json is not None:
        print(json.dumps(ack_json, ensure_ascii=False), flush=True)
        if ack_json.get("ok") is False:
            return 4
        return 0

    if ack_line is not None:
        print(
            json.dumps(
                {"type": "runtime_ops_ack", "ok": True, "raw": ack_line},
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0

    print(
        json.dumps(
            {
                "type": "runtime_ops_ack",
                "ok": True,
                "raw": None,
                "note": "No response line received (write-only mode is possible).",
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
