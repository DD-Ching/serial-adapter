from __future__ import annotations

from typing import Any

import numpy as np

from .base import AlgorithmBlock


class FFTBlock(AlgorithmBlock):
    """Windowed FFT block for scalar telemetry streams."""

    def __init__(self, config: dict[str, Any] | None = None, *, name: str | None = None) -> None:
        super().__init__(name=name or "fft")
        self._input_key = "value"
        self._window_size = 32
        self._sample_rate_hz = 1.0
        self._window_type = "none"

        self._samples = np.zeros(self._window_size, dtype=np.float64)
        self._write_index = 0
        self._sample_count = 0
        self._freq_bins = np.fft.rfftfreq(self._window_size, d=1.0 / self._sample_rate_hz)
        self._window_values = np.ones(self._window_size, dtype=np.float64)
        self._last_result: dict[str, Any] | None = None

        self.initialize(config or {})

    def initialize(self, config: dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise TypeError("config must be a dict")

        self._input_key = str(config.get("input_key", self._input_key))
        self._window_size = max(4, int(config.get("window_size", self._window_size)))
        self._sample_rate_hz = float(config.get("sample_rate_hz", self._sample_rate_hz))
        self._window_type = str(config.get("window_type", self._window_type)).strip().lower()

        if self._sample_rate_hz <= 0:
            raise ValueError("sample_rate_hz must be positive")
        if self._window_type not in {"none", "hamming", "hann"}:
            raise ValueError("window_type must be one of: none, hamming, hann")

        self._samples = np.zeros(self._window_size, dtype=np.float64)
        self._write_index = 0
        self._sample_count = 0
        self._freq_bins = np.fft.rfftfreq(self._window_size, d=1.0 / self._sample_rate_hz)
        if self._window_type == "hamming":
            self._window_values = np.hamming(self._window_size)
        elif self._window_type == "hann":
            self._window_values = np.hanning(self._window_size)
        else:
            self._window_values = np.ones(self._window_size, dtype=np.float64)
        self._last_result = None

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        out = self.copy_frame(frame)
        value = self.extract_numeric(frame, self._input_key)

        if value is None:
            self.mark_not_ready(out, self.name, "missing_numeric_input")
            return out

        self._samples[self._write_index] = value
        self._write_index = (self._write_index + 1) % self._window_size
        if self._sample_count < self._window_size:
            self._sample_count += 1

        if self._sample_count < self._window_size:
            self.mark_not_ready(
                out,
                self.name,
                "insufficient_window",
                samples=self._sample_count,
                window_size=self._window_size,
            )
            return out

        if self._write_index == 0:
            ordered = self._samples
        else:
            ordered = np.concatenate((self._samples[self._write_index :], self._samples[: self._write_index]))

        spectrum = np.fft.rfft(ordered * self._window_values)
        magnitude = np.abs(spectrum)
        if magnitude.size > 1:
            dominant_idx = int(np.argmax(magnitude[1:]) + 1)
        else:
            dominant_idx = 0

        result = {
            "ready": True,
            "window_size": self._window_size,
            "window_type": self._window_type,
            "dominant_frequency_hz": float(self._freq_bins[dominant_idx]),
            "peak_magnitude": float(magnitude[dominant_idx]),
            "mean_magnitude": float(np.mean(magnitude)),
            "samples": self._sample_count,
        }

        self._last_result = result
        self.set_algorithm_output(out, self.name, result)
        out[f"{self.name}_dominant_frequency_hz"] = result["dominant_frequency_hz"]
        return out

    def reset(self) -> None:
        self._samples.fill(0.0)
        self._write_index = 0
        self._sample_count = 0
        self._last_result = None

    def get_state(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "input_key": self._input_key,
            "window_size": self._window_size,
            "sample_rate_hz": self._sample_rate_hz,
            "window_type": self._window_type,
            "sample_count": self._sample_count,
            "last_result": None if self._last_result is None else dict(self._last_result),
        }
