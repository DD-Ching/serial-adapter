from __future__ import annotations

from collections import deque
import threading
import time
from typing import Any, Deque, Dict, List

from .base import AlgorithmBlock


class AlgorithmPipeline:
    """Thread-safe ordered pipeline of algorithm blocks."""

    def __init__(self, blocks: list[AlgorithmBlock] | None = None, *, timing_window: int = 256) -> None:
        self._lock = threading.RLock()
        self._blocks: List[AlgorithmBlock] = []
        self._timing_window = max(16, int(timing_window))

        self._frames_processed = 0
        self._frames_failed = 0
        self._last_error: dict[str, Any] | None = None
        self._block_timings_ns: Dict[str, Deque[int]] = {}
        self._block_errors: Dict[str, int] = {}

        if blocks:
            for block in blocks:
                self.register_block(block)

    def register_block(self, block: AlgorithmBlock) -> str:
        if not isinstance(block, AlgorithmBlock):
            raise TypeError("block must inherit AlgorithmBlock")

        with self._lock:
            names = {item.name for item in self._blocks}
            if block.name in names:
                raise ValueError(f"duplicate block name: {block.name}")

            self._blocks.append(block)
            self._block_timings_ns[block.name] = deque(maxlen=self._timing_window)
            self._block_errors.setdefault(block.name, 0)
            return block.name

    def remove_block(self, name: str) -> bool:
        with self._lock:
            for index, block in enumerate(self._blocks):
                if block.name != name:
                    continue
                removed = self._blocks.pop(index)
                self._block_timings_ns.pop(removed.name, None)
                self._block_errors.pop(removed.name, None)
                return True
            return False

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(frame, dict):
            raise TypeError("frame must be a dict")

        with self._lock:
            blocks = list(self._blocks)

        current: dict[str, Any] = dict(frame)

        for block in blocks:
            start_ns = time.perf_counter_ns()
            error: Exception | None = None
            next_frame: dict[str, Any] | None = None

            try:
                produced = block.process(current)
                if not isinstance(produced, dict):
                    raise TypeError(f"{block.name}.process() must return a dict")
                next_frame = produced if produced is not current else dict(produced)
            except Exception as exc:  # pragma: no cover - runtime safety path
                error = exc

            elapsed_ns = time.perf_counter_ns() - start_ns
            with self._lock:
                samples = self._block_timings_ns.get(block.name)
                if samples is not None:
                    samples.append(int(elapsed_ns))

            if error is not None:
                with self._lock:
                    self._frames_failed += 1
                    self._block_errors[block.name] = self._block_errors.get(block.name, 0) + 1
                    self._last_error = {
                        "block": block.name,
                        "message": str(error),
                        "timestamp": time.time(),
                    }

                failed = dict(current)
                failed.setdefault("algorithm_pipeline", {})["error"] = {
                    "block": block.name,
                    "message": str(error),
                }
                return failed

            current = dict(next_frame) if next_frame is not None else dict(current)

        with self._lock:
            self._frames_processed += 1
        return current

    def get_statistics(self) -> dict[str, Any]:
        with self._lock:
            block_names = [block.name for block in self._blocks]
            block_metrics: dict[str, Any] = {}

            for name in block_names:
                samples = list(self._block_timings_ns.get(name, []))
                count = len(samples)
                if count == 0:
                    avg_us = 0.0
                    max_us = 0.0
                else:
                    avg_us = float(sum(samples) / count) / 1000.0
                    max_us = float(max(samples)) / 1000.0

                block_metrics[name] = {
                    "samples": count,
                    "avg_us": avg_us,
                    "max_us": max_us,
                    "errors": int(self._block_errors.get(name, 0)),
                }

            return {
                "frames_processed": int(self._frames_processed),
                "frames_failed": int(self._frames_failed),
                "blocks": block_names,
                "block_metrics": block_metrics,
                "timing_window": int(self._timing_window),
                "last_error": None if self._last_error is None else dict(self._last_error),
            }
