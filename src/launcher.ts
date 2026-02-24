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

function resolvePackageRoot(startDir: string): string {
  const candidates = [
    startDir,
    resolve(startDir, ".."),
    resolve(startDir, "..", ".."),
    resolve(startDir, "..", "..", ".."),
  ];
  for (const dir of candidates) {
    const marker = resolve(dir, "openclaw.plugin.json");
    const pythonEntrypoint = resolve(dir, "python", "__main__.py");
    if (existsSync(marker) && existsSync(pythonEntrypoint)) {
      return dir;
    }
  }
  return resolve(startDir, "..");
}

const PKG_ROOT = resolvePackageRoot(import.meta.dirname);
const PYTHON_ENTRYPOINT = resolve(PKG_ROOT, "python", "__main__.py");
const VENV_PYTHON = resolve(
  PKG_ROOT,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);

const execFileAsync = promisify(execFile);

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function formatPortsForMessage(ports: SerialPortInfo[]): string {
  if (!ports.length) return "<none>";
  return ports
    .map((port) => {
      const details = [port.product, port.description, port.manufacturer]
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join(" | ");
      return details ? `${port.device} (${details})` : port.device;
    })
    .join(", ");
}

function makePythonMissingMessage(pythonPath: string): string {
  return [
    `Python executable not found: ${pythonPath}`,
    "Next step: set plugins.entries.serial-adapter.config.pythonPath to an absolute python path, then retry.",
    "Example (Windows): C:\\Python311\\python.exe",
  ].join(" ");
}

function makePyserialMissingMessage(pythonPath: string): string {
  return [
    `Python dependency missing (pyserial) for interpreter: ${pythonPath}`,
    "Next step: install pyserial in that interpreter and retry.",
    "Command: python -m pip install pyserial",
  ].join(" ");
}

function isPortBusyError(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("failed to open serial port") ||
    text.includes("could not open port") ||
    text.includes("access is denied") ||
    text.includes("permissionerror") ||
    text.includes("resource busy") ||
    text.includes("device or resource busy")
  );
}

function isPyserialMissingError(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("required python package 'pyserial'") ||
    text.includes("no module named 'serial'") ||
    text.includes('no module named "serial"')
  );
}

function makePortBusyMessage(
  launchPort: string,
  availablePorts: SerialPortInfo[]
): string {
  return [
    `Failed to open serial port ${launchPort} (likely occupied by another process).`,
    "Close Arduino IDE Serial Monitor, uploader, arduino-cli monitor, or any other app using the same COM port, then retry.",
    `Available serial ports: ${formatPortsForMessage(availablePorts)}`,
    "Note: upload (flash) and runtime monitor cannot hold the same COM port at the same time.",
  ].join(" ");
}

function makeGenericStartupFailureMessage(
  launchPort: string,
  availablePorts: SerialPortInfo[],
  details: string
): string {
  return [
    `Python adapter failed to start on serial port ${launchPort}.`,
    `Available serial ports: ${formatPortsForMessage(availablePorts)}`,
    `Details: ${details || "<empty>"}`,
  ].join(" ");
}

function classifyStartupFailure(
  launchPort: string,
  availablePorts: SerialPortInfo[],
  pythonPath: string,
  details: string
): string {
  if (isPyserialMissingError(details)) {
    return makePyserialMissingMessage(pythonPath);
  }
  if (isPortBusyError(details)) {
    return makePortBusyMessage(launchPort, availablePorts);
  }
  return makeGenericStartupFailureMessage(launchPort, availablePorts, details);
}

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

