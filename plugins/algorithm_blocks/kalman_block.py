from __future__ import annotations

from typing import Any

from .base import AlgorithmBlock


class KalmanBlock(AlgorithmBlock):
    """Lightweight scalar (1D) Kalman filter block."""

    def __init__(self, config: dict[str, Any] | None = None, *, name: str | None = None) -> None:
        super().__init__(name=name or "kalman")
        self._input_key = "value"
        self._output_key = "kalman_estimate"
        self._q = 1e-5
        self._r = 1e-2
        self._initial_estimate: float | None = None
        self._initial_error_covariance = 1.0

        self._x = 0.0
        self._p = 1.0
        self._initialized = False

        self.initialize(config or {})

    def initialize(self, config: dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise TypeError("config must be a dict")

        self._input_key = str(config.get("input_key", self._input_key))
        self._output_key = str(config.get("output_key", self._output_key))
        self._q = float(config.get("process_variance", self._q))
        self._r = float(config.get("measurement_variance", self._r))

        initial_estimate = config.get("initial_estimate", self._initial_estimate)
        self._initial_estimate = None if initial_estimate is None else float(initial_estimate)
        self._initial_error_covariance = float(
            config.get("initial_error_covariance", self._initial_error_covariance)
        )

        if self._q < 0 or self._r <= 0 or self._initial_error_covariance <= 0:
            raise ValueError("invalid kalman configuration")

        self.reset()

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        out = self.copy_frame(frame)
        measurement = self.extract_numeric(frame, self._input_key)
        if measurement is None:
            out.setdefault("algorithms", {})[self.name] = {
                "ready": False,
                "reason": "missing_numeric_input",
            }
            return out

        if not self._initialized:
            self._x = measurement if self._initial_estimate is None else self._initial_estimate
            self._p = self._initial_error_covariance
            self._initialized = True

        # Predict
        self._p = self._p + self._q

        # Update
        gain = self._p / (self._p + self._r)
        innovation = measurement - self._x
        self._x = self._x + (gain * innovation)
        self._p = (1.0 - gain) * self._p

        out[self._output_key] = self._x
        out.setdefault("algorithms", {})[self.name] = {
            "ready": True,
            "input_key": self._input_key,
            "output_key": self._output_key,
            "measurement": measurement,
            "estimate": self._x,
            "gain": gain,
            "innovation": innovation,
            "error_covariance": self._p,
        }
        return out

    def reset(self) -> None:
        self._x = 0.0
        self._p = self._initial_error_covariance
        self._initialized = False

    def get_state(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "input_key": self._input_key,
            "output_key": self._output_key,
            "process_variance": self._q,
            "measurement_variance": self._r,
            "initialized": self._initialized,
            "estimate": self._x,
            "error_covariance": self._p,
        }
