# Serial Adapter

Universal telemetry adapter plugin for OpenClaw, supporting serial device ingestion with buffered frame parsing and split TCP interfaces for telemetry and control.

## Overview

`serial-adapter` reads line-delimited serial telemetry, reconstructs fragmented frames with a ring buffer, and exposes data to local clients and automation tools.

The TypeScript plugin spawns a Python subprocess that handles serial I/O and TCP servers, then bridges telemetry and control through OpenClaw tool registrations.

## Features

- RingBuffer-based frame assembly for fragmented serial input
- TCP telemetry stream (read-only broadcast, default `9000`)
- TCP control channel (command ingress, default `9001`, with optional ACK response)
- Auto serial-port probing with best-effort UNO/USB-serial matching
- Self-healing bridge sync (`serial_bridge_sync`) for auto-connect + auto-resume flows
- Sticky bridge session semantics: tools reuse the same live bridge session instead of restarting on every command
- Multi-source control arbitration lease (`source_id` + `priority` + `lease_ms`) to avoid command collisions
- Runtime auto-probe handshake (`STATUS?`, `IMU_ON`, `TELEMETRY_ON`, `STREAM_ON`, `IMU?`) to reduce “connected but no telemetry” loops
- Smart probe suppression: when telemetry is already flowing, `serial_quickcheck` skips redundant handshake bursts
- Observer API (`poll`, `poll_all`, `register_callback`, `get_latest_frame`, `get_last_n_frames`)
- Control safety enforcement (`unsafe_passthrough`, allowlist, rate limiting)
- Built-in motion templates (`slow_sway`, `fast_jitter`, `sweep`, `center_stop`)
- Runtime status reporting (`get_status`)
- Stability tested with long-duration 100Hz telemetry run

## Current Component Inventory

Stable and kept:
- TS/Node plugin integration layer: `index.ts`, `src/launcher.ts`, `src/tcp-client.ts`
- Python runtime adapter (transport + safety): `python/` (kept as runtime backend)
- TS algorithm blocks core: `plugins/algorithm_blocks_ts`
- Observer bridge and summary/events: `plugins/openclaw_ts_bridge/bridge.js`
- LLM-safe low-rate control entry: `plugins/openclaw_ts_bridge/send_llm_command.js`
- Minimal TCP-to-COM control bridge (Windows MVP): `plugins/openclaw_ts_bridge/control_bridge.js`

Legacy or optional (kept, not removed):
- Python example scripts in `examples/` and `python/` for direct testing
- Experimental helper scripts under `plugins/openclaw_ts_bridge/` (useful for dev, not required in MVP path)

## MVP Stable Path (Observer + Safe Control)

Goal: read telemetry (`9000`), print low-rate summary, send low-rate control (`9001`) with clear ACK.

Windows note:
- Use `docs/windows-runtime-playbook.md` to avoid repeated PATH/quoting/COM pitfalls.
- Prefer absolute tool paths on Windows shells.

1. Quick self-check (node path, dist artifact, port status, serial probe):

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/quick_check.ps1 -Json
```

macOS/Linux:

```bash
node scripts/quick_self_check.js --json
```

If `openclaw_extension.up_to_date=false`, refresh your installed extension:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy_local_extension.ps1 -RestartGateway
```

2. Start OpenClaw gateway:

```bash
openclaw gateway start
```

3. Start observer summary bridge (1 line/second, fixed schema):

```bash
node plugins/openclaw_ts_bridge/bridge.js --config plugins/openclaw_ts_bridge/config.json
```

4. Strict hardware E2E gate (handshake -> observe -> drive):

```bash
python scripts/hardware_e2e_check.py --host 127.0.0.1 --control-port 9001 --telemetry-port 9000 --observe-s 2.5 --drive-angle 90
```

