# OpenClaw Serial Adapter

Universal telemetry adapter plugin for OpenClaw, supporting serial device ingestion with buffered frame parsing and split TCP interfaces for telemetry and control.

## Overview

`openclaw-serial-adapter` reads line-delimited serial telemetry, reconstructs fragmented frames with a ring buffer, and exposes data to local clients and automation tools.

## Features

- RingBuffer-based frame assembly for fragmented serial input
- TCP telemetry stream (read-only broadcast, default `9000`)
- TCP control channel (write-only commands, default `9001`)
- Observer API (`poll`, `poll_all`, `register_callback`, `get_latest_frame`, `get_last_n_frames`)
- Control safety enforcement (`unsafe_passthrough`, allowlist, rate limiting)
- Runtime status reporting (`get_status`)
- Stability tested with long-duration 100Hz telemetry run

## Installation

1. Clone repository:

```bash
git clone https://github.com/DD-Ching/openclaw-serial-adapter
cd openclaw-serial-adapter
```

2. Ensure Python 3.10+ is available.

3. Run plugin self-test:

```bash
python -m plugins.serial_adapter.self_test
```

## Usage

### Monitor Telemetry

```bash
python plugins/serial_adapter/examples/tcp_monitor.py --host 127.0.0.1 --port 9000
```

### Send Control Command

```bash
python plugins/serial_adapter/examples/tcp_control.py --host 127.0.0.1 --port 9001 --command "{\"target_velocity\":1.5}"
```

## Configuration Options

`SerialAdapter(...)` supports:

- `port`: serial device path
- `baudrate`: serial baud rate
- `buffer_size`: ring buffer size in bytes (default `512*1024`)
- `frame_delimiter`: frame delimiter bytes/string (default newline)
- `max_frames`: in-memory frame history limit (default `10`)
- `tcp_host`: TCP bind host (default `127.0.0.1`)
- `telemetry_port`: telemetry TCP port (default `9000`)
- `control_port`: control TCP port (default `9001`)
- `enable_tcp`: enable/disable TCP servers
- `unsafe_passthrough`: allow all control keys when `True` (default `False`)
- `allowed_commands`: allowlist when passthrough is disabled
- `max_control_rate`: max control commands per second (default `50`)

## Additional Documentation

- Protocol: `docs/protocol.md`
- Architecture: `docs/architecture.md`
- Plugin internals and examples: `plugins/serial_adapter/README.md`
