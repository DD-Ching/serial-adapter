import { createConnection, Socket } from "node:net";
import { createInterface, Interface } from "node:readline";
import type { TelemetryFrame } from "./types.js";

const CONNECT_TIMEOUT_MS = 4000;
const DEFAULT_CONTROL_ACK_TIMEOUT_MS = 1200;
const CONTROL_ACK_HISTORY_MAX = 40;

export type ControlAckPayload =
  | Record<string, unknown>
  | string
  | number
  | boolean
  | null;

interface PendingAck {
  resolve: (payload: ControlAckPayload | null) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function formatConnectError(
  channel: "telemetry" | "control",
  host: string,
  port: number,
  error: unknown
): string {
  const err = error as NodeJS.ErrnoException;
  const code = typeof err?.code === "string" ? err.code : "UNKNOWN";
  const detail = err?.message ? err.message : String(error);

  if (code === "ECONNREFUSED") {
    return [
      `Cannot connect to ${channel} channel at ${host}:${port} (ECONNREFUSED, not listening).`,
      "Next step: confirm serial-adapter subprocess is running and port mapping is correct.",
    ].join(" ");
  }
  if (code === "ETIMEDOUT") {
    return [
      `Timeout connecting to ${channel} channel at ${host}:${port}.`,
      "Next step: verify host/port reachability and local firewall rules.",
    ].join(" ");
  }
  return `Failed to connect to ${channel} channel at ${host}:${port} (${code}): ${detail}`;
}

export class TelemetryClient {
  private socket: Socket | null = null;
  private rl: Interface | null = null;
  private frames: TelemetryFrame[] = [];
  private maxBuffered = 100;
  private connected = false;

  private onSocketClosed(): void {
    this.connected = false;
    this.rl?.close();
    this.rl = null;
    this.socket = null;
  }

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host, port }, () => {
        if (settled) return;
        settled = true;
        socket.setKeepAlive(true, 1000);
        this.connected = true;
        this.rl = createInterface({ input: this.socket! });
        this.rl.on("line", (line) => {
          try {
            const frame = JSON.parse(line) as TelemetryFrame;
            this.frames.push(frame);
            if (this.frames.length > this.maxBuffered) {
              this.frames.shift();
            }
          } catch {
            // Skip malformed frames.
          }
        });
        resolve();
      });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.on("timeout", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(formatConnectError("telemetry", host, port, { code: "ETIMEDOUT" })));
      });
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(formatConnectError("telemetry", host, port, error)));
      });
      socket.on("close", () => {
        this.onSocketClosed();
      });
      this.socket = socket;
    });
  }

  pollFrames(count?: number): TelemetryFrame[] {
    if (count !== undefined) {
      return this.frames.splice(0, count);
    }
    const result = this.frames;
    this.frames = [];
    return result;
  }

  snapshotFrames(count?: number): TelemetryFrame[] {
    if (count === undefined) {
      return this.frames.slice();
    }
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount === 0) return [];
    return this.frames.slice(-safeCount);
  }

  bufferedCount(): number {
    return this.frames.length;
  }

  isConnected(): boolean {
    return Boolean(this.connected && this.socket && !this.socket.destroyed);
  }

  disconnect(): void {
    this.connected = false;
    this.rl?.close();
    this.rl = null;
    this.socket?.destroy();
    this.socket = null;
    this.frames = [];
  }
}

export class ControlClient {
  private socket: Socket | null = null;
  private rl: Interface | null = null;
  private pendingAcks: PendingAck[] = [];
  private ackHistory: ControlAckPayload[] = [];
  private connected = false;

  private onSocketClosed(): void {
    this.connected = false;
    this.rejectAllPendingAcks("Control client disconnected");
    this.rl?.close();
    this.rl = null;
    this.socket = null;
  }

