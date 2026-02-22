# Serial Adapter Protocol

## Default TCP Ports

- Telemetry port: `9000` (read-only broadcast)
- Control port: `9001` (write-only command ingress)

## Telemetry Frame Schema

Each telemetry frame is sent as a single JSON line (`\n` terminated):

```json
{
  "timestamp": 1735689600.123,
  "raw": "{\"target_velocity\":1.5,\"value\":42}",
  "parsed": {
    "target_velocity": 1.5,
    "value": 42
  },
  "meta": {
    "size": 36,
    "source": "serial"
  },
  "target_velocity": 1.5,
  "value": 42
}
```

Field notes:

- `timestamp` (`float`): frame creation time
- `raw` (`string`): UTF-8 decoded original payload
- `parsed` (`object|null`): parsed JSON object when valid
- `meta.size` (`int`): raw frame byte size
- `meta.source` (`string`): always `"serial"`
- Parsed keys are also merged to top level for compatibility

## Control Command Schema

Control messages are JSON objects sent as JSON lines (`\n` terminated) to port `9001`.

Example:

```json
{"target_velocity":1.5}
```

Default safety policy:

- `unsafe_passthrough = false`
- Allowed keys: `motor_pwm`, `target_velocity`
- Rate limit: `max_control_rate = 50` commands/second

Behavior:

- Invalid JSON or non-object payloads are ignored
- Disallowed keys are rejected
- Excess commands over rate limit are rejected

## JSON Formatting Rules

- Encoding: UTF-8
- Transport framing: one JSON object per line
- Delimiter: newline (`\n`) by default
- No pretty-printing required for wire format
- NaN/Infinity are not allowed in emitted JSON

## Example Messages

Telemetry output sample:

```json
{"timestamp":1735689600.123,"parsed":{"value":10},"meta":{"size":12,"source":"serial"},"value":10}
```

Control input sample:

```json
{"motor_pwm":120}
```

Status API (in-process):

```json
{
  "rx_rate": 100.0,
  "tx_rate": 10.0,
  "connected_clients": 2,
  "ring_buffer_usage_ratio": 0.05,
  "control_commands_accepted": 1234,
  "control_commands_rejected": 3
}
```
