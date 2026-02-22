#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
from typing import Any, Dict, Optional


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send control command to control port.")
    parser.add_argument("--host", default="127.0.0.1", help="Control host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9001, help="Control port (default: 9001)")
    parser.add_argument(
        "--command",
        default='{"target_velocity":1.5}',
        help='JSON command payload (default: {"target_velocity":1.5})',
    )
    parser.add_argument(
        "--response-timeout",
        type=float,
        default=0.5,
        help="Seconds to wait for optional response (default: 0.5)",
    )
    return parser


def _recv_one_line(sock: socket.socket, timeout_s: float) -> Optional[str]:
    if timeout_s <= 0:
        return None

    sock.settimeout(timeout_s)
    buffer = b""
    while True:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            return None
        if not chunk:
            return None
        buffer += chunk
        if b"\n" in buffer:
            raw_line, _ = buffer.split(b"\n", 1)
            text = raw_line.decode("utf-8", errors="replace").strip()
            return text or None


def run(host: str, port: int, command: Dict[str, Any], response_timeout: float) -> None:
    payload = (
        json.dumps(
            command,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )

    print(f"[control] connecting control endpoint: {host}:{port}", flush=True)
    with socket.create_connection((host, port), timeout=5.0) as sock:
        sock.sendall(payload)
        print(f"[control] sent command: {json.dumps(command, ensure_ascii=False)}", flush=True)

        response = _recv_one_line(sock, timeout_s=response_timeout)
        if response is None:
            print(
                "[control] no response received (expected for write-only control port).",
                flush=True,
            )
            return

        try:
            parsed = json.loads(response)
        except json.JSONDecodeError:
            print(f"[control] response: {response}", flush=True)
            return
        print(f"[control] response json: {json.dumps(parsed, ensure_ascii=False)}", flush=True)


def main() -> None:
    args = build_parser().parse_args()
    try:
        command = json.loads(args.command)
    except json.JSONDecodeError as exc:
        print(f"[control] invalid JSON command: {exc}", flush=True)
        return

    if not isinstance(command, dict):
        print("[control] command must be a JSON object", flush=True)
        return

    try:
        run(args.host, args.port, command, response_timeout=float(args.response_timeout))
    except OSError as exc:
        print(f"[control] connection error: {exc}", flush=True)


if __name__ == "__main__":
    main()
