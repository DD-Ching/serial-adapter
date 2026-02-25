export interface PluginConfig {
  pythonPath?: string;
  serialPort?: string;
  baudrate?: number;
  telemetryPort?: number;
  controlPort?: number;
  host?: string;
  unsafePassthrough?: boolean;
  allowedCommands?: string[];
  maxControlRate?: number;
  autoDetectSerialPort?: boolean;
  portHints?: string[];
  toolAutoConnect?: boolean;
  autoResumeOnUse?: boolean;
  bridgeAckTimeoutMs?: number;
}

export interface SerialPortInfo {
  device: string;
  name?: string | null;
  description?: string | null;
  hwid?: string | null;
  vid?: number | null;
  pid?: number | null;
  manufacturer?: string | null;
  product?: string | null;
  serialNumber?: string | null;
  interface?: string | null;
}

export interface ReadyMessage {
  status: "ready";
  telemetry_port: number;
  control_port: number;
  pid: number;
}

export interface TelemetryFrame {
  timestamp: number;
  raw: string;
  parsed: Record<string, unknown> | null;
  meta: {
    size: number;
    source: string;
  };
  [key: string]: unknown;
}

export interface AdapterStatus {
  rx_rate: number;
  tx_rate: number;
  connected_clients: number;
  ring_buffer_usage_ratio: number;
  control_commands_accepted: number;
  control_commands_rejected: number;
}