  private parseAckLine(line: string): ControlAckPayload {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ControlAckPayload;
    } catch {
      return trimmed;
    }
  }

  private pushAckHistory(payload: ControlAckPayload): void {
    this.ackHistory.push(payload);
    if (this.ackHistory.length > CONTROL_ACK_HISTORY_MAX) {
      this.ackHistory.shift();
    }
  }

  private resolveNextPendingAck(payload: ControlAckPayload): void {
    const next = this.pendingAcks.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.resolve(payload);
  }

  private rejectAllPendingAcks(message: string): void {
    const pending = this.pendingAcks.splice(0);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
  }

  private waitForAck(timeoutMs?: number): Promise<ControlAckPayload | null> {
    const safeTimeout =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? Math.max(100, Math.floor(timeoutMs))
        : DEFAULT_CONTROL_ACK_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pendingAcks.findIndex((entry) => entry.timer === timer);
        if (index >= 0) {
          const [pending] = this.pendingAcks.splice(index, 1);
          pending.reject(new Error(`Timed out waiting for control ACK after ${safeTimeout}ms`));
          return;
        }
        reject(new Error(`Timed out waiting for control ACK after ${safeTimeout}ms`));
      }, safeTimeout);
      this.pendingAcks.push({ resolve, reject, timer });
    });
  }

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host, port }, () => {
        if (settled) return;
        settled = true;
        socket.setKeepAlive(true, 1000);
        this.connected = true;
        this.rl = createInterface({ input: this.socket! });
        this.rl.on("line", (line) => {
          const payload = this.parseAckLine(line);
          this.pushAckHistory(payload);
          this.resolveNextPendingAck(payload);
        });
        resolve();
      });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.on("timeout", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(formatConnectError("control", host, port, { code: "ETIMEDOUT" })));
      });
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(formatConnectError("control", host, port, error)));
      });
      socket.on("close", () => {
        this.onSocketClosed();
      });
      this.socket = socket;
    });
  }

  sendCommand(command: Record<string, unknown>): void {
    if (!this.socket) {
      throw new Error("Control client not connected");
    }
    const payload = JSON.stringify(command) + "\n";
    this.socket.write(payload);
  }

  sendRawLine(line: string): void {
    if (!this.socket) {
      throw new Error("Control client not connected");
    }
    const normalized = String(line).replace(/[\r\n]+/g, "").trim();
    if (!normalized) {
      throw new Error("Raw control line is empty");
    }
    this.socket.write(normalized + "\n");
  }

  async sendCommandWithAck(
    command: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<ControlAckPayload | null> {
    if (!this.socket) {
      throw new Error("Control client not connected");
    }
    const ackPromise = this.waitForAck(timeoutMs);
    try {
      this.sendCommand(command);
    } catch (error) {
      this.rejectAllPendingAcks(String(error));
      throw error;
    }
    return ackPromise;
  }

  async sendRawLineWithAck(
    line: string,
    timeoutMs?: number
  ): Promise<ControlAckPayload | null> {
    if (!this.socket) {
      throw new Error("Control client not connected");
    }
    const ackPromise = this.waitForAck(timeoutMs);
    try {
      this.sendRawLine(line);
    } catch (error) {
      this.rejectAllPendingAcks(String(error));
      throw error;
    }
    return ackPromise;
  }

  getLatestAck(): ControlAckPayload | null {
    if (this.ackHistory.length === 0) return null;
    return this.ackHistory[this.ackHistory.length - 1] ?? null;
  }

  getAckHistory(limit = 10): ControlAckPayload[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), CONTROL_ACK_HISTORY_MAX));
    return this.ackHistory.slice(-safeLimit);
  }

  isConnected(): boolean {
    return Boolean(this.connected && this.socket && !this.socket.destroyed);
  }

  disconnect(): void {
    this.connected = false;
    this.rejectAllPendingAcks("Control client disconnected");
    this.rl?.close();
    this.rl = null;
    this.socket?.destroy();
    this.socket = null;
    this.ackHistory = [];
  }
}
