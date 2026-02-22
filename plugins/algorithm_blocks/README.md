# Algorithm Blocks Plugin Layer

## Purpose

`plugins/algorithm_blocks/` provides a modular processing layer for telemetry frames from `SerialAdapter`.
It is designed for LLM workflows, Python scripts, and external tools that need safe, composable, real-time algorithms.

## Architecture

```text
SerialAdapter -> RingBuffer -> AlgorithmPipeline -> TCP/LLM/Control/External tools
```

Each block is a reusable Lego-style unit implementing `AlgorithmBlock`:

- `initialize(config)`
- `process(frame) -> dict`
- `reset()`
- `get_state() -> dict`

Core guarantees:

- Input frame is never modified in-place
- Each `process()` returns a new frame dict
- Runtime memory is bounded per block/pipeline window

## Included Blocks

- `FFTBlock` (`fft_block.py`)
  - Windowed FFT with dominant-frequency extraction
  - Supports `window_type`: `none`, `hamming`, `hann`
- `MovingAverageBlock` (`moving_average_block.py`)
  - O(1) moving average with bounded window
- `PIDBlock` (`pid_block.py`)
  - Scalar PID output with optional output clamping
- `KalmanBlock` (`kalman_block.py`)
  - 1D scalar Kalman filter

## Pipeline Manager

`AlgorithmPipeline` (`pipeline.py`) provides:

- Ordered block execution
- Dynamic block registration/removal
- Thread-safe processing (serialized execution lock)
- Bounded timing metrics window
- Error annotation without pipeline crash

Statistics include:

- frame processed/failed counts
- per-block average/max latency
- pipeline average/max latency
- per-block error counts

## LLM-Friendly API

`llm_api.py` exports:

- `create_pipeline(config)`
- `add_block(pipeline, type, config)`
- `remove_block(pipeline, name)`
- `process_frame(pipeline, frame)`
- `list_supported_blocks()`
- `register_block_type(type_name, factory)`

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

```bash
python -m plugins.algorithm_blocks.example_pipeline_with_serial --port /dev/ttyUSB0 --baudrate 115200
```

## Self Test

```bash
python -m plugins.algorithm_blocks.self_test
```

Test coverage includes:

- FFT and PID correctness
- multi-block pipeline chaining
- LLM API dynamic registration
- thread-safety behavior
- timing/memory-bounded checks
