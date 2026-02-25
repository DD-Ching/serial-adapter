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

## Stable Quick Path (3 commands)

1) Start runtime (OpenClaw gateway or serial adapter process) so `9000/9001` can listen.

2) Start summary bridge:

```bash
node plugins/openclaw_ts_bridge/bridge.js --config plugins/openclaw_ts_bridge/config.json
```

3) Send low-rate control and inspect ACK:

```bash
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target servo_pos --value 90
```

If control port is not listening, ACK includes explicit `ECONNREFUSED` and `next_step`.

## MPU6050 Minimal Observer

Reads `telemetry:9000` and prints one JSON summary per second (not per frame).

```bash
node plugins/openclaw_ts_bridge/mpu_summary_observer.js --host 127.0.0.1 --port 9000 --interval-ms 1000
```

Optional bounded run:

```bash
node plugins/openclaw_ts_bridge/mpu_summary_observer.js --max-runtime-s 15
```

Output shape:
- `frames`: frames seen in this window
- `parsed_samples`: frames that contained at least one sensor field
- `keys.ax/ay/az` (+ `gx/gy/gz` if present): `mean/min/max/latest`

## Servo MVP (Windows)

1) Start the control bridge first (TCP `9001` -> `COMx` at `115200`):

```bash
node plugins/openclaw_ts_bridge/control_bridge.js --com COM3 --baud 115200
```

2) Send a servo command from LLM-safe sender:

```bash
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target servo_pos --value 90
```

3) Optional: flash UNO with auto COM yield (pause -> upload -> resume):

```bash
node plugins/openclaw_ts_bridge/upload_with_pause.js --com COM3 --fqbn arduino:avr:uno --sketch C:\\path\\to\\sketch
```

Notes:
- `servo_pos` uses MVP plain line protocol: `"<angle>\n"` (for example `90\n`).
- Bridge writes incoming TCP bytes to UNO serial as-is.
- If `9001` is not listening, sender returns machine-readable error with `error_code: "ECONNREFUSED"`.

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
{"cmd":"set_profile","profile":"imu_balance"}
{"cmd":"set_autosave","enabled":true}
{"cmd":"save_state"}
{"cmd":"load_state"}
```

ACK shape:

```json
{"type":"control_ack","ok":true,"cmd":"set_window","result":{"applied":true},"state":{...}}
```

Available observer profiles:
- `low_bandwidth`: lowest token pressure (`ax/ay/az`, slower interval)
- `imu_balance`: IMU + servo posture summary for balancing tasks
- `control_tuning`: servo/motor + IMU summary for control tuning

State persistence:
- Runtime state path default: `plugins/openclaw_ts_bridge/runtime_state.json`
- `set_autosave=true`: each config change auto-persists
- `save_state`: persist immediately
- `load_state`: reload persisted runtime state without restarting bridge

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

MVP servo protocol:
- `servo_pos` translates to plain text line `"<angle>\n"` (for example `0\n`, `90\n`, `180\n`)
- `target_velocity` and `motor_pwm` stay JSON-line payloads

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
  "translated": "90\n",
  "send": {"sent": true, "response": null},
  "limiter": {"maxCommandsPerSec":5,"inCurrentWindow":1,"remaining":4}
}
```

## Notes

- No per-frame output.
- Summary is interval-throttled only.
- Ctrl+C exits cleanly and prints `bridge_shutdown`.
