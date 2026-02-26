---
name: self-verify-gate
description: Run release-gate verification for the serial-adapter plugin before publish or merge. Use when validating install/runtime health, semantic control behavior, sticky bridge session behavior, hardware telemetry/control E2E, and OpenClaw/npm compliance readiness.
---

# Self Verify Gate

Run this skill before any npm publish or merge to `main`.

## Execute

From plugin repo root, run:

```powershell
npm run preflight-runtime
npm run self-verify
```

Parse the JSON result and decide from these fields:

- `preflight.pass`: runtime/auth/config/toolchain gate.
- `publish_ready`: true means packaging/install/compliance gates are green.
- `merge_main_ready`: true means publish gate + semantic gate + hardware gate are green.
- `dynamic_session_path.session_sticky`: true means repeated semantic calls reuse the same bridge session.
- `hardware_path.diagnosis`: exact cause when telemetry/control is not fully validated.

## Decision policy

1. Stop release if `publish_ready=false`.
2. Stop merge if `merge_main_ready=false`.
3. If `hardware_path.diagnosis=serial_silent_no_telemetry_bytes`, fix firmware/telemetry output first, then rerun.
4. Publish only after bumping version and rerunning `npm run self-verify`.