4b. Semantic E2E gate (LLM text -> plugin intent -> hardware verify):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/semantic_e2e_check.ps1
```

4c. One-command self-verify gate (install/runtime + semantic + hardware + sticky session + compliance):

```powershell
npm run self-verify
```

Runtime-only preflight (faster, before semantic/hardware checks):

```powershell
npm run preflight-runtime
```

Repeatable full validation (single command for recurring checks):

```powershell
npm run validate:repeatable
```

The command prints one JSON report with:
- `publish_ready`: true means packaging/install/compliance gates are green.
- `merge_main_ready`: true means publish gate + semantic gate + hardware gate are all green.
- `dynamic_session_path.session_sticky`: confirms repeated semantic calls reused the same bridge session.
- `hardware_path.diagnosis`: exact reason when IMU/telemetry is not flowing.

5. Send low-rate control command and read machine-readable ACK:

```bash
node plugins/openclaw_ts_bridge/send_llm_command.js --cmd set --target servo_pos --value 90
```

Bridge stability rule (important):
- Once connected, tools keep using the same bridge session.
- If a TCP channel drops, plugin re-attaches channel first (without restarting subprocess/COM) and only restarts as last resort.
- Check session continuity from tool responses: `bridge.session.session_id`.

6. Optional UNO MVP control channel (if you use plain servo angle line protocol):

```bash
node plugins/openclaw_ts_bridge/control_bridge.js --com COM3 --baud 115200
```

## Pre-PR Gate (Required)

Before opening any PR, run and review:

- `docs/release/PRE_PR_CHECKLIST.md`
- `docs/release/OFFICIAL_GUIDELINES_MAP.md`
- `docs/release/LONG_TERM_OPTIMIZATION_ROADMAP.md`

Rule: if checklist is not fully green, stop and fix first.

Baseline marker for this development cycle:
- `docs/release/BASELINE_2026-02-24.md`

## COM Port Guardrail (Upload vs Runtime)

- A single COM port cannot be used by uploader/Serial Monitor and runtime plugin at the same time.
- Upload phase: close runtime monitor/plugin first.
- Runtime phase: close Arduino IDE Serial Monitor/uploader first, then start adapter/bridge.
- On startup failure the plugin now reports available ports and explicit next steps.

### Upload-friendly COM Yield (pause/resume, no full plugin shutdown)

You can now ask runtime to temporarily release COM for upload, then auto/manual resume.

Pause and release COM immediately (hold for 30s):

```bash
python examples/runtime_ops.py pause --hold-s 30
```

Or request a machine-readable yield with requester/reason trace:

```text
call serial_yield(seconds=30, requestedBy="arduino_ide", reason="firmware_upload")
```

Resume COM right after upload:

```bash
python examples/runtime_ops.py resume
```

One-shot upload flow (auto pause/resume around `arduino-cli upload`):

```bash
node plugins/openclaw_ts_bridge/upload_with_pause.js --com COM3 --fqbn arduino:avr:uno --sketch C:\\path\\to\\sketch
```

Check runtime serial status:

```bash
python examples/runtime_ops.py status
python examples/runtime_ops.py capabilities
```

Behavior:
- `pause` closes serial handle but keeps plugin process/TCP ports alive.
- `serial_yield` records who requested yield and why (`runtime_status.com_arbitration.last_yield_request`).
- During pause, adapter does not occupy COM.
- After `resume` (or `hold_s` timeout), adapter retries reopening COM every ~2s.
- Control commands received during COM pause/conflict are queued (bounded queue) and flushed automatically after reconnect.
- If there is no COM conflict, keep runtime normal (no pause/resume needed).

## Installation

### Option A (Windows recommended): Manual install

Use this path when `openclaw plugins install` fails on Windows with spawn-related errors (for example `spawn EINVAL` or `Failed to start CLI`).

```powershell
git clone https://github.com/DD-Ching/serial-adapter.git "$HOME\.openclaw\extensions\serial-adapter"
cd "$HOME\.openclaw\extensions\serial-adapter"
npm install --omit=dev --ignore-scripts
```

### Option B: Install via OpenClaw CLI (official flow)

```bash
openclaw plugins install <path-or-spec>
```

From npm registry (recommended for general users):

```bash
openclaw plugins install serial-adapter
```

Optional pinned version:

```bash
openclaw plugins install serial-adapter@0.3.2
```

Package contents for Option B include:
- core OpenClaw plugin (`dist/` + `python/`)
- observer/control bridge scripts (`plugins/openclaw_ts_bridge/`)
- algorithm blocks runtime build (`plugins/algorithm_blocks_ts/dist/`)

From local path:

```bash
openclaw plugins install C:\path\to\serial-adapter
openclaw plugins install /path/to/serial-adapter
```

Note:
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
- Python auto-selection order:
  - Windows: `.venv` -> `python` -> `py` -> `python3`
  - macOS/Linux: `.venv` -> `python3` -> `python`

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
          "host": "127.0.0.1",
          "toolAutoConnect": true,
          "autoResumeOnUse": true,
          "bridgeAckTimeoutMs": 1200
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
| `toolAutoConnect` | boolean | `true` | Let tools auto-connect when disconnected |
| `autoResumeOnUse` | boolean | `true` | Let tools auto-resume runtime when serial is paused |
| `bridgeAckTimeoutMs` | number | `1200` | ACK timeout for runtime control/status commands |

## Registered Tools

| Tool | Description |
|---|---|
| `serial_probe` | List detected serial ports and suggest the best candidate |
| `serial_connect` | Connect to serial device and start adapter |
| `serial_intent` | Natural-language intent control (left/right/stop/nod/status) |
| `serial_bridge_sync` | Ensure bridge is connected/resumed and return runtime status |
| `serial_quickcheck` | One-shot check: auto-connect (optional) + sample telemetry + IMU detection |
| `serial_poll` | Read telemetry with compact summary (`includeFrames=true` for raw debug) |
| `serial_send` | Send a control command to serial device |
| `serial_stop` | Best-effort stop sequence with telemetry verification |
| `serial_motion_template` | Run built-in servo motion templates |
| `serial_status` | Get runtime status + recent telemetry snapshot summary |
| `serial_pause` | Temporarily release COM for upload |
| `serial_yield` | Arbitration-aware COM yield request (with requester/reason trace) |
| `serial_resume` | Re-open COM after upload |

## AI Prompt Examples

Use prompts like these with your OpenClaw agent:

1. Stable bridge handshake (recommended first step):
```text
Run serial_bridge_sync with autoConnect true, autoResume true.
Return bridge status, runtime_status.degraded, and telemetry_summary only.
```

2. Conversation-native intent control (Telegram style):
```text
When user says things like "往左一點", "往右一點", "停下來", "點點頭", "看一下狀態",
call serial_intent with instruction set to the original sentence.
Do not ask for Arduino syntax unless serial_intent returns intent_unrecognized.
Return brief action + verification summary.
```

3. Connect and detect IMU in one shot:
```text
Run serial_quickcheck with observeMs 1500.
If disconnected, autoConnect should be true.
Return only summary and whether IMU (ax/ay/az or gx/gy/gz) is detected.
```

3b. Connect + probe + drive test in one shot:
```text
Run serial_quickcheck with observeMs 1500, driveAngle 90, triggerProbe true.
Return summary, drive_action, and diagnosis.
```

4. Servo sweep test (visible frequency / PWM change):
```text
Send motor_pwm commands in steps: 1200, 1400, 1600, 1700.
Wait 2 seconds between each step.
After each step, call serial_poll and summarize latest telemetry.
```

5. Raw servo shorthand (MVP):
```text
Use serial_send with command "90" (or "A90"), then call serial_status.
```

6. Safe stop (verified):
```text
Call serial_stop with targetAngle 90 and verifyMs 1200.
If verification.verified is false/null, report "command sent but not verified" (do not claim stopped).
```

7. Run template motion directly:
```text
Run serial_motion_template with template "slow_sway", repeats 2, intervalMs 400.
```

8. LLM behavior guard (avoid "ask-back loop"):
```text
When user asks "can you detect IMU now?", do not ask back.
Call serial_quickcheck immediately and return diagnosis/next_step.
```

## If `serial_stop` Is Not Verified

If `serial_stop` returns `verification.verified=false` and the motor keeps moving, your board firmware is likely running an autonomous loop and ignoring runtime serial commands.

Use the provided reference firmware:

- `firmware/uno_mpu6050_servo_runtime/uno_mpu6050_servo_runtime.ino`
- Board: `Arduino Uno`
- Baud: `115200`

Behavior of this firmware:

- Power-up default is `hold` (no automatic sweep).
- Supports `STOP`, `SWEEP_OFF`, `A90`, `90`, `P1500`.
- Emits JSON telemetry with `ax/ay/az/gx/gy/gz/servo`.

After flashing, run:

```text
serial_quickcheck(observeMs=1200)
serial_stop(targetAngle=90, verifyMs=1200)
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

