from __future__ import annotations

from typing import Any, Callable

from .base import AlgorithmBlock
from .fft_block import FFTBlock
from .kalman_block import KalmanBlock
from .moving_average_block import MovingAverageBlock
from .pid_block import PIDBlock
from .pipeline import AlgorithmPipeline

BlockFactory = Callable[[dict[str, Any], str | None], AlgorithmBlock]


class _DefaultFactory:
    @staticmethod
    def fft(config: dict[str, Any], name: str | None) -> AlgorithmBlock:
        return FFTBlock(config=config, name=name)

    @staticmethod
    def moving_average(config: dict[str, Any], name: str | None) -> AlgorithmBlock:
        return MovingAverageBlock(config=config, name=name)

    @staticmethod
    def pid(config: dict[str, Any], name: str | None) -> AlgorithmBlock:
        return PIDBlock(config=config, name=name)

    @staticmethod
    def kalman(config: dict[str, Any], name: str | None) -> AlgorithmBlock:
        return KalmanBlock(config=config, name=name)


_BLOCK_FACTORIES: dict[str, BlockFactory] = {
    "fft": _DefaultFactory.fft,
    "moving_average": _DefaultFactory.moving_average,
    "pid": _DefaultFactory.pid,
    "kalman": _DefaultFactory.kalman,
}


def list_supported_blocks() -> list[str]:
    return sorted(_BLOCK_FACTORIES.keys())


def register_block_type(type_name: str, factory: BlockFactory) -> None:
    key = str(type_name).strip().lower()
    if not key:
        raise ValueError("type_name must not be empty")
    if not callable(factory):
        raise TypeError("factory must be callable")
    _BLOCK_FACTORIES[key] = factory


def create_pipeline(config: dict[str, Any] | None = None) -> AlgorithmPipeline:
    cfg = {} if config is None else dict(config)
    timing_window = int(cfg.get("timing_window", 256))
    continue_on_error = bool(cfg.get("continue_on_error", False))
    pipeline = AlgorithmPipeline(timing_window=timing_window, continue_on_error=continue_on_error)

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
    factory = _BLOCK_FACTORIES.get(kind)
    if factory is None:
        supported = ", ".join(list_supported_blocks())
        raise ValueError(f"unsupported block type: {type}. supported: {supported}")

    cfg = {} if config is None else dict(config)
    name_raw = cfg.pop("name", None)
    name = None if name_raw is None else str(name_raw)

    block = factory(cfg, name)
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
    return pipeline.process(frame)
