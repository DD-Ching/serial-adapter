from __future__ import annotations

from collections import deque
import threading
import time
from typing import Any, Deque, Dict

from .base import AlgorithmBlock


class AlgorithmPipeline:
    """Thread-safe ordered pipeline of algorithm blocks."""

    def __init__(
        self,
        blocks: list[AlgorithmBlock] | None = None,
        *,
        timing_window: int = 256,
        continue_on_error: bool = False,
    ) -> None:
        self._config_lock = threading.RLock()
        self._process_lock = threading.Lock()
        self._stats_lock = threading.Lock()

        self._blocks: list[AlgorithmBlock] = []
        self._timing_window = max(16, int(timing_window))
        self._continue_on_error = bool(continue_on_error)

        self._frames_processed = 0
        self._frames_failed = 0
        self._last_error: dict[str, Any] | None = None
        self._block_timings_ns: Dict[str, Deque[int]] = {}
        self._block_errors: Dict[str, int] = {}
        self._pipeline_timings_ns: Deque[int] = deque(maxlen=self._timing_window)

        if blocks:
            for block in blocks:
                self.register_block(block)

    def register_block(self, block: AlgorithmBlock) -> str:
        if not isinstance(block, AlgorithmBlock):
            raise TypeError("block must inherit AlgorithmBlock")

        with self._config_lock:
            names = {item.name for item in self._blocks}
            if block.name in names:
                raise ValueError(f"duplicate block name: {block.name}")
            self._blocks.append(block)

        with self._stats_lock:
            self._block_timings_ns[block.name] = deque(maxlen=self._timing_window)
            self._block_errors.setdefault(block.name, 0)
        return block.name

    def remove_block(self, name: str) -> bool:
        removed_name: str | None = None
        with self._config_lock:
            for index, block in enumerate(self._blocks):
                if block.name != name:
                    continue
                removed_name = self._blocks.pop(index).name
                break

        if removed_name is None:
            return False

        with self._stats_lock:
            self._block_timings_ns.pop(removed_name, None)
            self._block_errors.pop(removed_name, None)
        return True

    def list_blocks(self) -> list[str]:
        with self._config_lock:
            return [block.name for block in self._blocks]

    def reset(self) -> None:
        with self._process_lock:
            with self._config_lock:
                blocks = list(self._blocks)
            for block in blocks:
                block.reset()

    def process(self, frame: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(frame, dict):
            raise TypeError("frame must be a dict")

        with self._process_lock:
            with self._config_lock:
                blocks = tuple(self._blocks)
                continue_on_error = self._continue_on_error

            current = AlgorithmBlock.copy_frame(frame)
            local_timings: list[tuple[str, int]] = []
            pipeline_start = time.perf_counter_ns()
            first_error: tuple[str, str] | None = None

            for block in blocks:
                start_ns = time.perf_counter_ns()
                try:
                    produced = block.process(current)
                    if not isinstance(produced, dict):
                        raise TypeError(f"{block.name}.process() must return a dict")
                    next_frame = produced if produced is not current else AlgorithmBlock.copy_frame(produced)
                except Exception as exc:  # pragma: no cover - runtime safety path
                    local_timings.append((block.name, time.perf_counter_ns() - start_ns))
                    if first_error is None:
                        first_error = (block.name, str(exc))
                    current = self._attach_error(current, block.name, str(exc))
                    if not continue_on_error:
                        break
                    continue

                local_timings.append((block.name, time.perf_counter_ns() - start_ns))
                current = next_frame

            pipeline_elapsed = time.perf_counter_ns() - pipeline_start
            self._record_stats(local_timings=local_timings, pipeline_elapsed=pipeline_elapsed, error=first_error)
            return current

    def get_block_states(self) -> dict[str, dict[str, Any]]:
        with self._process_lock:
            with self._config_lock:
                blocks = list(self._blocks)
            return {block.name: block.get_state() for block in blocks}

    def get_statistics(self) -> dict[str, Any]:
        with self._config_lock:
            block_names = [block.name for block in self._blocks]

        with self._stats_lock:
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

            pipeline_samples = list(self._pipeline_timings_ns)
            pipeline_count = len(pipeline_samples)
            if pipeline_count == 0:
                pipeline_avg_us = 0.0
                pipeline_max_us = 0.0
            else:
                pipeline_avg_us = float(sum(pipeline_samples) / pipeline_count) / 1000.0
                pipeline_max_us = float(max(pipeline_samples)) / 1000.0

            return {
                "frames_processed": int(self._frames_processed),
                "frames_failed": int(self._frames_failed),
                "blocks": block_names,
                "block_metrics": block_metrics,
                "pipeline_metrics": {
                    "samples": pipeline_count,
                    "avg_us": pipeline_avg_us,
                    "max_us": pipeline_max_us,
                },
                "timing_window": int(self._timing_window),
                "last_error": None if self._last_error is None else dict(self._last_error),
                "continue_on_error": self._continue_on_error,
            }

    def _record_stats(
        self,
        *,
        local_timings: list[tuple[str, int]],
        pipeline_elapsed: int,
        error: tuple[str, str] | None,
    ) -> None:
        with self._stats_lock:
            self._pipeline_timings_ns.append(int(pipeline_elapsed))
            for block_name, elapsed_ns in local_timings:
                queue = self._block_timings_ns.get(block_name)
                if queue is not None:
                    queue.append(int(elapsed_ns))

            if error is None:
                self._frames_processed += 1
                return

            block_name, message = error
            self._frames_failed += 1
            self._block_errors[block_name] = self._block_errors.get(block_name, 0) + 1
            self._last_error = {
                "block": block_name,
                "message": message,
                "timestamp": time.time(),
            }

    @staticmethod
    def _attach_error(frame: dict[str, Any], block_name: str, message: str) -> dict[str, Any]:
        out = AlgorithmBlock.copy_frame(frame)
        payload = out.get("algorithm_pipeline")
        if not isinstance(payload, dict):
            payload = {}
            out["algorithm_pipeline"] = payload

        history = payload.get("errors")
        if not isinstance(history, list):
            history = []
            payload["errors"] = history

        history.append({"block": block_name, "message": message})
        payload["error"] = {"block": block_name, "message": message}
        return out
