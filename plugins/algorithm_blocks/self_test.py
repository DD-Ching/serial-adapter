from __future__ import annotations

import math
import time
from typing import Any

import numpy as np

try:
    from plugins.algorithm_blocks.fft_block import FFTBlock
    from plugins.algorithm_blocks.kalman_block import KalmanBlock
    from plugins.algorithm_blocks.llm_api import add_block, create_pipeline, process_frame, remove_block
    from plugins.algorithm_blocks.moving_average_block import MovingAverageBlock
    from plugins.algorithm_blocks.pid_block import PIDBlock
    from plugins.algorithm_blocks.pipeline import AlgorithmPipeline
except ImportError:
    import os
    import sys

    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from plugins.algorithm_blocks.fft_block import FFTBlock
    from plugins.algorithm_blocks.kalman_block import KalmanBlock
    from plugins.algorithm_blocks.llm_api import add_block, create_pipeline, process_frame, remove_block
    from plugins.algorithm_blocks.moving_average_block import MovingAverageBlock
    from plugins.algorithm_blocks.pid_block import PIDBlock
    from plugins.algorithm_blocks.pipeline import AlgorithmPipeline


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _assert_close(actual: float, expected: float, tol: float, message: str) -> None:
    if abs(actual - expected) > tol:
        raise RuntimeError(f"{message}. actual={actual}, expected={expected}, tol={tol}")


def test_fft_block() -> None:
    block = FFTBlock(
        config={
            "input_key": "value",
            "window_size": 32,
            "sample_rate_hz": 32.0,
        },
        name="fft",
    )

    frequency_hz = 4.0
    latest: dict[str, Any] | None = None
    for n in range(32):
        sample = float(np.sin(2.0 * np.pi * frequency_hz * (n / 32.0)))
        latest = block.process({"value": sample, "timestamp": float(n)})

    _assert(isinstance(latest, dict), "FFT block did not return a frame")
    fft_result = latest.get("algorithms", {}).get("fft", {})
    _assert(bool(fft_result.get("ready")), "FFT block should be ready after full window")

    dominant = float(fft_result.get("dominant_frequency_hz", -1.0))
    _assert_close(dominant, frequency_hz, 0.5, "FFT dominant frequency mismatch")


def test_pid_block() -> None:
    pid = PIDBlock(
        config={
            "input_key": "measurement",
            "output_key": "command",
            "setpoint": 10.0,
            "kp": 2.0,
            "ki": 0.5,
            "kd": 0.0,
        },
        name="pid",
    )

    source = {"measurement": 7.0, "timestamp": 1.0}
    out1 = pid.process(source)
    _assert(source == {"measurement": 7.0, "timestamp": 1.0}, "PID block modified input frame in-place")
    _assert_close(float(out1["command"]), 6.0, 1e-6, "PID first output mismatch")

    out2 = pid.process({"measurement": 8.0, "timestamp": 2.0})
    _assert_close(float(out2["command"]), 5.0, 1e-6, "PID second output mismatch")


def test_pipeline_chain() -> None:
    pipeline = AlgorithmPipeline(timing_window=64)
    pipeline.register_block(
        MovingAverageBlock(
            config={
                "input_key": "value",
                "output_key": "value_ma",
                "window_size": 3,
            },
            name="ma",
        )
    )
    pipeline.register_block(
        PIDBlock(
            config={
                "input_key": "value_ma",
                "output_key": "control",
                "setpoint": 5.0,
                "kp": 1.0,
                "ki": 0.0,
                "kd": 0.0,
            },
            name="pid",
        )
    )
    pipeline.register_block(
        KalmanBlock(
            config={
                "input_key": "control",
                "output_key": "control_kalman",
                "measurement_variance": 0.1,
            },
            name="kf",
        )
    )

    final = pipeline.process({"value": 1.0, "timestamp": 1.0})
    final = pipeline.process({"value": 2.0, "timestamp": 2.0})
    original = {"value": 3.0, "timestamp": 3.0}
    final = pipeline.process(original)

    _assert(final is not original, "Pipeline must return a new frame instance")
    _assert("value_ma" in final and "control" in final and "control_kalman" in final, "Pipeline outputs missing")
    _assert_close(float(final["value_ma"]), 2.0, 1e-6, "Moving average output mismatch")
    _assert_close(float(final["control"]), 3.0, 1e-6, "Pipeline PID output mismatch")

    stats = pipeline.get_statistics()
    _assert(stats.get("frames_processed") == 3, "Pipeline processed frame count mismatch")
    _assert("ma" in stats.get("block_metrics", {}), "Pipeline metrics missing MA block")

    removed = pipeline.remove_block("pid")
    _assert(removed, "remove_block should remove existing block")
    removed_again = pipeline.remove_block("pid")
    _assert(not removed_again, "remove_block should return False for missing block")


def test_llm_api_and_performance() -> None:
    pipeline = create_pipeline(
        {
            "timing_window": 128,
            "blocks": [
                {
                    "type": "moving_average",
                    "config": {
                        "name": "ma",
                        "input_key": "value",
                        "output_key": "value_ma",
                        "window_size": 4,
                    },
                }
            ],
        }
    )

    add_block(
        pipeline,
        type="pid",
        config={
            "name": "pid",
            "input_key": "value_ma",
            "output_key": "control",
            "setpoint": 10.0,
            "kp": 1.0,
            "ki": 0.0,
            "kd": 0.0,
        },
    )

    start = time.perf_counter()
    last = None
    for i in range(5000):
        last = process_frame(pipeline, {"value": float(i % 7), "timestamp": float(i)})
    elapsed = time.perf_counter() - start

    _assert(isinstance(last, dict) and "control" in last, "LLM API process_frame output mismatch")

    avg_ms = (elapsed / 5000.0) * 1000.0
    _assert(avg_ms < 1.0, f"Simple block chain must stay under 1ms average, got {avg_ms:.4f}ms")

    stats = pipeline.get_statistics()
    ma_samples = int(stats["block_metrics"]["ma"]["samples"])
    _assert(ma_samples <= 128, "Timing window should remain bounded")

    removed = remove_block(pipeline, "pid")
    _assert(removed, "LLM API remove_block failed")


def run_self_test() -> None:
    test_fft_block()
    test_pid_block()
    test_pipeline_chain()
    test_llm_api_and_performance()
    print("ALGORITHM BLOCKS TEST PASSED")


def main() -> None:
    run_self_test()


if __name__ == "__main__":
    main()
