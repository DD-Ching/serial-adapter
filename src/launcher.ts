import { spawn, execFile, execFileSync, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { PluginConfig, ReadyMessage, SerialPortInfo } from "./types.js";

const READY_TIMEOUT_MS = 10_000;
const SERIAL_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_PORT_HINTS = [
  "arduino",
  "uno",
  "ch340",
  "cp210",
  "ftdi",
  "usb serial",
  "ttyusb",
  "ttyacm",
  "com",
];

const PKG_ROOT = resolve(import.meta.dirname, "..");
const VENV_PYTHON = resolve(
  PKG_ROOT,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

const execFileAsync = promisify(execFile);

function ensureVenv(): boolean {
  if (existsSync(VENV_PYTHON)) return true;
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
  } catch {
    return false;
  }
  try {
    execFileSync("uv", ["sync", "--frozen", "--no-dev"], {
      cwd: PKG_ROOT,
      stdio: "ignore",
    });
    return existsSync(VENV_PYTHON);
  } catch {
    return false;
  }
}

function resolvePython(config: Pick<PluginConfig, "pythonPath">): string {
  if (config.pythonPath) return config.pythonPath;
  if (ensureVenv()) return VENV_PYTHON;
  return "python3";
}

function normalizePortInfo(raw: unknown): SerialPortInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const device = typeof obj.device === "string" ? obj.device.trim() : "";
  if (!device) return null;

  const toText = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value : null;
  const toNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  return {
    device,
    name: toText(obj.name),
    description: toText(obj.description),
    hwid: toText(obj.hwid),
    vid: toNumber(obj.vid),
    pid: toNumber(obj.pid),
    manufacturer: toText(obj.manufacturer),
    product: toText(obj.product),
    serialNumber: toText(obj.serial_number),
    interface: toText(obj.interface),
  };
}

