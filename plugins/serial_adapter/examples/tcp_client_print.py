#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
from typing import Optional


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Print incoming telemetry JSON lines.")
    parser.add_argument("--host", default="127.0.0.1", help="Telemetry host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9000, help="Telemetry port (default: 9000)")
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Print raw lines without JSON pretty formatting",
    )
    return parser


def print_line(raw_line: bytes, raw_mode: bool) -> None:
    text = raw_line.decode("utf-8", errors="replace").strip()
    if not text:
        return
    if raw_mode:
        print(text, flush=True)
        return

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        print(text, flush=True)
        return

    print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)


def run(host: str, port: int, raw_mode: bool) -> None:
    print(f"Connecting telemetry stream: {host}:{port}", flush=True)
    with socket.create_connection((host, port), timeout=5.0) as sock:
        sock.settimeout(1.0)
        buffer = b""
        while True:
            chunk: Optional[bytes]
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue

            if not chunk:
                print("Server closed connection.", flush=True)
                break

            buffer += chunk
            while b"\n" in buffer:
                raw_line, buffer = buffer.split(b"\n", 1)
                print_line(raw_line, raw_mode=raw_mode)


def main() -> None:
    args = build_parser().parse_args()
    try:
        run(args.host, args.port, raw_mode=args.raw)
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    except OSError as exc:
        print(f"Connection error: {exc}", flush=True)


if __name__ == "__main__":
    main()

