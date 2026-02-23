import type { AlgorithmBlock } from "../block.js";
import type { ProcessedFrame, TelemetryFrame } from "../types.js";

interface SummarizerConfig {
  keys?: string[];
  window?: number;
  outputKey?: string;
}

interface KeySummary {
  mean: number;
  delta: number;
  abs_delta: number;
  min: number;
  max: number;
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

class KeyWindow {
  private values: Float64Array;
  private writeIndex = 0;
  private count = 0;

  constructor(private readonly window: number) {
    this.values = new Float64Array(window);
  }

  reset(): void {
    this.values = new Float64Array(this.window);
    this.writeIndex = 0;
    this.count = 0;
  }

  push(value: number): void {
    this.values[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.window;
    if (this.count < this.window) this.count += 1;
  }

  summary(): KeySummary | null {
    if (this.count === 0) return null;
    const startIndex = this.count < this.window ? 0 : this.writeIndex;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let first = 0;
    let last = 0;
    for (let i = 0; i < this.count; i += 1) {
      const idx = (startIndex + i) % this.window;
      const value = this.values[idx];
      if (i === 0) first = value;
      if (i === this.count - 1) last = value;
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const delta = last - first;
    return {
      mean: sum / this.count,
      delta,
      abs_delta: Math.abs(delta),
      min,
      max,
    };
  }

  getCount(): number {
    return this.count;
  }
}

export class SummarizerBlock implements AlgorithmBlock {
  public readonly name: string;

  private keys: string[] = ["velocity"];
  private outputKey = "summary";
  private window = 32;
  private windows = new Map<string, KeyWindow>();

  constructor(name = "summarizer") {
    this.name = name;
  }

  init(config: Record<string, unknown>): void {
    const cfg = config as SummarizerConfig;
    if (Array.isArray(cfg.keys) && cfg.keys.length > 0) {
      this.keys = cfg.keys.filter((key): key is string => typeof key === "string");
    }
    this.outputKey = cfg.outputKey ?? this.outputKey;
    if (typeof cfg.window === "number" && Number.isFinite(cfg.window)) {
      this.window = Math.max(1, Math.floor(cfg.window));
    }
    this.reset();
  }

  process(frame: TelemetryFrame): ProcessedFrame {
    const next: ProcessedFrame = {
      ...frame,
      features: frame.features ? { ...frame.features } : {},
    };

    const summary: Record<string, KeySummary> = {};
    for (const key of this.keys) {
      const value = readNumeric(frame, key);
      if (value !== null) {
        this.windows.get(key)?.push(value);
      }
      const keySummary = this.windows.get(key)?.summary();
      if (keySummary) {
        summary[key] = keySummary;
      }
    }

    next.features![this.outputKey] = summary;
    return next;
  }

  reset(): void {
    this.windows = new Map<string, KeyWindow>();
    for (const key of this.keys) {
      this.windows.set(key, new KeyWindow(this.window));
    }
  }

  state(): Record<string, unknown> {
    const counts: Record<string, number> = {};
    for (const key of this.keys) {
      counts[key] = this.windows.get(key)?.getCount() ?? 0;
    }
    return {
      keys: [...this.keys],
      outputKey: this.outputKey,
      window: this.window,
      counts,
    };
  }
}
