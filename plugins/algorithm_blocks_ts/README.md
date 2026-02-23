# algorithm_blocks_ts

Minimal TypeScript modular blocks layer for OpenClaw-style plugins.

## What it is

- A synchronous, low-latency `AlgorithmPipeline` for telemetry frame processing.
- Plugin-friendly block interface:
  - `init(config)`
  - `process(frame) -> ProcessedFrame`
  - `reset()`
  - `state()`
- Minimal blocks included:
  - `MovingAverageBlock`
  - `PidBlock`
  - `SummarizerBlock` (compact features for LLM observer layer)

Design intent:
- Keep high-rate processing local in Node.
- LLM consumes summaries/features, not full raw high-frequency streams.
- LLM remains observer/decision layer, not high-rate control loop.

## Install and build

```bash
cd plugins/algorithm_blocks_ts
npm install
npm run build
```

## Run tests

```bash
npm test
```

## Run minimal example

```bash
npm run example
```

## Integration note

This package is intended to sit inside an OpenClaw TypeScript plugin:
1. Ingest telemetry frames from serial/tcp adapter.
2. Call `pipeline.process(frame)` in the local plugin runtime.
3. Forward only `features`/summaries to LLM-facing tools.
4. Apply control allowlist + rate limiting before hardware writes.
