from __future__ import annotations

import argparse
import json
import time

try:
    from plugins.serial_adapter.plugin import SerialAdapter
except ImportError:
    import os
    import sys

    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from plugins.serial_adapter.plugin import SerialAdapter

try:
    from plugins.algorithm_blocks.llm_api import add_block, create_pipeline, process_frame
except ImportError:
    import os
    import sys

    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from plugins.algorithm_blocks.llm_api import add_block, create_pipeline, process_frame


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="SerialAdapter + AlgorithmPipeline example")
    parser.add_argument("--port", default="/dev/ttyUSB0", help="Serial port (default: /dev/ttyUSB0)")
    parser.add_argument("--baudrate", type=int, default=115200, help="Serial baudrate (default: 115200)")
    parser.add_argument("--duration-s", type=float, default=30.0, help="Run duration in seconds (default: 30)")
    parser.add_argument("--sleep-s", type=float, default=0.005, help="Idle sleep in seconds (default: 0.005)")
    return parser


def main() -> None:
    args = build_parser().parse_args()

    pipeline = create_pipeline({"timing_window": 512})
    add_block(
        pipeline,
        type="moving_average",
        config={"name": "ma", "input_key": "value", "output_key": "value_ma", "window_size": 8},
    )
    add_block(
        pipeline,
        type="kalman",
        config={"name": "kf", "input_key": "value_ma", "output_key": "value_kalman"},
    )

    adapter = SerialAdapter(
        port=args.port,
        baudrate=args.baudrate,
        enable_tcp=False,
    )

    print("[example] starting adapter", flush=True)
    adapter.connect()

    deadline = time.time() + max(0.1, float(args.duration_s))
    processed = 0

    try:
        while time.time() < deadline:
            frame = adapter.poll()
            if frame is None:
                time.sleep(max(0.0, float(args.sleep_s)))
                continue

            enhanced = process_frame(pipeline, frame)
            processed += 1
            print(json.dumps(enhanced, ensure_ascii=False), flush=True)

    except KeyboardInterrupt:
        print("\n[example] interrupted", flush=True)
    finally:
        adapter.disconnect()

    stats = pipeline.get_statistics()
    print(f"[example] processed={processed} stats={json.dumps(stats, ensure_ascii=False)}", flush=True)


if __name__ == "__main__":
    main()
