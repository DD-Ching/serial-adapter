import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import process from "node:process";

function parseArgs(argv) {
  const out = {
    host: "127.0.0.1",
    controlPort: 9001,
    holdS: 30,
    arduinoCli: "arduino-cli",
    com: "COM3",
    fqbn: "arduino:avr:uno",
    sketch: "",
    extraArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      out.host = next;
      i += 1;
      continue;
    }
    if ((arg === "--control-port" || arg === "--port") && next) {
      out.controlPort = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--hold-s" && next) {
      out.holdS = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--arduino-cli" && next) {
      out.arduinoCli = next;
      i += 1;
      continue;
    }
    if (arg === "--com" && next) {
      out.com = next;
      i += 1;
      continue;
    }
    if (arg === "--fqbn" && next) {
      out.fqbn = next;
      i += 1;
      continue;
    }
    if (arg === "--sketch" && next) {
      out.sketch = next;
      i += 1;
      continue;
    }
    if (arg === "--") {
      out.extraArgs = argv.slice(i + 1);
      break;
    }
  }

  if (!out.sketch) {
    throw new Error("missing --sketch <path>");
  }
  if (!Number.isFinite(out.controlPort) || out.controlPort <= 0) {
    throw new Error(`invalid --control-port: ${out.controlPort}`);
  }
  if (!Number.isFinite(out.holdS) || out.holdS < 0) {
    throw new Error(`invalid --hold-s: ${out.holdS}`);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendControlCommand({ host, controlPort, payload, timeoutMs = 1200 }) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: controlPort });
    let done = false;
    let recv = "";

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(payload) + "\n");
    });

    socket.on("data", (chunk) => {
      recv += chunk.toString("utf8");
      if (!recv.includes("\n")) return;
      const line = recv.split("\n")[0].trim();
      if (!line) {
        finish({ ok: true, response: null });
        return;
      }
      try {
        finish({ ok: true, response: JSON.parse(line) });
      } catch {
        finish({ ok: true, response: line });
      }
    });

    socket.on("error", (error) => {
      finish({
        ok: false,
        error: String(error),
        error_code:
          typeof error?.code === "string" ? String(error.code) : "UNKNOWN",
      });
    });

    socket.setTimeout(timeoutMs, () => {
      finish({ ok: true, response: null });
    });
  });
}

function runArduinoUpload(args) {
  return new Promise((resolve) => {
    const uploadArgs = [
      "upload",
      "-p",
      args.com,
      "--fqbn",
      args.fqbn,
      args.sketch,
      ...args.extraArgs,
    ];
    const child = spawn(args.arduinoCli, uploadArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        exitCode: null,
        error: String(error),
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? null : `arduino-cli exited with code ${code}`,
        stdout,
        stderr,
      });
    });
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const pausePayload = {
    __adapter_cmd: "pause",
    hold_s: args.holdS > 0 ? args.holdS : undefined,
  };

  const pauseAck = await sendControlCommand({
    host: args.host,
    controlPort: args.controlPort,
    payload: pausePayload,
  });

  await sleep(300);
  const upload = await runArduinoUpload(args);

  const resumeAck = await sendControlCommand({
    host: args.host,
    controlPort: args.controlPort,
    payload: { __adapter_cmd: "resume" },
  });

  console.log(
    JSON.stringify(
      {
        type: "upload_with_pause_result",
        ok: Boolean(upload.ok),
        pause_ack: pauseAck,
        upload,
        resume_ack: resumeAck,
        next_step: upload.ok
          ? "Upload completed and resume requested."
          : "Check arduino-cli stderr, COM occupancy, and sketch/fqbn values.",
      },
      null,
      2,
    ),
  );

  process.exit(upload.ok ? 0 : 1);
}

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        type: "upload_with_pause_fatal",
        ok: false,
        error: String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
