import type { AlgorithmBlock } from "../block.js";
import type { ProcessedFrame, TelemetryFrame } from "../types.js";

interface PidConfig {
  measurementKey?: string;
  setpoint?: number;
  kp?: number;
  ki?: number;
  kd?: number;
  dtSeconds?: number;
  minOutput?: number;
  maxOutput?: number;
  outputKey?: string;
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

export class PidBlock implements AlgorithmBlock {
  public readonly name: string;

  private measurementKey = "velocity";
  private outputKey = "control.target_pwm";
  private setpoint = 0;
  private kp = 1;
  private ki = 0;
  private kd = 0;
  private dtSeconds = 0.01;
  private minOutput = Number.NEGATIVE_INFINITY;
  private maxOutput = Number.POSITIVE_INFINITY;

  private integral = 0;
  private prevError: number | null = null;
  private lastOutput: number | null = null;

  constructor(name = "pid") {
    this.name = name;
  }

  init(config: Record<string, unknown>): void {
    const cfg = config as PidConfig;
    this.measurementKey = cfg.measurementKey ?? this.measurementKey;
    this.outputKey = cfg.outputKey ?? this.outputKey;
    if (isFiniteNumber(cfg.setpoint)) this.setpoint = cfg.setpoint;
    if (isFiniteNumber(cfg.kp)) this.kp = cfg.kp;
    if (isFiniteNumber(cfg.ki)) this.ki = cfg.ki;
    if (isFiniteNumber(cfg.kd)) this.kd = cfg.kd;
    if (isFiniteNumber(cfg.dtSeconds)) this.dtSeconds = Math.max(1e-6, cfg.dtSeconds);
    if (isFiniteNumber(cfg.minOutput)) this.minOutput = cfg.minOutput;
    if (isFiniteNumber(cfg.maxOutput)) this.maxOutput = cfg.maxOutput;
    this.reset();
  }

  process(frame: TelemetryFrame): ProcessedFrame {
    const next: ProcessedFrame = {
      ...frame,
      features: frame.features ? { ...frame.features } : {},
    };

    const measurement = readNumeric(frame, this.measurementKey);
    if (measurement === null) {
      return next;
    }

    const error = this.setpoint - measurement;
    this.integral += error * this.dtSeconds;
    const derivative =
      this.prevError === null ? 0 : (error - this.prevError) / this.dtSeconds;

    let output = this.kp * error + this.ki * this.integral + this.kd * derivative;
    if (output < this.minOutput) output = this.minOutput;
    if (output > this.maxOutput) output = this.maxOutput;

    this.prevError = error;
    this.lastOutput = output;

    next.features![this.outputKey] = output;
    next.features![`${this.name}.error`] = error;
    next.features![`${this.name}.output`] = output;
    return next;
  }

  reset(): void {
    this.integral = 0;
    this.prevError = null;
    this.lastOutput = null;
  }

  state(): Record<string, unknown> {
    return {
      measurementKey: this.measurementKey,
      outputKey: this.outputKey,
      setpoint: this.setpoint,
      kp: this.kp,
      ki: this.ki,
      kd: this.kd,
      dtSeconds: this.dtSeconds,
      integral: this.integral,
      prevError: this.prevError,
      lastOutput: this.lastOutput,
    };
  }
}
