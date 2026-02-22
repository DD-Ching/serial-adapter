import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { PluginConfig, ReadyMessage } from "./types.js";

const READY_TIMEOUT_MS = 10_000;

/** Package root — one level up from dist/src/. */
const PKG_ROOT = resolve(import.meta.dirname, "..");

const VENV_PYTHON = resolve(PKG_ROOT, ".venv", "bin", "python");

/**
 * Ensure a local .venv with dependencies exists.
 *
 * If .venv/bin/python is already present, this is a no-op.
 * Otherwise, attempts `uv sync --frozen --no-dev` to create it.
 * Returns true if .venv is usable after the call.
 */
function ensureVenv(): boolean {
  if (existsSync(VENV_PYTHON)) return true;

  // Check if uv is available.
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
  } catch {
    return false;
  }

  // Run uv sync to create .venv with runtime deps only.
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

/**
 * Resolve the Python interpreter to use.
 * Priority: explicit config > .venv (auto-created via uv) > system python3.
 */
function resolvePython(config: PluginConfig): string {
  if (config.pythonPath) return config.pythonPath;

  if (ensureVenv()) return VENV_PYTHON;

  return "python3";
}

export class PythonLauncher {
  private process: ChildProcess | null = null;
  private config: PluginConfig;
  private readyMessage: ReadyMessage | null = null;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async start(): Promise<ReadyMessage> {
    if (this.process) {
      throw new Error("Python subprocess already running");
    }

    const pythonPath = resolvePython(this.config);

    // Run with cwd at the package root so `python -m python` resolves
    // the python/ package directory correctly.
    this.process = spawn(pythonPath, [
      "-m",
      "python",
      "--port",
      this.config.serialPort,
      "--baudrate",
      String(this.config.baudrate ?? 115200),
      "--telemetry-port",
      String(this.config.telemetryPort ?? 9000),
      "--control-port",
      String(this.config.controlPort ?? 9001),
      "--host",
      this.config.host ?? "127.0.0.1",
    ], {
      cwd: PKG_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.on("exit", () => {
      this.process = null;
      this.readyMessage = null;
    });

    this.readyMessage = await this.waitForReady();
    return this.readyMessage;
  }

  private waitForReady(): Promise<ReadyMessage> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdout) {
        reject(new Error("No stdout on Python process"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Python subprocess did not become ready within ${READY_TIMEOUT_MS}ms`
          )
        );
        this.stop();
      }, READY_TIMEOUT_MS);

      const rl = createInterface({ input: this.process.stdout });

      rl.once("line", (line) => {
        clearTimeout(timeout);
        rl.close();
        try {
          const msg = JSON.parse(line) as ReadyMessage;
          if (msg.status !== "ready") {
            reject(new Error(`Unexpected status: ${msg.status}`));
            return;
          }
          resolve(msg);
        } catch {
          reject(new Error(`Failed to parse ready message: ${line}`));
        }
      });

      // Collect stderr for error reporting.
      let stderr = "";
      this.process.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      this.process.on("exit", (code) => {
        clearTimeout(timeout);
        rl.close();
        reject(
          new Error(
            `Python subprocess exited with code ${code}: ${stderr}`
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

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
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
}