function scorePort(port: SerialPortInfo, hints: string[]): number {
  const haystack = [
    port.device,
    port.name,
    port.description,
    port.hwid,
    port.manufacturer,
    port.product,
    port.serialNumber,
    port.interface,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;
  const weighted: Array<[string, number]> = [
    ["arduino", 180],
    ["uno", 170],
    ["ch340", 150],
    ["cp210", 150],
    ["ftdi", 140],
    ["usb serial", 130],
    ["ttyacm", 90],
    ["ttyusb", 90],
  ];

  for (const [keyword, weight] of weighted) {
    if (haystack.includes(keyword)) score += weight;
  }
  for (const hint of hints) {
    const normalized = hint.trim().toLowerCase();
    if (normalized && haystack.includes(normalized)) score += 50;
  }
  if (/^com\d+$/i.test(port.device)) score += 5;
  return score;
}

export function chooseBestSerialPort(
  ports: SerialPortInfo[],
  hints?: string[]
): SerialPortInfo | null {
  if (ports.length === 0) return null;
  if (ports.length === 1) return ports[0];

  const usedHints = hints && hints.length > 0 ? hints : [...DEFAULT_PORT_HINTS];

  let best: SerialPortInfo | null = null;
  let bestScore = -1;
  for (const port of ports) {
    const score = scorePort(port, usedHints);
    if (score > bestScore) {
      bestScore = score;
      best = port;
    }
  }
  return bestScore > 0 ? best : null;
}

export async function listSerialPorts(
  config: Pick<PluginConfig, "pythonPath"> = {}
): Promise<SerialPortInfo[]> {
  const pythonPath = resolvePython(config);
  const script = [
    "import json",
    "try:",
    "    from serial.tools import list_ports",
    "except Exception:",
    "    print('[]')",
    "    raise SystemExit(0)",
    "ports = []",
    "for p in list_ports.comports():",
    "    ports.append({",
    "        'device': getattr(p, 'device', None),",
    "        'name': getattr(p, 'name', None),",
    "        'description': getattr(p, 'description', None),",
    "        'hwid': getattr(p, 'hwid', None),",
    "        'vid': getattr(p, 'vid', None),",
    "        'pid': getattr(p, 'pid', None),",
    "        'manufacturer': getattr(p, 'manufacturer', None),",
    "        'product': getattr(p, 'product', None),",
    "        'serial_number': getattr(p, 'serial_number', None),",
    "        'interface': getattr(p, 'interface', None),",
    "    })",
    "print(json.dumps(ports))",
  ].join("\n");

  const { stdout } = await execFileAsync(pythonPath, ["-c", script], {
    cwd: PKG_ROOT,
    timeout: SERIAL_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  const parsed = JSON.parse(stdout.trim() || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => normalizePortInfo(item))
    .filter((item): item is SerialPortInfo => item !== null);
}

export class PythonLauncher {
  private process: ChildProcess | null = null;
  private config: PluginConfig;
  private readyMessage: ReadyMessage | null = null;
  private resolvedPort: string | null = null;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  private async resolveLaunchPort(): Promise<string | null> {
    const configuredPort = this.config.serialPort?.trim();
    if (configuredPort) return configuredPort;
    if (this.config.autoDetectSerialPort === false) return null;

    const ports = await listSerialPorts(this.config);
    const chosen = chooseBestSerialPort(ports, this.config.portHints);
    return chosen?.device ?? null;
  }

  async start(): Promise<ReadyMessage> {
    if (this.process) {
      throw new Error("Python subprocess already running");
    }

    const launchPort = await this.resolveLaunchPort();
    if (!launchPort) {
      throw new Error(
        "No serial port configured or auto-detected. Use serial_probe or set plugins.entries.serial-adapter.config.serialPort."
      );
    }

    const pythonPath = resolvePython(this.config);
    this.resolvedPort = launchPort;

    this.process = spawn(
      pythonPath,
      [
        "-m",
        "python",
        "--port",
        launchPort,
        "--baudrate",
        String(this.config.baudrate ?? 115200),
        "--telemetry-port",
        String(this.config.telemetryPort ?? 9000),
        "--control-port",
        String(this.config.controlPort ?? 9001),
        "--host",
        this.config.host ?? "127.0.0.1",
      ],
      {
        cwd: PKG_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    this.process.on("exit", () => {
      this.process = null;
      this.readyMessage = null;
      this.resolvedPort = null;
    });

    this.readyMessage = await this.waitForReady();
    return this.readyMessage;
  }

  private waitForReady(): Promise<ReadyMessage> {
    return new Promise((resolveReady, rejectReady) => {
      if (!this.process?.stdout) {
        rejectReady(new Error("No stdout on Python process"));
        return;
      }

      let settled = false;
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rl.close();
        rejectReady(error);
      };
      const settleResolve = (msg: ReadyMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rl.close();
        resolveReady(msg);
      };

      const timeout = setTimeout(() => {
        settleReject(
          new Error(
            `Python subprocess did not become ready within ${READY_TIMEOUT_MS}ms`
          )
        );
        void this.stop();
      }, READY_TIMEOUT_MS);

      const rl = createInterface({ input: this.process.stdout });
      let stderr = "";

      this.process.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      rl.once("line", (line) => {
        try {
          const msg = JSON.parse(line) as ReadyMessage;
          if (msg.status !== "ready") {
            settleReject(new Error(`Unexpected status: ${msg.status}`));
            return;
          }
          settleResolve(msg);
        } catch {
          settleReject(new Error(`Failed to parse ready message: ${line}`));
        }
      });

      this.process.once("exit", (code) => {
        settleReject(
          new Error(`Python subprocess exited with code ${code}: ${stderr}`)
        );
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;
    this.readyMessage = null;
    this.resolvedPort = null;

    return new Promise<void>((resolveStop) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolveStop();
      }, 5000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });

      proc.kill("SIGTERM");
    });
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getReadyMessage(): ReadyMessage | null {
    return this.readyMessage;
  }

  getResolvedPort(): string | null {
    return this.resolvedPort;
  }
}
