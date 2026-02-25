# Windows Runtime Playbook (Time-Saver)

This page captures repeated Windows issues and fixed workflows so we do not re-debug the same environment problems.

## 1) Use absolute paths for tools

Do not assume `PATH` is stable across shells.

- Node: `C:\Program Files\nodejs\node.exe`
- OpenClaw CLI: `%APPDATA%\npm\openclaw.cmd`
- Git (if needed): `C:\Program Files\Git\cmd\git.exe`

If `openclaw` is "not recognized", run:

```powershell
$OPENCLAW = "$env:APPDATA\npm\openclaw.cmd"
& $OPENCLAW gateway start
```

## 2) Avoid PowerShell JSON quoting traps

Using inline `--command "{\"servo_pos\":90}"` is easy to break in PowerShell.

Use the helper instead:

```powershell
python examples/runtime_ops.py servo --angle 90
python examples/runtime_ops.py status
python examples/runtime_ops.py raw --line IMU?
```

This avoids shell escaping bugs and emits machine-readable JSON ACK.

## 3) Always check runtime prerequisites first

```powershell
powershell -ExecutionPolicy Bypass -File scripts/quick_check.ps1 -Json
```

This verifies:
- node path/artifacts
- telemetry/control port listening
- pyserial serial-port probe
- installed OpenClaw extension marker freshness (`serial_intent`/`serial_bridge_sync`)

If extension is stale (`openclaw_extension.up_to_date=false`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy_local_extension.ps1 -RestartGateway
```

## 4) COM port ownership rule (single-COM boards)

UNO/most USB-serial boards cannot be monitored and uploaded from two processes at once.

- Upload phase: release COM first (`pause`)
- Runtime phase: resume COM after upload (`resume`)

```powershell
python examples/runtime_ops.py pause --hold-s 30
node plugins/openclaw_ts_bridge/upload_with_pause.js --com COM3 --fqbn arduino:avr:uno --sketch C:\path\to\sketch
python examples/runtime_ops.py resume
```

If occupied, close Arduino Serial Monitor/uploader first.

## 5) Low-noise observer workflow

Do not stream raw high-rate lines into LLM; keep observer summaries low-rate.

```powershell
& "C:\Program Files\nodejs\node.exe" plugins/openclaw_ts_bridge/mpu_summary_observer.js --host 127.0.0.1 --port 9000 --interval-ms 1000
```

## 5b) Set-once persistence (avoid repeated setup)

Bridge control plane now supports persistent state:
- `set_profile`
- `set_keys` / `set_window` / `set_interval_ms`
- `save_state` / `load_state`
- `set_autosave`

Default state file:
- `plugins/openclaw_ts_bridge/runtime_state.json`

## 6) Fast health checks (copy/paste)

```powershell
python examples/runtime_ops.py status
python examples/runtime_ops.py capabilities
python examples/runtime_ops.py servo --angle 90
python examples/runtime_ops.py servo --angle 120
python examples/runtime_ops.py servo --angle 60
python scripts/regression_guard.py --host 127.0.0.1 --control-port 9001 --telemetry-port 9000 --timeout-s 3 --angle 90
```

Expected:
- control ACK has `"ok": true`
- status shows `serial_connected=true`
- summary observer shows `frames > 0` and `ax/ay/az`
