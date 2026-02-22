# OpenClaw Serial Adapter v0.3.0 Stable Release

## Summary of Features

- RingBuffer-based serial frame reconstruction with fragmentation handling
- Structured telemetry frames (`timestamp`, `raw`, `parsed`, `meta`)
- Split TCP channels:
  - Telemetry broadcast: `9000` (read-only)
  - Control input: `9001` (write-only)
- Observer APIs:
  - `poll()`
  - `poll_all()`
  - `register_callback()`
  - `get_latest_frame()`
  - `get_last_n_frames()`
  - `get_statistics()`
  - `get_status()`
- Safety controls:
  - command allowlist
  - optional unsafe passthrough
  - control rate limiting (`max_control_rate`)
- Runtime status reporting (rx/tx rates, client count, buffer usage, accepted/rejected controls)
- Standalone test suite including self-test, stress test, and 10-minute stability test

## Stability Test Results

10-minute stability test passed (`100Hz` telemetry stream, concurrent telemetry/control TCP clients):

- frames sent: `59999`
- frames received: `59999`
- frames dropped: `0`
- control commands sent: `6004`
- no crash: `true`
- no deadlock: `true`
- no thread exit: `true`
- ring buffer within configured size: `true`
- memory stable: `true`

## Known Limitations

- Control port is write-only by design; no ACK payload is returned to control clients.
- Telemetry stream is local TCP plaintext JSON; no TLS/auth layer is included in this plugin.
- JSON payloads must be newline-delimited and UTF-8 encoded.

## Example Commands

Run plugin self-test:

```bash
python -m plugins.serial_adapter.self_test
```

Run 10-minute stability test:

```bash
python plugins/serial_adapter/stability_test.py
```

Monitor telemetry:

```bash
python plugins/serial_adapter/examples/tcp_monitor.py --host 127.0.0.1 --port 9000
```

Send control command:

```bash
python plugins/serial_adapter/examples/tcp_control.py --host 127.0.0.1 --port 9001 --command "{\"target_velocity\":1.5}"
```
