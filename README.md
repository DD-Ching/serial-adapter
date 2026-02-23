# OpenClaw Serial Adapter

Universal telemetry adapter plugin for OpenClaw, supporting serial device ingestion with buffered frame parsing and split TCP interfaces for telemetry and control.

## Overview

`@openclaw/serial-adapter` reads line-delimited serial telemetry, reconstructs fragmented frames with a ring buffer, and exposes data to local clients and automation tools.

The TypeScript plugin spawns a Python subprocess that handles serial I/O and TCP servers, then bridges telemetry and control through OpenClaw tool registrations.

## Features

- RingBuffer-based frame assembly for fragmented serial input
- TCP telemetry stream (read-only broadcast, default `9000`)
- TCP control channel (write-only commands, default `9001`)
- Auto serial-port probing with best-effort UNO/USB-serial matching
- Observer API (`poll`, `poll_all`, `register_callback`, `get_latest_frame`, `get_last_n_frames`)
- Control safety enforcement (`unsafe_passthrough`, allowlist, rate limiting)
- Built-in motion templates (`slow_sway`, `fast_jitter`, `sweep`, `center_stop`)
- Runtime status reporting (`get_status`)
- Stability tested with long-duration 100Hz telemetry run

## Installation

### Option A (Windows recommended): Manual install

Use this path when `openclaw plugins install` fails on Windows with spawn-related errors (for example `spawn EINVAL` or `Failed to start CLI`).

```powershell
git clone https://github.com/DD-Ching/openclaw-serial-adapter.git "$HOME\.openclaw\extensions\serial-adapter"
cd "$HOME\.openclaw\extensions\serial-adapter"
npm install --omit=dev --ignore-scripts
```

### Option B: Install via OpenClaw CLI

```bash
openclaw plugins install <path-or-spec>
```

Examples:

```bash
openclaw plugins install C:\path\to\openclaw-serial-adapter
openclaw plugins install /path/to/openclaw-serial-adapter
```

Note:
- Registry install by package name only works after this plugin is published to npm.
- In Windows environments with unstable npm spawn behavior, prefer Option A.

### Verify installation

```bash
openclaw plugins doctor
openclaw plugins list --enabled --verbose
openclaw plugins info serial-adapter --json
```

### Prerequisites

- Python 3.10+ with `pyserial` installed on the host machine
- Node.js 18+
- OpenClaw CLI configured locally

## Plugin Configuration

Add to your OpenClaw config (`openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "serial-adapter": {
        "enabled": true,
        "config": {
          "autoDetectSerialPort": true,
          "portHints": ["uno", "arduino", "ch340"],
          "baudrate": 115200,
          "telemetryPort": 9000,
          "controlPort": 9001,
          "host": "127.0.0.1"
        }
      }
    }
  }
}
```

### Config Options

| Option | Type | Default | Description |
|---|---|---|---|
| `serialPort` | string | none | Serial device path. If omitted, provide `port` in `serial_connect`. |
| `autoDetectSerialPort` | boolean | `true` | Auto-detect a likely serial port when `serialPort` is missing. |
| `portHints` | string[] | `["arduino","uno","ch340","cp210","ftdi","usb serial","ttyusb","ttyacm","com"]` | Hint list used for auto-detection scoring. |
| `baudrate` | number | `115200` | Serial baud rate |
| `telemetryPort` | number | `9000` | TCP telemetry broadcast port |
| `controlPort` | number | `9001` | TCP control command port |
| `host` | string | `127.0.0.1` | TCP bind host |
| `pythonPath` | string | `python3` | Python interpreter path |
| `unsafePassthrough` | boolean | `false` | Allow all control keys |
| `allowedCommands` | string[] | `["motor_pwm", "target_velocity"]` | Command allowlist |
| `maxControlRate` | number | `50` | Max control commands per second |

## Registered Tools

| Tool | Description |
|---|---|
| `serial_probe` | List detected serial ports and suggest the best candidate |
| `serial_connect` | Connect to serial device and start adapter |
| `serial_poll` | Read available telemetry frames |
| `serial_send` | Send a control command to serial device |
| `serial_motion_template` | Run built-in servo motion templates |
| `serial_status` | Get adapter runtime status |

## AI Prompt Examples

Use prompts like these with your OpenClaw agent:

1. Connect and check status:
```text
Call serial_probe first and pick the suggested port, then run serial_connect with baudrate 115200, then call serial_status.
```

2. Servo sweep test (visible frequency / PWM change):
```text
Send motor_pwm commands in steps: 1200, 1400, 1600, 1700.
Wait 2 seconds between each step.
After each step, call serial_poll and summarize latest telemetry.
```

3. Safe stop:
```text
Send a final command {"motor_pwm": 0}, then call serial_status.
```

4. Run template motion directly:
```text
Run serial_motion_template with template "slow_sway", repeats 2, intervalMs 400.
```

## Prototype Status

- Current implementation is closer to your **Prototype B** baseline:
  - includes ring buffer
  - includes built-in motion templates
  - includes auto probe + best-effort auto connect
- It does **not** yet include closed-loop self-stabilizing controllers (PID/LQR/MPC).
- If you need autonomous balancing/stabilization, add firmware feedback fields (angle/rate/error) and a closed-loop controller module on top of this transport layer.

## Safety Notes

- Keep `unsafePassthrough` as `false` unless you explicitly need unrestricted control keys.
- Use `allowedCommands` to limit accepted control keys.
- Keep a conservative `maxControlRate` for initial hardware tests.

## Development

### Run self-test

```bash
python -m python.self_test
```

### Monitor telemetry (standalone)

```bash
python examples/tcp_monitor.py --host 127.0.0.1 --port 9000
```

### Send control command (standalone)

```bash
python examples/tcp_control.py --host 127.0.0.1 --port 9001 --command "{\"target_velocity\":1.5}"
```

### Build TypeScript

```bash
npm install
npm run build
```

## Architecture

```
OpenClaw Gateway
  -> serial-adapter plugin (TypeScript)
       -> register() registers tools + service
       -> service.start() starts python subprocess
            -> Python SerialAdapter
                 -> Serial port reader thread
                 -> TCP telemetry server :9000
                 -> TCP control server :9001
       -> serial_poll tool reads :9000
       -> serial_send tool writes :9001
       -> service.stop() terminates subprocess
```

## Additional Documentation

- Protocol: `docs/protocol.md`
- Architecture: `docs/architecture.md`
