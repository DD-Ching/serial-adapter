# openclaw_ts_bridge

LLM-friendly observer bridge:
- Reads telemetry JSON-lines from TCP (default `127.0.0.1:9000`)
- Processes locally with `AlgorithmPipeline + SummarizerBlock` (optional PID)
- Emits low-frequency compact summaries only (default every `1000ms`)

## Run

```bash
node plugins/openclaw_ts_bridge/bridge.js
```

```bash
node plugins/openclaw_ts_bridge/bridge.js --config plugins/openclaw_ts_bridge/config.json
```

## Summary Output Schema

Every `interval_ms`, bridge prints exactly:

```json
{
  "type": "summary",
  "ts": 1735689600123,
  "n": 50,
  "keys": {
    "velocity": { "mean": 5.1, "delta": 0.2, "min": 4.8, "max": 5.4 },
    "pos": { "mean": 93.0, "delta": -1.0, "min": 90.0, "max": 98.0 }
  },
  "events": {
    "stable": false,
    "spike": false,
    "oscillating": true
  }
}
```

Meaning:
- `n`: frames processed since last summary interval
- `keys`: compact numeric features only
- `events`: cheap state flags for agent logic

## Event Detection (cheap + configurable)

Config path: `summary.events` in `config.json`

- `stable`: `abs(delta) < stable_delta_threshold` for `stable_required_windows` consecutive summaries
- `spike`: any key has `abs(delta) > spike_delta_threshold`
- `oscillating`: aggregate delta sign flips at least `oscillating_flip_threshold` times within `oscillating_window` summaries

Default thresholds:

```json
{
  "stable_delta_threshold": 0.25,
  "stable_required_windows": 3,
  "spike_delta_threshold": 3.0,
  "oscillating_window": 6,
  "oscillating_flip_threshold": 3
}
```

## Control Plane (stdin)

One JSON command per line while bridge runs.

Examples:

```json
{"cmd":"set_keys","keys":["pos","velocity"]}
{"cmd":"set_window","window":32}
{"cmd":"set_param","block_name":"events","key":"spike_delta_threshold","value":1.5}
```

ACK shape:

```json
{"type":"control_ack","ok":true,"cmd":"set_window","result":{"applied":true},"state":{...}}
```

## LLM Safe Control (low-rate)

Use `plugins/openclaw_ts_bridge/send_llm_command.js` for agent-facing control.

LLM command schema:

```json
{"cmd":"set","target":"target_velocity|motor_pwm|servo_pos","value":1.23}
```

Optional safe stop:

```json
{"cmd":"stop"}
```

This layer enforces:
- target allowlist when `unsafe_passthrough=false` (default)
- LLM-side rate limit (default `5 cmd/sec`) before sending to control port

Examples:

1) `servo_pos` 0 / 90 / 180

```bash
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target servo_pos --value 0
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target servo_pos --value 90
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target servo_pos --value 180
```

2) `target_velocity` 1.5

```bash
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target target_velocity --value 1.5
```

3) `stop`

```bash
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd stop
```

Output ACK shape:

```json
{
  "type": "llm_command_ack",
  "ok": true,
  "input": {"cmd":"set","target":"servo_pos","value":90},
  "translated": {"servo_angle":90},
  "send": {"sent": true, "response": null},
  "limiter": {"maxCommandsPerSec":5,"inCurrentWindow":1,"remaining":4}
}
```

## Notes

- No per-frame output.
- Summary is interval-throttled only.
- Ctrl+C exits cleanly and prints `bridge_shutdown`.
