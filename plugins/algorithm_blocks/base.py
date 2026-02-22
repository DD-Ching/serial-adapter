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
        return dict(frame)

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
