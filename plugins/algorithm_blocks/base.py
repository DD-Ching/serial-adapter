from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class AlgorithmBlock(ABC):
    """Base interface for frame-by-frame algorithm processing blocks."""

    def __init__(self, name: str | None = None) -> None:
        self.name = name or self.__class__.__name__

    @abstractmethod
    def initialize(self, config: dict[str, Any]) -> None:
        """Initialize or reconfigure this block."""

    @abstractmethod
    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        """Process one frame and return an enhanced frame copy."""

    @abstractmethod
    def reset(self) -> None:
        """Reset internal runtime state while keeping current configuration."""

    @abstractmethod
    def get_state(self) -> dict[str, Any]:
        """Return serializable runtime/config state."""

    @staticmethod
    def copy_frame(frame: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(frame, dict):
            raise TypeError("frame must be a dict")

        out = dict(frame)
        # Copy nested dictionaries that this layer can extend, so block updates
        # are never reflected in the caller's input frame.
        for nested_key in ("algorithms", "algorithm_pipeline"):
            nested = out.get(nested_key)
            if isinstance(nested, dict):
                out[nested_key] = dict(nested)
        return out

    @staticmethod
    def extract_numeric(frame: dict[str, Any], key: str) -> float | None:
        raw = frame.get(key)
        if isinstance(raw, (int, float)):
            return float(raw)

        parsed = frame.get("parsed")
        if isinstance(parsed, dict):
            nested = parsed.get(key)
            if isinstance(nested, (int, float)):
                return float(nested)

        return None

    @staticmethod
    def set_algorithm_output(out: dict[str, Any], block_name: str, payload: dict[str, Any]) -> None:
        bucket = out.get("algorithms")
        if not isinstance(bucket, dict):
            bucket = {}
            out["algorithms"] = bucket
        bucket[block_name] = dict(payload)

    @staticmethod
    def mark_not_ready(out: dict[str, Any], block_name: str, reason: str, **extras: Any) -> None:
        payload: dict[str, Any] = {"ready": False, "reason": str(reason)}
        payload.update(extras)
        AlgorithmBlock.set_algorithm_output(out, block_name, payload)
