# Serial Adapter Architecture

## System Flow

```text
Serial Device -> SerialAdapter Reader Thread -> RingBuffer -> Frame Builder
           -> Observer API (poll/callback/history/statistics)
           -> TCP Telemetry Server (broadcast)
           -> TCP Clients (monitor/analysis)

TCP Control Clients -> TCP Control Server -> Safety Filter + Rate Limiter -> Serial Write
```

## Core Components

- `SerialAdapter`:
  - Owns serial transport, ring buffer, observer state, status counters
  - Publishes structured frames and handles control commands
- `RingBuffer`:
  - Accumulates byte fragments
  - Emits complete frames only when delimiter is present
- `TcpTelemetryServer`:
  - Broadcast-only channel for telemetry consumers
- `TcpControlServer`:
  - Command ingress channel for control payloads
- `RollingStatistics`:
  - Rolling summary (`mean`, `min`, `max`, `delta`) for numeric values

## Thread Model

- Reader thread:
  - Non-blocking serial reads
  - Parses complete frames from ring buffer
  - Publishes frames to observer queue + TCP telemetry
- TCP server thread(s):
  - Handles telemetry client connections and non-blocking broadcast
  - Handles control client command ingestion
- Optional client/test threads:
  - Used in tests/examples for telemetry monitoring and control sending

Design intent:

- Main telemetry path remains non-blocking
- Callback errors are isolated and do not stop ingestion
- TCP I/O and serial ingestion are decoupled

## Safety Controls

Default control safety settings:

- `unsafe_passthrough = false`
- `allowed_commands = ["motor_pwm", "target_velocity"]`
- Commands with keys outside allowlist are rejected

When `unsafe_passthrough = true`:

- Allowlist validation is bypassed
- All JSON object keys are permitted (still subject to rate limiting)

## Rate Limiting Rules

- `max_control_rate = 50` commands per second by default
- Sliding 1-second window using monotonic clock
- Commands above limit are rejected immediately
- Accepted and rejected counts are tracked in runtime status

## Operational Notes

- Telemetry/control split ports prevent channel cross-talk:
  - `9000` telemetry read-only
  - `9001` control write-only
- Combined compatibility mode (`tcp_port`) remains available for legacy use
- Stability tests include long-duration 100Hz telemetry + concurrent control traffic
