#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
from typing import Any, Dict


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send JSON control command to adapter.")
    parser.add_argument("--host", default="127.0.0.1", help="Control host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9001, help="Control port (default: 9001)")
    parser.add_argument(
        "--command",
        default='{"motor_pwm":100}',
        help='JSON command payload (default: {"motor_pwm":100})',
    )
    return parser


def run(host: str, port: int, command: Dict[str, Any]) -> None:
    payload = json.dumps(command, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
    message = payload + b"\n"

    print(f"Connecting control endpoint: {host}:{port}", flush=True)
    with socket.create_connection((host, port), timeout=5.0) as sock:
        sock.sendall(message)
    print(f"Sent command: {json.dumps(command, ensure_ascii=False)}", flush=True)


def main() -> None:
    args = build_parser().parse_args()
    try:
        command = json.loads(args.command)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON command: {exc}", flush=True)
        return

    if not isinstance(command, dict):
        print("Command must be a JSON object.", flush=True)
        return

    try:
        run(args.host, args.port, command)
    except OSError as exc:
        print(f"Connection error: {exc}", flush=True)


if __name__ == "__main__":
    main()

