from __future__ import annotations

from typing import Any

from .fft_block import FFTBlock
from .kalman_block import KalmanBlock
from .moving_average_block import MovingAverageBlock
from .pid_block import PIDBlock
from .pipeline import AlgorithmPipeline


_BLOCK_TYPES = {
    "fft": FFTBlock,
    "moving_average": MovingAverageBlock,
    "pid": PIDBlock,
    "kalman": KalmanBlock,
}


def create_pipeline(config: dict[str, Any] | None = None) -> AlgorithmPipeline:
    cfg = {} if config is None else dict(config)
    timing_window = int(cfg.get("timing_window", 256))
    pipeline = AlgorithmPipeline(timing_window=timing_window)

    for block_spec in cfg.get("blocks", []):
        if not isinstance(block_spec, dict):
            raise TypeError("each block spec must be a dict")
        add_block(
            pipeline,
            type=str(block_spec.get("type", "")),
            config=dict(block_spec.get("config", {})),
        )

    return pipeline


def add_block(pipeline: AlgorithmPipeline, type: str, config: dict[str, Any] | None = None) -> str:
    if not isinstance(pipeline, AlgorithmPipeline):
        raise TypeError("pipeline must be an AlgorithmPipeline")

    kind = str(type).strip().lower()
    block_cls = _BLOCK_TYPES.get(kind)
    if block_cls is None:
        supported = ", ".join(sorted(_BLOCK_TYPES.keys()))
        raise ValueError(f"unsupported block type: {type}. supported: {supported}")

    cfg = {} if config is None else dict(config)
    name = cfg.pop("name", None)

    block = block_cls(config=cfg, name=None if name is None else str(name))
    pipeline.register_block(block)
    return block.name


def remove_block(pipeline: AlgorithmPipeline, name: str) -> bool:
    if not isinstance(pipeline, AlgorithmPipeline):
        raise TypeError("pipeline must be an AlgorithmPipeline")
    return pipeline.remove_block(str(name))


def process_frame(pipeline: AlgorithmPipeline, frame: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(pipeline, AlgorithmPipeline):
        raise TypeError("pipeline must be an AlgorithmPipeline")
    if not isinstance(frame, dict):
        raise TypeError("frame must be a dict")
    return pipeline.process(dict(frame))
