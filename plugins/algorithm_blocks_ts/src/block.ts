import type { ProcessedFrame, TelemetryFrame } from "./types.js";

export interface AlgorithmBlock {
  name: string;
  init(config: Record<string, unknown>): void;
  process(frame: TelemetryFrame): ProcessedFrame;
  reset(): void;
  state(): Record<string, unknown>;
}