function canRunPythonCandidate(command: string): boolean {
  try {
    execFileSync(command, ["-c", "import sys"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isLikelyPath(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (text.includes("/") || text.includes("\\")) return true;
  return text.toLowerCase().endsWith(".exe");
}

function resolvePython(config: Pick<PluginConfig, "pythonPath">): string {
  const configured = config.pythonPath?.trim();
  if (configured) {
    if (isLikelyPath(configured)) return configured;
    if (canRunPythonCandidate(configured)) return configured;

    if (process.platform === "win32" && configured.toLowerCase() === "python3") {
      for (const candidate of ["python", "py"]) {
        if (canRunPythonCandidate(candidate)) return candidate;
      }
    }
    return configured;
  }

  if (ensureVenv()) return VENV_PYTHON;

  const candidates =
    process.platform === "win32"
      ? ["python", "py", "python3"]
      : ["python3", "python"];
  for (const candidate of candidates) {
    if (canRunPythonCandidate(candidate)) return candidate;
  }

  return process.platform === "win32" ? "python" : "python3";
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
  private lastProbePorts: SerialPortInfo[] = [];
  private pythonPathInUse: string | null = null;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  private async resolveLaunchPort(): Promise<string | null> {
    const configuredPort = this.config.serialPort?.trim();
    if (configuredPort) return configuredPort;
    if (this.config.autoDetectSerialPort === false) return null;

    const ports = await listSerialPorts(this.config);
    this.lastProbePorts = ports;
    const chosen = chooseBestSerialPort(ports, this.config.portHints);
    return chosen?.device ?? null;
  }

  async start(): Promise<ReadyMessage> {
    if (this.process) {
      throw new Error("Python subprocess already running");
    }

    const launchPort = await this.resolveLaunchPort();
    if (this.lastProbePorts.length === 0) {
      try {
        this.lastProbePorts = await listSerialPorts(this.config);
      } catch {
        this.lastProbePorts = [];
      }
    }
    if (!launchPort) {
      throw new Error(
        [
          "No serial port configured or auto-detected.",
          `Available serial ports: ${formatPortsForMessage(this.lastProbePorts)}`,
          "Next step: run serial_probe or set plugins.entries.serial-adapter.config.serialPort.",
        ].join(" ")
      );
    }

    const pythonPath = resolvePython(this.config);
    this.pythonPathInUse = pythonPath;
    if (
      this.config.pythonPath &&
      isLikelyPath(this.config.pythonPath) &&
      !existsSync(pythonPath) &&
      pythonPath === this.config.pythonPath
    ) {
      throw new Error(makePythonMissingMessage(pythonPath));
    }
    if (!existsSync(PYTHON_ENTRYPOINT)) {
      throw new Error(
        [
          `Python adapter entrypoint not found: ${PYTHON_ENTRYPOINT}`,
          "Next step: reinstall the plugin or ensure python/__main__.py exists in the plugin package.",
        ].join(" ")
      );
    }
    this.resolvedPort = launchPort;

    try {
      this.process = spawn(
        pythonPath,
        [
          PYTHON_ENTRYPOINT,
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
    } catch (error) {
      throw new Error(
        classifyStartupFailure(
          launchPort,
          this.lastProbePorts,
          pythonPath,
          asErrorMessage(error)
        )
      );
    }

    this.process.on("exit", () => {
      this.process = null;
      this.readyMessage = null;
      this.resolvedPort = null;
      this.pythonPathInUse = null;
    });

    this.readyMessage = await this.waitForReady(launchPort);
    return this.readyMessage;
  }

  private waitForReady(launchPort: string): Promise<ReadyMessage> {
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
            `Python subprocess did not become ready within ${READY_TIMEOUT_MS}ms. Next step: verify python + pyserial and check COM occupancy on ${launchPort}.`
          )
        );
        void this.stop();
      }, READY_TIMEOUT_MS);

      const rl = createInterface({ input: this.process.stdout });
      let stderr = "";
      const stdoutPreview: string[] = [];

      this.process.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (stdoutPreview.length < 3) stdoutPreview.push(trimmed);
        try {
          const msg = JSON.parse(trimmed) as ReadyMessage;
          if (msg.status === "ready") {
            settleResolve(msg);
          }
        } catch {
          // Allow non-JSON logs before ready line.
        }
      });

      this.process.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          settleReject(
            new Error(makePythonMissingMessage(this.pythonPathInUse ?? "python3"))
          );
          return;
        }
        settleReject(
          new Error(
            classifyStartupFailure(
              launchPort,
              this.lastProbePorts,
              this.pythonPathInUse ?? "python3",
              asErrorMessage(error)
            )
          )
        );
      });

      this.process.once("exit", (code) => {
        const detail = [stderr.trim(), stdoutPreview.join(" | ").trim()]
          .filter((part) => part.length > 0)
          .join(" | ");
        settleReject(
          new Error(
            classifyStartupFailure(
              launchPort,
              this.lastProbePorts,
              this.pythonPathInUse ?? "python3",
              detail || `process exited with code ${code}`
            )
          )
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
    this.pythonPathInUse = null;

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

  getLastProbePorts(): SerialPortInfo[] {
    return this.lastProbePorts.map((port) => ({ ...port }));
  }
}
