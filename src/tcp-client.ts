import { createConnection, Socket } from "node:net";
import { createInterface, Interface } from "node:readline";
import type { TelemetryFrame } from "./types.js";

const CONNECT_TIMEOUT_MS = 4000;

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

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host, port }, () => {
        if (settled) return;
        settled = true;
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

  disconnect(): void {
    this.rl?.close();
    this.rl = null;
    this.socket?.destroy();
    this.socket = null;
    this.frames = [];
  }
}

export class ControlClient {
  private socket: Socket | null = null;

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host, port }, () => {
        if (settled) return;
        settled = true;
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

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
