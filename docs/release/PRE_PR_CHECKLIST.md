# Pre-PR Checklist (Must Stop Before PR)

This plugin is **not** auto-PRed.  
Before opening any PR, run this checklist and review results together.

## 1) Runtime and Port Basics

- [ ] `openclaw gateway status` shows gateway reachable.
- [ ] `serial-adapter` plugin is loaded and enabled.
- [ ] `COM` is not occupied by Arduino IDE Serial Monitor/uploader.
- [ ] `telemetryPort` (`9000`) and `controlPort` (`9001`) are listening.

## 2) Observer Path (No Raw Flood to LLM)

- [ ] Telemetry stream receives continuous frames.
- [ ] Non-JSON line telemetry (for example `ax:... ay:...`) is parsed into `parsed.ax/ay/az`.
- [ ] Summary/observer bridge outputs low-rate summaries only (not per-frame raw to LLM).

## 3) Control Path and Safety

- [ ] `serial_send` accepts JSON command (for example `{"motor_pwm":1200}`).
- [ ] `serial_send` accepts raw shorthand (`90`, `A90`, `P1500`) and reaches device.
- [ ] `serial_pause` can release COM before upload.
- [ ] `serial_resume` can reclaim COM after upload.
- [ ] Allowlist/rate-limit still apply to unsafe commands.

## 4) Upload Conflict Handling

- [ ] During upload, runtime is paused (no full gateway exit required).
- [ ] After upload, runtime reconnects and telemetry resumes.
- [ ] If COM is occupied, error message clearly tells user to close occupying apps.

## 5) Minimal Verification Commands

```powershell
# in repo root
powershell -ExecutionPolicy Bypass -File scripts/quick_check.ps1 -Json
powershell -ExecutionPolicy Bypass -File scripts/preflight_runtime_guard.ps1
powershell -ExecutionPolicy Bypass -File scripts/self_verify_gate.ps1
python -m pytest tests/test_tcp_server.py tests/test_adapter.py
```

Optional hardware live checks:

```powershell
# telemetry snapshot
python examples/tcp_client_print.py --host 127.0.0.1 --port 9000

# servo + status without PowerShell JSON quoting issues
python examples/runtime_ops.py status
python examples/runtime_ops.py servo --angle 90
```

## 6) Mandatory Discussion Gate

Before PR:

- [ ] Review this checklist output with teammate(s).
- [ ] Confirm target branch and PR scope (no unrelated files).
- [ ] Confirm known limitations are documented in README.
- [ ] Confirm: "Proceed to PR" approval is explicitly given.

If any box is unchecked: do not open PR.
