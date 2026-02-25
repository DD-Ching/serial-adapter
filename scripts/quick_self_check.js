import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = {
    host: "127.0.0.1",
    telemetryPort: 9000,
    controlPort: 9001,
    timeoutMs: 600,
    jsonOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      out.host = next;
      i += 1;
      continue;
    }
    if (arg === "--telemetry-port" && next) {
      out.telemetryPort = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--control-port" && next) {
      out.controlPort = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      out.timeoutMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--json") {
      out.jsonOnly = true;
      continue;
    }
  }

  if (!Number.isFinite(out.telemetryPort) || out.telemetryPort <= 0) {
    throw new Error(`invalid telemetry port: ${out.telemetryPort}`);
  }
  if (!Number.isFinite(out.controlPort) || out.controlPort <= 0) {
    throw new Error(`invalid control port: ${out.controlPort}`);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 50) {
    throw new Error(`invalid timeout-ms: ${out.timeoutMs}`);
  }
  return out;
}

function checkListening(host, port, timeoutMs) {
  return new Promise((resolveCheck) => {
    const socket = createConnection({ host, port });
    let done = false;

    const finish = (payload) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveCheck(payload);
    };

    socket.on("connect", () => {
      finish({
        listening: true,
        code: null,
        detail: null,
      });
    });

    socket.on("error", (error) => {
      finish({
        listening: false,
        code: typeof error?.code === "string" ? error.code : "UNKNOWN",
        detail: String(error?.message ?? error),
      });
    });

    socket.setTimeout(timeoutMs, () => {
      finish({
        listening: false,
        code: "ETIMEDOUT",
        detail: `connect timeout after ${timeoutMs}ms`,
      });
    });
  });
}

async function probeSerialPorts() {
  const script = [
    "import json",
    "try:",
    "    from serial.tools import list_ports",
    "except Exception as exc:",
    "    print(json.dumps({'ok': False, 'error': str(exc)}))",
    "    raise SystemExit(0)",
    "ports = [p.device for p in list_ports.comports()]",
    "print(json.dumps({'ok': True, 'ports': ports}))",
  ].join("\n");

  const candidates = [];
  if (process.env.OPENCLAW_PYTHON) {
    candidates.push({
      command: process.env.OPENCLAW_PYTHON,
      args: ["-c", script],
      label: process.env.OPENCLAW_PYTHON,
    });
  }
  candidates.push({ command: "python", args: ["-c", script], label: "python" });
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3", "-c", script], label: "py -3" });
  } else {
    candidates.push({ command: "python3", args: ["-c", script], label: "python3" });
  }

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args, {
        timeout: 3000,
      });
      const parsed = JSON.parse((stdout || "").trim() || "{}");
      if (parsed.ok) {
        return {
          ok: true,
          python: candidate.label,
          ports: Array.isArray(parsed.ports) ? parsed.ports : [],
          error: null,
        };
      }
      return {
        ok: false,
        python: candidate.label,
        ports: [],
        error: typeof parsed.error === "string" ? parsed.error : "serial probe failed",
      };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "ENOENT") continue;
      return {
        ok: false,
        python: candidate.label,
        ports: [],
        error: String(error),
      };
    }
  }

  return {
    ok: false,
    python: null,
    ports: [],
    error: "No usable python executable found (python/python3/py -3).",
  };
}

function computeNextSteps(result) {
  const steps = [];
  if (!result.artifacts.algorithm_blocks_dist) {
    steps.push("Build algorithm blocks once: cd plugins/algorithm_blocks_ts && npm run build");
  }
  if (!result.ports.telemetry.listening) {
    steps.push("Start serial-adapter runtime so telemetry port is listening (default 9000).");
  }
  if (!result.ports.control.listening) {
    steps.push("Start control channel (serial-adapter control port or control_bridge.js) on 9001.");
  }
  if (!result.serial_probe.ok) {
    steps.push("Install pyserial in your Python runtime: python -m pip install pyserial");
  }
  if (
    result.openclaw_extension?.exists === true &&
    result.openclaw_extension?.up_to_date === false
  ) {
    steps.push(
      "Installed OpenClaw extension is stale. Run: powershell -ExecutionPolicy Bypass -File scripts/deploy_local_extension.ps1 -RestartGateway",
    );
  }
  return steps;
}

function hasMarker(path, marker) {
  if (!existsSync(path)) return false;
  try {
    const text = readFileSync(path, "utf8");
    return text.includes(marker);
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const algorithmDist = resolve(
    repoRoot,
    "plugins/algorithm_blocks_ts/dist/src/index.js",
  );
  const bridgeScript = resolve(repoRoot, "plugins/openclaw_ts_bridge/bridge.js");
  const llmScript = resolve(
    repoRoot,
    "plugins/openclaw_ts_bridge/send_llm_command.js",
  );
  const extensionDist = resolve(
    process.env.USERPROFILE ?? process.env.HOME ?? "~",
    ".openclaw/extensions/serial-adapter/dist/index.js",
  );
  const openclawCliPath =
    process.platform === "win32"
      ? resolve(process.env.APPDATA ?? "", "npm/openclaw.cmd")
      : null;

  const [telemetry, control, serialProbe] = await Promise.all([
    checkListening(args.host, args.telemetryPort, args.timeoutMs),
    checkListening(args.host, args.controlPort, args.timeoutMs),
    probeSerialPorts(),
  ]);

  const result = {
    type: "quick_check",
    ok: true,
    cwd: repoRoot,
    node: {
      path: process.execPath,
      version: process.version,
    },
    openclaw_cli: {
      path: openclawCliPath,
      exists: openclawCliPath ? existsSync(openclawCliPath) : null,
    },
    openclaw_extension: {
      path: extensionDist,
      exists: existsSync(extensionDist),
      has_serial_intent: hasMarker(extensionDist, "serial_intent"),
      has_serial_bridge_sync: hasMarker(extensionDist, "serial_bridge_sync"),
      up_to_date: false,
    },
    artifacts: {
      algorithm_blocks_dist: existsSync(algorithmDist),
      bridge_script: existsSync(bridgeScript),
      send_llm_command_script: existsSync(llmScript),
    },
    ports: {
      telemetry: {
        host: args.host,
        port: args.telemetryPort,
        ...telemetry,
      },
      control: {
        host: args.host,
        port: args.controlPort,
        ...control,
      },
    },
    serial_probe: serialProbe,
    next_steps: [],
  };
  result.openclaw_extension.up_to_date =
    result.openclaw_extension.exists &&
    result.openclaw_extension.has_serial_intent &&
    result.openclaw_extension.has_serial_bridge_sync;

  result.next_steps = computeNextSteps(result);
  result.ok =
    result.artifacts.algorithm_blocks_dist &&
    result.artifacts.bridge_script &&
    result.artifacts.send_llm_command_script;

  if (args.jsonOnly) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      type: "quick_check_error",
      ok: false,
      error: String(error),
    }),
  );
  process.exit(1);
});

