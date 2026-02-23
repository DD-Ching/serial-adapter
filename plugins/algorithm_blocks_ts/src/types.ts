export interface TelemetryFrame {
  timestamp: number;
  raw?: string;
  parsed?: Record<string, any>;
  meta?: Record<string, any>;
  features?: Record<string, any>;
}

export interface ProcessedFrame extends TelemetryFrame {
  features?: Record<string, any>;
}

export interface RollingFieldSnapshot {
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  delta: number | null;
  last: number | null;
}

export interface PipelineStats {
  window: number;
  fields: Record<string, RollingFieldSnapshot>;
}
