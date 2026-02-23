import type { AlgorithmBlock } from "../block.js";
import type { ProcessedFrame, TelemetryFrame } from "../types.js";

interface MovingAverageConfig {
  sourceKey?: string;
  outputKey?: string;
  window?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readNumeric(frame: TelemetryFrame, key: string): number | null {
  const fromFeatures = frame.features?.[key];
  if (isFiniteNumber(fromFeatures)) return fromFeatures;
  const fromParsed = frame.parsed?.[key];
  if (isFiniteNumber(fromParsed)) return fromParsed;
  return null;
}

export class MovingAverageBlock implements AlgorithmBlock {
  public readonly name: string;

  private sourceKey = "velocity";
  private outputKey = "moving_average.velocity";
  private window = 16;
  private ring: Float64Array = new Float64Array(this.window);
  private writeIndex = 0;
  private count = 0;
  private sum = 0;
  private lastAverage: number | null = null;

  constructor(name = "moving_average") {
    this.name = name;
  }

  init(config: Record<string, unknown>): void {
    const cfg = config as MovingAverageConfig;
    this.sourceKey = cfg.sourceKey ?? this.sourceKey;
    this.outputKey = cfg.outputKey ?? this.outputKey;
    this.window = Math.max(1, Math.floor(cfg.window ?? this.window));
    this.reset();
  }

  process(frame: TelemetryFrame): ProcessedFrame {
    const next: ProcessedFrame = {
      ...frame,
      features: frame.features ? { ...frame.features } : {},
    };
    const value = readNumeric(frame, this.sourceKey);
    if (value === null) {
      return next;
    }

    if (this.count === this.window) {
      this.sum -= this.ring[this.writeIndex];
    } else {
      this.count += 1;
    }

    this.ring[this.writeIndex] = value;
    this.sum += value;
    this.writeIndex = (this.writeIndex + 1) % this.window;

    this.lastAverage = this.sum / this.count;
    next.features![this.outputKey] = this.lastAverage;
    return next;
  }

  reset(): void {
    this.ring = new Float64Array(this.window);
    this.writeIndex = 0;
    this.count = 0;
    this.sum = 0;
    this.lastAverage = null;
  }

  state(): Record<string, unknown> {
    return {
      sourceKey: this.sourceKey,
      outputKey: this.outputKey,
      window: this.window,
      count: this.count,
      lastAverage: this.lastAverage,
    };
  }
}
