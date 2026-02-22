from __future__ import annotations

import time
from typing import Any

from .base import AlgorithmBlock


class PIDBlock(AlgorithmBlock):
    """Simple PID control block for scalar telemetry signals."""

    def __init__(self, config: dict[str, Any] | None = None, *, name: str | None = None) -> None:
        super().__init__(name=name or "pid")
        self._input_key = "value"
        self._output_key = "pid_output"
        self._setpoint = 0.0
        self._kp = 1.0
        self._ki = 0.0
        self._kd = 0.0
        self._integral_limit = 1_000_000.0
        self._output_min: float | None = None
        self._output_max: float | None = None

        self._integral = 0.0
        self._prev_error: float | None = None
        self._prev_timestamp: float | None = None
        self._time_source: str | None = None
        self._last_output: float | None = None

        self.initialize(config or {})

    def initialize(self, config: dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise TypeError("config must be a dict")

        self._input_key = str(config.get("input_key", self._input_key))
        self._output_key = str(config.get("output_key", self._output_key))
        self._setpoint = float(config.get("setpoint", self._setpoint))
        self._kp = float(config.get("kp", self._kp))
        self._ki = float(config.get("ki", self._ki))
        self._kd = float(config.get("kd", self._kd))
        self._integral_limit = abs(float(config.get("integral_limit", self._integral_limit)))

        output_min = config.get("output_min", self._output_min)
        output_max = config.get("output_max", self._output_max)
        self._output_min = None if output_min is None else float(output_min)
        self._output_max = None if output_max is None else float(output_max)
        if self._output_min is not None and self._output_max is not None and self._output_min > self._output_max:
            raise ValueError("output_min must be <= output_max")

        self.reset()

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        out = self.copy_frame(frame)
        measurement = self.extract_numeric(frame, self._input_key)
        if measurement is None:
            self.mark_not_ready(out, self.name, "missing_numeric_input")
            return out

        timestamp = self._resolve_timestamp(frame)
        error = self._setpoint - measurement

        dt = 0.0
        if self._prev_timestamp is not None:
            dt = timestamp - self._prev_timestamp
            if dt < 0.0:
                dt = 0.0

        if dt > 0.0:
            self._integral += error * dt
            if self._integral_limit > 0:
                self._integral = max(-self._integral_limit, min(self._integral, self._integral_limit))

        derivative = 0.0
        if dt > 1e-9 and self._prev_error is not None:
            derivative = (error - self._prev_error) / dt

        output = (self._kp * error) + (self._ki * self._integral) + (self._kd * derivative)
        if self._output_min is not None:
            output = max(self._output_min, output)
        if self._output_max is not None:
            output = min(self._output_max, output)

        self._prev_error = error
        self._prev_timestamp = timestamp
        self._last_output = output

        out[self._output_key] = output
        self.set_algorithm_output(
            out,
            self.name,
            {
                "ready": True,
                "input_key": self._input_key,
                "output_key": self._output_key,
                "setpoint": self._setpoint,
                "measurement": measurement,
                "error": error,
                "dt": dt,
                "integral": self._integral,
                "derivative": derivative,
                "output": output,
                "time_source": self._time_source,
            },
        )
        return out

    def reset(self) -> None:
        self._integral = 0.0
        self._prev_error = None
        self._prev_timestamp = None
        self._time_source = None
        self._last_output = None

    def get_state(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "input_key": self._input_key,
            "output_key": self._output_key,
            "setpoint": self._setpoint,
            "kp": self._kp,
            "ki": self._ki,
            "kd": self._kd,
            "integral": self._integral,
            "previous_error": self._prev_error,
            "last_output": self._last_output,
            "output_min": self._output_min,
            "output_max": self._output_max,
            "time_source": self._time_source,
        }

    def _resolve_timestamp(self, frame: dict[str, Any]) -> float:
        raw = frame.get("timestamp")
        if isinstance(raw, (int, float)):
            if self._time_source != "frame":
                self._prev_timestamp = None
            self._time_source = "frame"
            return float(raw)

        if self._time_source != "monotonic":
            self._prev_timestamp = None
        self._time_source = "monotonic"
        return time.monotonic()
