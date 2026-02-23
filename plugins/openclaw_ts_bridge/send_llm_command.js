import { createConnection } from "node:net";
import process from "node:process";

import {
  DEFAULT_LLM_POLICY,
  LlmRateLimiter,
  translateLlmCommand,
} from "./llm_command_translator.js";

function parseArgs(argv) {
  const out = {
    host: "127.0.0.1",
    port: 9001,
    responseTimeoutMs: 300,
    unsafePassthrough: false,
    allowTargets: [...DEFAULT_LLM_POLICY.allowTargets],
    maxRate: DEFAULT_LLM_POLICY.maxCommandsPerSec,
    cmd: "set",
    target: null,
    value: null,
    json: null,
    stdin: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      out.host = next;
      i += 1;
      continue;
    }
    if (arg === "--port" && next) {
      out.port = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--response-timeout-ms" && next) {
      out.responseTimeoutMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--unsafe-passthrough") {
      out.unsafePassthrough = true;
      continue;
    }
    if (arg === "--allow-targets" && next) {
      out.allowTargets = next
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--max-rate" && next) {
      out.maxRate = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--cmd" && next) {
      out.cmd = next;
      i += 1;
      continue;
    }
    if (arg === "--target" && next) {
      out.target = next;
      i += 1;
      continue;
    }
    if (arg === "--value" && next) {
      out.value = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--json" && next) {
      out.json = next;
      i += 1;
      continue;
    }
    if (arg === "--stdin") {
      out.stdin = true;
      continue;
    }
  }

  if (!Number.isFinite(out.port) || out.port <= 0) {
    throw new Error(`invalid --port: ${out.port}`);
  }
  if (!Number.isFinite(out.responseTimeoutMs) || out.responseTimeoutMs < 0) {
    throw new Error(`invalid --response-timeout-ms: ${out.responseTimeoutMs}`);
  }
  if (!Number.isFinite(out.maxRate) || out.maxRate <= 0) {
    throw new Error(`invalid --max-rate: ${out.maxRate}`);
  }
  return out;
}

function buildCommandFromArgs(options) {
  if (options.json) {
    return JSON.parse(options.json);
  }
  if (options.cmd === "stop") {
    return { cmd: "stop" };
  }
  if (!options.target) {
    throw new Error("missing --target for set command");
  }
  if (!Number.isFinite(options.value)) {
    throw new Error("missing or invalid --value for set command");
  }
  return {
    cmd: "set",
    target: options.target,
    value: Number(options.value),
  };
}

function sendControlPayload({ host, port, payload, responseTimeoutMs }) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let done = false;
    let recvBuffer = "";

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(payload) + "\n");
      if (responseTimeoutMs <= 0) {
        finish({ sent: true, response: null });
      }
    });

    socket.on("data", (chunk) => {
      recvBuffer += chunk.toString("utf8");
      if (!recvBuffer.includes("\n")) return;
      const line = recvBuffer.split("\n")[0].trim();
      if (!line) {
        finish({ sent: true, response: null });
        return;
      }
      try {
        finish({ sent: true, response: JSON.parse(line) });
      } catch {
        finish({ sent: true, response: line });
      }
    });

    socket.on("error", (error) => {
      finish({ sent: false, error: String(error), response: null });
    });

    socket.setTimeout(responseTimeoutMs, () => {
      finish({ sent: true, response: null });
    });
  });
}

async function runOne(command, context) {
  const limiterState = context.rateLimiter.consume();
  if (!limiterState.ok) {
    const ack = {
      type: "llm_command_ack",
      ok: false,
      input: command,
      error: "llm_rate_limited",
      retry_after_ms: limiterState.retryAfterMs,
      limiter: context.rateLimiter.state(),
    };
    console.log(JSON.stringify(ack));
    return;
  }

  const translated = translateLlmCommand(command, context.policy);
  if (!translated.ok) {
    console.log(
      JSON.stringify({
        type: "llm_command_ack",
        ok: false,
        input: command,
        error: translated.error,
        limiter: context.rateLimiter.state(),
      }),
    );
    return;
  }

  const sendResult = await sendControlPayload({
    host: context.host,
    port: context.port,
    payload: translated.translated,
    responseTimeoutMs: context.responseTimeoutMs,
  });

  console.log(
    JSON.stringify({
      type: "llm_command_ack",
      ok: Boolean(sendResult.sent),
      input: command,
      translated: translated.translated,
      send: sendResult,
      limiter: context.rateLimiter.state(),
    }),
  );
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const context = {
    host: options.host,
    port: options.port,
    responseTimeoutMs: options.responseTimeoutMs,
    policy: {
      unsafePassthrough: options.unsafePassthrough,
      allowTargets: options.allowTargets,
      maxCommandsPerSec: Math.floor(options.maxRate),
    },
    rateLimiter: new LlmRateLimiter(Math.floor(options.maxRate)),
  };

  if (options.stdin) {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    let buffer = "";
    process.stdin.on("data", async (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!raw) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          console.log(
            JSON.stringify({
              type: "llm_command_ack",
              ok: false,
              input: raw,
              error: "invalid_json",
              detail: String(error),
            }),
          );
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await runOne(parsed, context);
      }
    });
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    return;
  }

  const command = buildCommandFromArgs(options);
  await runOne(command, context);
}

run().catch((error) => {
  console.error(
    JSON.stringify({
      type: "llm_command_ack",
      ok: false,
      error: String(error),
    }),
  );
  process.exit(1);
});
