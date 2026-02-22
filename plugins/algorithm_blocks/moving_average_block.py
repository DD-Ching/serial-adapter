from __future__ import annotations

from collections import deque
from typing import Any, Deque

from .base import AlgorithmBlock


class MovingAverageBlock(AlgorithmBlock):
    """O(1) moving average block with bounded memory."""

    def __init__(self, config: dict[str, Any] | None = None, *, name: str | None = None) -> None:
        super().__init__(name=name or "moving_average")
        self._input_key = "value"
        self._output_key = "moving_average"
        self._window_size = 8
        self._window: Deque[float] = deque(maxlen=self._window_size)
        self._running_sum = 0.0
        self._sample_count_total = 0
        self._last_value: float | None = None
        self.initialize(config or {})

    def initialize(self, config: dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise TypeError("config must be a dict")

        self._input_key = str(config.get("input_key", self._input_key))
        self._output_key = str(config.get("output_key", self._output_key))
        self._window_size = max(1, int(config.get("window_size", self._window_size)))

        self._window = deque(maxlen=self._window_size)
        self._running_sum = 0.0
        self._sample_count_total = 0
        self._last_value = None

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        out = self.copy_frame(frame)
        value = self.extract_numeric(frame, self._input_key)

        if value is None:
            self.mark_not_ready(out, self.name, "missing_numeric_input")
            return out

        if len(self._window) == self._window_size:
            self._running_sum -= self._window[0]
        self._window.append(value)
        self._running_sum += value

        average = self._running_sum / float(len(self._window))
        self._sample_count_total += 1
        self._last_value = average

        out[self._output_key] = average
        self.set_algorithm_output(
            out,
            self.name,
            {
                "ready": True,
                "input_key": self._input_key,
                "output_key": self._output_key,
                "window_count": len(self._window),
                "window_size": self._window_size,
                "samples_total": self._sample_count_total,
                "value": average,
            },
        )
        return out

    def reset(self) -> None:
        self._window.clear()
        self._running_sum = 0.0
        self._sample_count_total = 0
        self._last_value = None

    def get_state(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "input_key": self._input_key,
            "output_key": self._output_key,
            "window_size": self._window_size,
            "window_count": len(self._window),
            "samples_total": self._sample_count_total,
            "last_value": self._last_value,
        }
