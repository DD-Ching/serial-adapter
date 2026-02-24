#!/usr/bin/env python3
"""CLI entry point for the serial adapter subprocess.

Launched by the TypeScript plugin via an absolute ``python/__main__.py`` path.
Outputs a single JSON ready line to stdout, then blocks until SIGTERM/SIGINT.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading

try:
    from .plugin import SerialAdapter
except ImportError:
    # Allow direct script execution via absolute path:
    #   python path/to/python/__main__.py ...
    # This keeps startup robust even when module cwd/package context differs.
    from plugin import SerialAdapter  # type: ignore[no-redef]

_MISSING_DEPS_MSG = """\
ERROR: Required Python package 'pyserial' is not installed.

Install it with one of:
    pip install pyserial
    uv pip install pyserial
"""


def _check_dependencies() -> None:
    try:
        import serial  # noqa: F401
    except ImportError:
        print(_MISSING_DEPS_MSG, file=sys.stderr)
        sys.exit(1)


def main() -> None:
    _check_dependencies()
    parser = argparse.ArgumentParser(description="Serial Adapter subprocess")
    parser.add_argument("--port", required=True, help="Serial device path")
    parser.add_argument("--baudrate", type=int, default=115200)
    parser.add_argument("--telemetry-port", type=int, default=9000)
    parser.add_argument("--control-port", type=int, default=9001)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    adapter = SerialAdapter(
        port=args.port,
        baudrate=args.baudrate,
        tcp_host=args.host,
        telemetry_port=args.telemetry_port,
        control_port=args.control_port,
    )
    adapter.connect()

    ready_msg = {
        "status": "ready",
        "telemetry_port": args.telemetry_port,
        "control_port": args.control_port,
        "pid": os.getpid(),
    }
    sys.stdout.write(json.dumps(ready_msg) + "\n")
    sys.stdout.flush()

    stop_event = threading.Event()

    def _handle_signal(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        stop_event.wait()
    finally:
        adapter.disconnect()


if __name__ == "__main__":
    main()
