# Serial Adapter v3

## Overview

`serial_adapter` is a Universal Telemetry Adapter that ingests line-delimited
telemetry from wired serial devices and exposes it to local observers over TCP.
It supports real-time telemetry broadcasting, real-time control input, and
observer APIs for automation, LLM tooling, and analysis.

## Features

- Serial (wired) transport ingestion
- TCP transport for telemetry and control integration
- Fragment-safe `RingBuffer` frame assembly
- Non-blocking polling APIs (`poll`, `poll_all`)
- Observer callback registration (`register_callback`)
- Structured frames with metadata (`timestamp`, `raw`, `parsed`, `meta`)
- Rolling statistics (`mean`, `min`, `max`, `delta`)
- Backward-compatible `read()` alias

## Supported Transports

- Serial transport (device telemetry ingress)
- TCP telemetry transport (read-only broadcast)
- TCP control transport (write-only command ingress)

## Default Ports

- Telemetry port: `localhost:9000` (read-only broadcast)
- Control port: `localhost:9001` (write-only command input)

Note:
- Example scripts default to the split-port layout above.
- If your runtime uses a single combined TCP port, point both clients to the
  same configured adapter port via environment variables.

## Telemetry Data Format

Each complete frame is emitted as a JSON object:

```json
{
  "timestamp": 1735689600.123,
  "raw": "{\"value\":42,\"motor_pwm\":100}",
  "parsed": {
    "value": 42,
    "motor_pwm": 100
  },
  "meta": {
    "size": 29,
    "source": "serial"
  },
  "value": 42,
  "motor_pwm": 100
}
```

Fields:
- `timestamp`: Unix timestamp (float)
- `raw`: Raw frame text
- `parsed`: Parsed JSON dict when valid, otherwise `null`
- `meta.size`: Raw frame byte size
- `meta.source`: `"serial"`

## Control Command Format

Control input is JSON-line based:

```json
{"motor_pwm":100}
```

## Basic Usage

```python
from plugins.serial_adapter.plugin import SerialAdapter

adapter = SerialAdapter(
    port="/dev/ttyUSB0",
    baudrate=115200,
    buffer_size=512 * 1024,
    max_frames=10,
    frame_delimiter=b"\n",
    tcp_host="127.0.0.1",
    telemetry_port=9000,
    control_port=9001,
    enable_tcp=True,
)

adapter.connect()          # starts reader + TCP server
frame = adapter.poll()     # non-blocking; returns None or structured frame
frames = adapter.poll_all()
stats = adapter.get_statistics()
latest = adapter.get_latest_frame()
history = adapter.get_last_n_frames(5)

adapter.disconnect()
```

## Example Clients

- Telemetry print client: `plugins/serial_adapter/examples/tcp_client_print.py`
- Control command client: `plugins/serial_adapter/examples/tcp_client_send_cmd.py`
- Telemetry monitor client: `plugins/serial_adapter/examples/tcp_monitor.py`
- Control command client (default `{"target_velocity":1.5}`):
  `plugins/serial_adapter/examples/tcp_control.py`

## Example Usage

Start telemetry monitor (read telemetry frames from `9000`):

```bash
python plugins/serial_adapter/examples/tcp_monitor.py --host 127.0.0.1 --port 9000
```

Send control command to `9001` and verify response behavior:

```bash
python plugins/serial_adapter/examples/tcp_control.py --host 127.0.0.1 --port 9001
```

Notes:
- In split-port mode, the control port is write-only. `tcp_control.py` reports
  "no response received" as expected behavior after successful send.
- To verify control effects, observe telemetry output with `tcp_monitor.py`.
