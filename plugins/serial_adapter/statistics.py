from __future__ import annotations

from collections import deque
import copy
import math
import threading
from typing import Any, Deque, Dict, Optional


class RollingStatistics:
    """Rolling statistics for numeric telemetry values."""

    def __init__(self, window_size: int = 10) -> None:
        if int(window_size) <= 0:
            raise ValueError("window_size must be positive")
        self._window_size = int(window_size)
        self._samples: Deque[Dict[str, float]] = deque()
        self._cached: Dict[str, Any] = {
            "count": 0,
            "mean": None,
            "min": None,
            "max": None,
            "delta": None,
            "fields": {},
        }
        self._dirty = False
        self._lock = threading.Lock()

    def _extract_numeric_sample(self, frame: Dict[str, Any]) -> Dict[str, float]:
        parsed = frame.get("parsed")
        if not isinstance(parsed, dict):
            return {}

        sample: Dict[str, float] = {}
        for key, value in parsed.items():
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)) and math.isfinite(float(value)):
                sample[str(key)] = float(value)
        return sample

    def update(self, frame: Dict[str, Any]) -> None:
        sample = self._extract_numeric_sample(frame)
        with self._lock:
            self._samples.append(sample)
            if len(self._samples) > self._window_size:
                self._samples.popleft()
            self._dirty = True

    def clear(self) -> None:
        with self._lock:
            self._samples.clear()
            self._dirty = True

    def _compute_locked(self) -> None:
        field_values: Dict[str, list[float]] = {}
        primary_values: list[float] = []

        for sample in self._samples:
            if not sample:
                continue

            if "value" in sample:
                primary_values.append(sample["value"])
            else:
                first_key = sorted(sample.keys())[0]
                primary_values.append(sample[first_key])

            for key, value in sample.items():
                field_values.setdefault(key, []).append(value)

        fields_summary: Dict[str, Dict[str, Optional[float]]] = {}
        for key, values in field_values.items():
            if not values:
                continue
            fields_summary[key] = {
                "mean": sum(values) / len(values),
                "min": min(values),
                "max": max(values),
                "delta": values[-1] - values[0],
            }

        if primary_values:
            mean_value: Optional[float] = sum(primary_values) / len(primary_values)
            min_value: Optional[float] = min(primary_values)
            max_value: Optional[float] = max(primary_values)
            delta_value: Optional[float] = primary_values[-1] - primary_values[0]
        else:
            mean_value = None
            min_value = None
            max_value = None
            delta_value = None

        self._cached = {
            "count": len(self._samples),
            "mean": mean_value,
            "min": min_value,
            "max": max_value,
            "delta": delta_value,
            "fields": fields_summary,
        }
        self._dirty = False

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            if self._dirty:
                self._compute_locked()
            return copy.deepcopy(self._cached)
