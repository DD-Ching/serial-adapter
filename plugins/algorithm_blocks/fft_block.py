from __future__ import annotations

from collections import deque
from typing import Any, Deque

import numpy as np

from .base import AlgorithmBlock


class FFTBlock(AlgorithmBlock):
    """Windowed FFT block for scalar telemetry streams."""

    def __init__(self, config: dict[str, Any] | None = None, *, name: str | None = None) -> None:
        super().__init__(name=name or "fft")
        self._input_key = "value"
        self._window_size = 32
        self._sample_rate_hz = 1.0
        self._history: Deque[float] = deque(maxlen=self._window_size)
        self._last_result: dict[str, Any] | None = None
        self.initialize(config or {})

    def initialize(self, config: dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise TypeError("config must be a dict")

        self._input_key = str(config.get("input_key", self._input_key))
        self._window_size = max(4, int(config.get("window_size", self._window_size)))
        self._sample_rate_hz = float(config.get("sample_rate_hz", self._sample_rate_hz))
        if self._sample_rate_hz <= 0:
            raise ValueError("sample_rate_hz must be positive")

        self._history = deque(maxlen=self._window_size)
        self._last_result = None

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        out = self.copy_frame(frame)
        value = self.extract_numeric(frame, self._input_key)

        if value is None:
            out.setdefault("algorithms", {})[self.name] = {
                "ready": False,
                "reason": "missing_numeric_input",
            }
            return out

        self._history.append(value)
        if len(self._history) < self._window_size:
            out.setdefault("algorithms", {})[self.name] = {
                "ready": False,
                "samples": len(self._history),
                "window_size": self._window_size,
            }
            return out

        samples = np.asarray(self._history, dtype=np.float64)
        spectrum = np.fft.rfft(samples)
        magnitude = np.abs(spectrum)
        frequencies = np.fft.rfftfreq(self._window_size, d=1.0 / self._sample_rate_hz)

        if magnitude.size > 1:
            dominant_idx = int(np.argmax(magnitude[1:]) + 1)
        else:
            dominant_idx = 0

        result = {
            "ready": True,
            "window_size": self._window_size,
            "dominant_frequency_hz": float(frequencies[dominant_idx]),
            "peak_magnitude": float(magnitude[dominant_idx]),
            "mean_magnitude": float(np.mean(magnitude)),
        }

        self._last_result = result
        out.setdefault("algorithms", {})[self.name] = dict(result)
        out[f"{self.name}_dominant_frequency_hz"] = result["dominant_frequency_hz"]
        return out

    def reset(self) -> None:
        self._history.clear()
        self._last_result = None

    def get_state(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "input_key": self._input_key,
            "window_size": self._window_size,
            "sample_rate_hz": self._sample_rate_hz,
            "sample_count": len(self._history),
            "last_result": None if self._last_result is None else dict(self._last_result),
        }
