# Long-Term Optimization Roadmap

This roadmap targets the recurring failure classes seen in production-like usage:
- environment/path drift
- auth token expiry/reuse
- config schema drift
- plugin install/uninstall conflicts
- COM resource contention
- firmware/protocol mismatch
- weak verification discipline

## North-star outcomes

1. One-command health gate returns machine-readable pass/fail.
2. Semantic control remains stable across long sessions (no repeated handshake loops).
3. Upload/runtime COM arbitration works predictably on single-port devices.
4. Failures are diagnosable in one step from structured logs and check output.
5. Release decisions are gated by real hardware + semantic + compliance checks.

## Phase 1 (Now): Guardrails and reproducibility

Status:
- Implemented `scripts/preflight_runtime_guard.ps1`
- Implemented `scripts/self_verify_gate.ps1`

Goals:
- Fail fast on invalid env/auth/config before running expensive tests.
- Produce one JSON report for release readiness (`publish_ready`, `merge_main_ready`).

Exit criteria:
- Every release candidate includes `npm run self-verify` report artifact.
- No manual publish/merge without green gate.

## Phase 2: Protocol and telemetry stability

Goals:
- Define explicit firmware capability handshake contract (`status`, `capabilities`, telemetry mode, stop semantics).
- Add protocol version negotiation and compatibility matrix.
- Distinguish clearly:
  - control accepted
  - control applied
  - state verified

Implementation items:
- Add firmware profile tags in telemetry/ACK (`fw_profile`, `protocol_version`).
- Add stricter ACK schema in bridge and serial tools.
- Add fallback command translation by profile (UNO basic vs IMU firmware profile).

Exit criteria:
- `serial_stop` verification failures always include deterministic reason code.
- IMU and servo capability detection becomes profile-driven, not heuristic-only.

## Phase 3: COM arbitration hardening

Goals:
- Treat COM as leased shared resource with explicit ownership and transitions.
- Support predictable upload/runtime switch without gateway restarts.

Implementation items:
- Add `runtime lease` state machine with explicit transitions:
  - `active` -> `yielding` -> `paused` -> `reclaiming` -> `active`
- Persist last known stable device mapping (port + VID/PID + profile) for reconnect.
- Add bounded control queue policy docs and metrics.

Exit criteria:
- Upload flow succeeds with automatic pause/resume in repeated loops.
- Runtime reconnect after upload is automatic and logged with cause tags.

## Phase 4: Semantic E2E quality

Goals:
- Ensure user natural language control is validated against real state change.
- Prevent false positives where command text succeeds but hardware state does not.

Implementation items:
- Expand semantic gate scenarios:
  - move left/right
  - stop
  - read IMU summary
- Require post-action state evidence in report.
- Add confidence score for each semantic action.

Exit criteria:
- Semantic gate fails closed when state evidence is missing.
- Reduced ambiguity in "command sent vs command took effect."

## Phase 5: Operational maturity

Goals:
- Reduce repeated troubleshooting effort across machines/operators.

Implementation items:
- Persist and compare previous gate reports (regression detection).
- Add troubleshooting codebook keyed by diagnosis code.
- Add release check artifact template in CI/local workflow.

Exit criteria:
- Most incidents resolved from diagnosis codebook without ad-hoc deep dive.

## Metrics to track each release

- Gate pass rate (`publish_ready`, `merge_main_ready`)
- Mean time to diagnose failures
- Token/auth related failures per week
- COM contention failures per week
- Semantic action verified-success rate
- Telemetry availability ratio (`frames > 0`, `ax/ay/az` present)

## Release policy (recommended)

- Allow npm publish only when `publish_ready=true`.
- Allow merge to `main` only when `merge_main_ready=true`.
- If hardware unavailable, publish can proceed only with explicit `no-hardware` tag and documented risk.