## Multi-Source Control Arbitration

Control commands may include optional metadata:

- `source_id`: logical command source (for example `serial_intent`, `telegram_agent`, `manual_debug`)
- `priority`: `-100..100` (higher source can preempt lower source lease)
- `lease_ms`: lease duration (`200..120000`)

Behavior:

- Commands with `source_id` acquire/refresh a control lease.
- Anonymous commands (without `source_id`) are blocked while another lease is active.
- Higher-priority sources can preempt lower-priority sources.

Current tool defaults:

- `serial_intent` uses `source_id=serial_intent` by default.
- `serial_stop` and `serial_motion_template` also attach a default source lease.
- `serial_send` supports optional `sourceId/priority/leaseMs` when you need explicit ownership.
- `serial_quickcheck` also supports `sourceId/priority/leaseMs` and can include `driveAngle`.

## Handshake Memory Model (avoid repeated probe loops)

- Runtime keeps handshake/telemetry state in memory (small fixed-size fields in status).
- Auto-probe uses backoff and pauses while external control lease is active.
- Once telemetry is flowing, probe backoff resets and `serial_quickcheck` suppresses repeated probe bursts.
- Memory impact is negligible (a few counters/timestamps/strings, no unbounded buffering beyond existing ring buffer).

## Development

### Run core tests

```bash
python -m pytest tests/test_tcp_server.py tests/test_adapter.py
```

### Run hardware regression guard (observer + control + IMU fields)

```bash
python scripts/regression_guard.py --host 127.0.0.1 --control-port 9001 --telemetry-port 9000 --timeout-s 3 --angle 90
```

### Monitor telemetry (standalone)

```bash
python examples/tcp_monitor.py --host 127.0.0.1 --port 9000
```

### Send control command (standalone)

```bash
python examples/runtime_ops.py set --target target_velocity --value 1.5
python examples/runtime_ops.py servo --angle 90
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
- Windows runtime playbook: `docs/windows-runtime-playbook.md`
