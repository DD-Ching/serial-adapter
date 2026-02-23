import type { AlgorithmBlock } from "./block.js";
import type {
  PipelineStats,
  ProcessedFrame,
  RollingFieldSnapshot,
  TelemetryFrame,
} from "./types.js";

interface PipelineOptions {
  historySize?: number;
  statsWindow?: number;
  statsFields?: string[];
}

const DEFAULT_HISTORY_SIZE = 256;
const DEFAULT_STATS_WINDOW = 128;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getByPath(source: Record<string, any> | undefined, path: string): unknown {
  if (!source) return undefined;
  if (!path.includes(".")) return source[path];
  const parts = path.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function cloneFrame(frame: TelemetryFrame): ProcessedFrame {
  return {
    ...frame,
    parsed: frame.parsed ? { ...frame.parsed } : undefined,
    meta: frame.meta ? { ...frame.meta } : undefined,
    features: frame.features ? { ...frame.features } : undefined,
  };
}

class RollingFieldStats {
  private readonly values: Float64Array;
  private writeIndex = 0;
  private count = 0;

  constructor(private readonly window: number) {
    this.values = new Float64Array(window);
  }

  reset(): void {
    this.values.fill(0);
    this.writeIndex = 0;
    this.count = 0;
  }

  push(value: number): void {
    this.values[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.window;
    if (this.count < this.window) this.count += 1;
  }

  snapshot(): RollingFieldSnapshot {
    if (this.count === 0) {
      return {
        count: 0,
        mean: null,
        min: null,
        max: null,
        delta: null,
        last: null,
      };
    }

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

    return {
      count: this.count,
      mean: sum / this.count,
      min,
      max,
      delta: last - first,
      last,
    };
  }
}

export class AlgorithmPipeline {
  private readonly blocks = new Map<string, AlgorithmBlock>();
  private readonly historySize: number;
  private readonly history: Array<ProcessedFrame | undefined>;
  private historyCount = 0;
  private historyWriteIndex = 0;
  private latest: ProcessedFrame | null = null;

  private readonly statsWindow: number;
  private readonly explicitStatsFields: Set<string>;
  private readonly statsTrackers = new Map<string, RollingFieldStats>();

  constructor(options: PipelineOptions = {}) {
    this.historySize = Math.max(1, Math.floor(options.historySize ?? DEFAULT_HISTORY_SIZE));
    this.history = new Array<ProcessedFrame | undefined>(this.historySize);

    this.statsWindow = Math.max(1, Math.floor(options.statsWindow ?? DEFAULT_STATS_WINDOW));
    this.explicitStatsFields = new Set(options.statsFields ?? []);

    for (const field of this.explicitStatsFields) {
      this.statsTrackers.set(field, new RollingFieldStats(this.statsWindow));
    }
  }

  addBlock(block: AlgorithmBlock): void {
    this.blocks.set(block.name, block);
  }

  removeBlock(name: string): boolean {
    return this.blocks.delete(name);
  }

  process(frame: TelemetryFrame): ProcessedFrame {
    let current = cloneFrame(frame);
    for (const block of this.blocks.values()) {
      const nextFrame = block.process(current);
      if (nextFrame === current) {
        // Enforce "new object" contract from each block.
        current = cloneFrame(nextFrame);
      } else {
        current = nextFrame;
      }
    }

    this.latest = current;
    this.history[this.historyWriteIndex] = current;
    this.historyWriteIndex = (this.historyWriteIndex + 1) % this.historySize;
    if (this.historyCount < this.historySize) this.historyCount += 1;

    this.updateStats(current);
    return current;
  }

  getLatest(): ProcessedFrame | null {
    return this.latest ? cloneFrame(this.latest) : null;
  }

  getLastN(n: number): ProcessedFrame[] {
    const count = Math.max(0, Math.min(Math.floor(n), this.historyCount));
    if (count === 0) return [];

    const out = new Array<ProcessedFrame>(count);
    let readIndex = (this.historyWriteIndex - count + this.historySize) % this.historySize;
    for (let i = 0; i < count; i += 1) {
      const frame = this.history[readIndex];
      if (!frame) {
        out[i] = { timestamp: 0 };
      } else {
        out[i] = cloneFrame(frame);
      }
      readIndex = (readIndex + 1) % this.historySize;
    }
    return out;
  }

  getStats(): PipelineStats {
    const fields: Record<string, RollingFieldSnapshot> = {};
    for (const [field, tracker] of this.statsTrackers.entries()) {
      fields[field] = tracker.snapshot();
    }
    return {
      window: this.statsWindow,
      fields,
    };
  }

  private updateStats(frame: ProcessedFrame): void {
    if (this.explicitStatsFields.size > 0) {
      for (const field of this.explicitStatsFields) {
        const value = this.readNumericField(frame, field);
        if (!isFiniteNumber(value)) continue;
        let tracker = this.statsTrackers.get(field);
        if (!tracker) {
          tracker = new RollingFieldStats(this.statsWindow);
          this.statsTrackers.set(field, tracker);
        }
        tracker.push(value);
      }
      return;
    }

    // Auto mode: derive numeric fields from frame.features first, then frame.parsed.
    if (frame.features) {
      for (const [field, value] of Object.entries(frame.features)) {
        if (!isFiniteNumber(value)) continue;
        this.pushStat(field, value);
      }
    }
    if (frame.parsed) {
      for (const [field, value] of Object.entries(frame.parsed)) {
        if (!isFiniteNumber(value)) continue;
        if (this.statsTrackers.has(field)) continue;
        this.pushStat(field, value);
      }
    }
  }

  private pushStat(field: string, value: number): void {
    let tracker = this.statsTrackers.get(field);
    if (!tracker) {
      tracker = new RollingFieldStats(this.statsWindow);
      this.statsTrackers.set(field, tracker);
    }
    tracker.push(value);
  }

  private readNumericField(frame: ProcessedFrame, field: string): number | null {
    const fromFeatures = getByPath(frame.features, field);
    if (isFiniteNumber(fromFeatures)) return fromFeatures;
    const fromParsed = getByPath(frame.parsed, field);
    if (isFiniteNumber(fromParsed)) return fromParsed;
    return null;
  }
}
