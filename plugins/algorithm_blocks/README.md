# Algorithm Blocks Plugin Layer

## Purpose

`plugins/algorithm_blocks/` provides a modular processing layer for telemetry frames coming from `SerialAdapter`.
It allows LLM workflows, Python scripts, and external tools to apply signal-processing and control algorithms in a safe, composable pipeline.

## Architecture

```text
SerialAdapter -> RingBuffer -> AlgorithmPipeline -> TCP/LLM/Control/External tools
```

Each block is a reusable Lego-style unit implementing the `AlgorithmBlock` interface:

- `initialize(config)`
- `process(frame) -> dict`
- `reset()`
- `get_state() -> dict`

Rules:

- Input frame is never modified in-place
- `process()` always returns a new frame dict
- Runtime memory is bounded per block

## Included Blocks

- `FFTBlock` (`fft_block.py`): windowed FFT with dominant-frequency extraction
- `MovingAverageBlock` (`moving_average_block.py`): bounded O(1) moving average
- `PIDBlock` (`pid_block.py`): scalar PID controller output
- `KalmanBlock` (`kalman_block.py`): 1D scalar Kalman filter

## Pipeline Manager

`AlgorithmPipeline` (`pipeline.py`) supports:

- Ordered block execution
- Dynamic `register_block` / `remove_block`
- Thread-safe processing
- Per-block timing/error statistics

## LLM-Friendly API

`llm_api.py` exposes:

- `create_pipeline(config)`
- `add_block(pipeline, type, config)`
- `remove_block(pipeline, name)`
- `process_frame(pipeline, frame)`

## Python Example

```python
from plugins.algorithm_blocks.llm_api import create_pipeline, add_block, process_frame

pipeline = create_pipeline({"timing_window": 256})
add_block(pipeline, type="moving_average", config={
    "name": "ma",
    "input_key": "value",
    "output_key": "value_ma",
    "window_size": 8,
})
add_block(pipeline, type="kalman", config={
    "name": "kf",
    "input_key": "value_ma",
    "output_key": "value_kalman",
})

frame = {"value": 1.2, "timestamp": 1735689600.0}
enhanced = process_frame(pipeline, frame)
```

## SerialAdapter Integration Example

Run:

```bash
python -m plugins.algorithm_blocks.example_pipeline_with_serial --port /dev/ttyUSB0 --baudrate 115200
```

## Self Test

Run:

```bash
python -m plugins.algorithm_blocks.self_test
```
