import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AlgorithmPipeline,
  PidBlock,
  SummarizerBlock,
} from "../algorithm_blocks_ts/dist/src/index.js";
import { startControlPlane } from "./control_plane.js";

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(BRIDGE_DIR, "config.json");

const DEFAULT_CONFIG = {
  telemetry: {
    host: "127.0.0.1",
    port: 9000,
  },
  summary: {
    keys: ["velocity", "pos", "value"],
    window: 64,
    interval_ms: 1000,
    events: {
      stable_delta_threshold: 0.25,
      stable_required_windows: 3,
      spike_delta_threshold: 3.0,
      oscillating_window: 6,
      oscillating_flip_threshold: 3,
    },
  },
  blocks: {
    summarizer: {
      enabled: true,
      config: {
        keys: ["velocity", "pos", "value"],
        window: 64,
        outputKey: "summary",
      },
    },
    pid: {
      enabled: false,
      config: {
        measurementKey: "velocity",
        setpoint: 0,
        kp: 1,
        ki: 0,
        kd: 0,
        dtSeconds: 0.05,
        outputKey: "control.target_pwm",
      },
    },
  },
};

const BLOCK_FACTORIES = {
  summarizer: () => new SummarizerBlock("summary"),
  pid: () => new PidBlock("pid"),
};

const BLOCK_ORDER = ["pid", "summarizer"];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKeys(keys, fallback) {
  if (!Array.isArray(keys)) return cloneJson(fallback);
  const out = keys
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length > 0 ? out : cloneJson(fallback);
}

function normalizeEventConfig(events, fallback) {
  const source = isObject(events) ? events : {};
  const next = {
    stable_delta_threshold: Number(
      source.stable_delta_threshold ?? fallback.stable_delta_threshold,
    ),
    stable_required_windows: Math.floor(
      Number(source.stable_required_windows ?? fallback.stable_required_windows),
    ),
    spike_delta_threshold: Number(
      source.spike_delta_threshold ?? fallback.spike_delta_threshold,
    ),
    oscillating_window: Math.floor(
      Number(source.oscillating_window ?? fallback.oscillating_window),
    ),
    oscillating_flip_threshold: Math.floor(
      Number(
        source.oscillating_flip_threshold ?? fallback.oscillating_flip_threshold,
      ),
    ),
  };

  if (!Number.isFinite(next.stable_delta_threshold) || next.stable_delta_threshold < 0) {
    next.stable_delta_threshold = fallback.stable_delta_threshold;
  }
  if (!Number.isFinite(next.spike_delta_threshold) || next.spike_delta_threshold < 0) {
    next.spike_delta_threshold = fallback.spike_delta_threshold;
  }
  if (!Number.isFinite(next.stable_required_windows) || next.stable_required_windows < 1) {
    next.stable_required_windows = fallback.stable_required_windows;
  }
  if (!Number.isFinite(next.oscillating_window) || next.oscillating_window < 2) {
    next.oscillating_window = fallback.oscillating_window;
  }
  if (
    !Number.isFinite(next.oscillating_flip_threshold) ||
    next.oscillating_flip_threshold < 1
  ) {
    next.oscillating_flip_threshold = fallback.oscillating_flip_threshold;
  }
  return next;
}

function loadConfigFile(configPath) {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) {
    throw new Error(`config must be a JSON object: ${configPath}`);
  }
  return parsed;
}

function mergeConfig(base, loaded) {
  const next = cloneJson(base);

  if (isObject(loaded.telemetry)) {
    if (typeof loaded.telemetry.host === "string" && loaded.telemetry.host.trim()) {
      next.telemetry.host = loaded.telemetry.host.trim();
    }
    if (Number.isFinite(Number(loaded.telemetry.port))) {
      next.telemetry.port = Number(loaded.telemetry.port);
    }
  }

  if (isObject(loaded.summary)) {
    if (Number.isFinite(Number(loaded.summary.window))) {
      next.summary.window = Number(loaded.summary.window);
    }
    if (Number.isFinite(Number(loaded.summary.interval_ms))) {
      next.summary.interval_ms = Number(loaded.summary.interval_ms);
    }
    next.summary.keys = normalizeKeys(loaded.summary.keys, next.summary.keys);
    next.summary.events = normalizeEventConfig(
      loaded.summary.events,
      next.summary.events,
    );
  }

  if (isObject(loaded.blocks)) {
    for (const [blockName, blockSpec] of Object.entries(loaded.blocks)) {
      if (!isObject(blockSpec)) continue;
      if (!isObject(next.blocks[blockName])) continue;

      if (typeof blockSpec.enabled === "boolean") {
        next.blocks[blockName].enabled = blockSpec.enabled;
      }
      if (isObject(blockSpec.config)) {
        next.blocks[blockName].config = {
          ...next.blocks[blockName].config,
          ...blockSpec.config,
        };
      }
    }
  }

  next.summary.window = Math.max(1, Math.floor(Number(next.summary.window)));
  next.summary.interval_ms = Math.max(
    100,
    Math.floor(Number(next.summary.interval_ms)),
  );
  next.summary.keys = normalizeKeys(next.summary.keys, DEFAULT_CONFIG.summary.keys);
  next.summary.events = normalizeEventConfig(
    next.summary.events,
    DEFAULT_CONFIG.summary.events,
  );
  next.telemetry.port = Math.max(1, Math.floor(Number(next.telemetry.port)));
  next.blocks.summarizer.config.keys = cloneJson(next.summary.keys);
  next.blocks.summarizer.config.window = next.summary.window;
  return next;
}

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG_PATH,
    host: null,
    port: null,
    intervalMs: null,
    window: null,
    keys: null,
    maxRuntimeS: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--config" && next) {
      out.configPath = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
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
    if (arg === "--interval-ms" && next) {
      out.intervalMs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--window" && next) {
      out.window = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--keys" && next) {
      out.keys = next
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--max-runtime-s" && next) {
      out.maxRuntimeS = Number(next);
      i += 1;
      continue;
    }
  }

  if (!Number.isFinite(out.maxRuntimeS) || out.maxRuntimeS < 0) {
    throw new Error(`Invalid --max-runtime-s: ${out.maxRuntimeS}`);
  }
  return out;
}

function toFrame(rawLine, parsedPayload) {
  const parsed =
    parsedPayload &&
    typeof parsedPayload === "object" &&
    parsedPayload.parsed &&
    typeof parsedPayload.parsed === "object" &&
    !Array.isArray(parsedPayload.parsed)
      ? parsedPayload.parsed
      : parsedPayload;

  return {
    timestamp:
      typeof parsedPayload?.timestamp === "number"
        ? parsedPayload.timestamp
        : Date.now() / 1000,
    raw: rawLine,
    parsed:
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
    meta:
      parsedPayload &&
      typeof parsedPayload === "object" &&
      parsedPayload.meta &&
      typeof parsedPayload.meta === "object" &&
      !Array.isArray(parsedPayload.meta)
        ? parsedPayload.meta
        : undefined,
  };
}

function pickSummaryFields(summaryObj) {
  const out = {};
  if (!summaryObj || typeof summaryObj !== "object") return out;

  for (const [key, snapshot] of Object.entries(summaryObj)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const mean = Number(snapshot.mean);
    const delta = Number(snapshot.delta);
    const min = Number(snapshot.min);
    const max = Number(snapshot.max);
    if (![mean, delta, min, max].every(Number.isFinite)) continue;
    out[key] = { mean, delta, min, max };
  }
  return out;
}

function createEventDetector(eventConfig) {
  let config = normalizeEventConfig(eventConfig, DEFAULT_CONFIG.summary.events);
  let stableWindows = 0;
  const signHistory = [];

  return {
    update(keysSummary) {
      const deltas = Object.values(keysSummary)
        .map((item) => Number(item?.delta))
        .filter((value) => Number.isFinite(value));

      if (deltas.length === 0) {
        return {
          stable: false,
          spike: false,
          oscillating: false,
        };
      }

      const maxAbsDelta = Math.max(...deltas.map((value) => Math.abs(value)));
      const aggregateDelta = deltas.reduce((acc, value) => acc + value, 0) / deltas.length;
      const sign = aggregateDelta > 0 ? 1 : aggregateDelta < 0 ? -1 : 0;

      if (maxAbsDelta < config.stable_delta_threshold) {
        stableWindows += 1;
      } else {
        stableWindows = 0;
      }

      if (sign !== 0) {
        signHistory.push(sign);
        while (signHistory.length > config.oscillating_window) {
          signHistory.shift();
        }
      }

      let flips = 0;
      for (let i = 1; i < signHistory.length; i += 1) {
        if (signHistory[i] !== signHistory[i - 1]) flips += 1;
      }

      return {
        stable: stableWindows >= config.stable_required_windows,
        spike: maxAbsDelta > config.spike_delta_threshold,
        oscillating: flips >= config.oscillating_flip_threshold,
      };
    },
    reset(nextConfig) {
      config = normalizeEventConfig(nextConfig, config);
      stableWindows = 0;
      signHistory.length = 0;
    },
    getConfig() {
      return cloneJson(config);
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedConfig = loadConfigFile(args.configPath);
  let runtimeConfig = mergeConfig(DEFAULT_CONFIG, loadedConfig);

  if (typeof args.host === "string" && args.host.trim()) {
    runtimeConfig.telemetry.host = args.host.trim();
  }
  if (Number.isFinite(args.port) && args.port > 0) {
    runtimeConfig.telemetry.port = Math.floor(args.port);
  }
  if (Number.isFinite(args.intervalMs) && args.intervalMs >= 100) {
    runtimeConfig.summary.interval_ms = Math.floor(args.intervalMs);
  }
  if (Number.isFinite(args.window) && args.window > 0) {
    runtimeConfig.summary.window = Math.floor(args.window);
    runtimeConfig.blocks.summarizer.config.window = runtimeConfig.summary.window;
  }
  if (Array.isArray(args.keys) && args.keys.length > 0) {
    runtimeConfig.summary.keys = normalizeKeys(args.keys, runtimeConfig.summary.keys);
    runtimeConfig.blocks.summarizer.config.keys = cloneJson(runtimeConfig.summary.keys);
  }

  let pipeline = null;
  let lineBuffer = "";
  let totalLines = 0;
  let totalFrames = 0;
  let parseErrors = 0;
  let framesSinceLastSummary = 0;
  let isClosing = false;
  let logTimer = null;

  const eventDetector = createEventDetector(runtimeConfig.summary.events);
  const socket = createConnection({
    host: runtimeConfig.telemetry.host,
    port: runtimeConfig.telemetry.port,
  });

  const buildPipeline = () => {
    const next = new AlgorithmPipeline({
      historySize: Math.max(256, runtimeConfig.summary.window * 4),
      statsWindow: runtimeConfig.summary.window,
    });
    for (const blockName of BLOCK_ORDER) {
      const spec = runtimeConfig.blocks[blockName];
      if (!spec || !spec.enabled) continue;
      const factory = BLOCK_FACTORIES[blockName];
      if (!factory) continue;
      const block = factory();
      block.init(spec.config ?? {});
      next.addBlock(block);
    }
    pipeline = next;
  };

  const getState = () => {
    const activeBlocks = Object.entries(runtimeConfig.blocks)
      .filter(([, value]) => Boolean(value?.enabled))
      .map(([name]) => name);
    return {
      telemetry: cloneJson(runtimeConfig.telemetry),
      summary: {
        ...cloneJson(runtimeConfig.summary),
        events: eventDetector.getConfig(),
      },
      blocks: cloneJson(runtimeConfig.blocks),
      active_blocks: activeBlocks,
    };
  };

  const restartLogTimer = () => {
    if (logTimer) clearInterval(logTimer);
    logTimer = setInterval(() => {
      if (!pipeline) return;
      const latest = pipeline.getLatest();
      const latestSummary = latest?.features?.summary ?? {};
      const compactKeys = pickSummaryFields(latestSummary);
      const events = eventDetector.update(compactKeys);

      console.log(
        JSON.stringify({
          type: "summary",
          ts: Date.now(),
          n: framesSinceLastSummary,
          keys: compactKeys,
          events,
        }),
      );
      framesSinceLastSummary = 0;
    }, runtimeConfig.summary.interval_ms);
  };

  const applyCommand = (command) => {
    const blockName = command.block_name;
    switch (command.cmd) {
      case "enable_block": {
        if (!runtimeConfig.blocks[blockName]) {
          throw new Error(`unknown block_name: ${blockName}`);
        }
        runtimeConfig.blocks[blockName].enabled = true;
        buildPipeline();
        return { applied: true };
      }
      case "disable_block": {
        if (!runtimeConfig.blocks[blockName]) {
          throw new Error(`unknown block_name: ${blockName}`);
        }
        runtimeConfig.blocks[blockName].enabled = false;
        buildPipeline();
        return { applied: true };
      }
      case "set_param": {
        if (blockName === "events") {
          runtimeConfig.summary.events[command.key] = command.value;
          runtimeConfig.summary.events = normalizeEventConfig(
            runtimeConfig.summary.events,
            DEFAULT_CONFIG.summary.events,
          );
          eventDetector.reset(runtimeConfig.summary.events);
          return { applied: true };
        }
        if (!runtimeConfig.blocks[blockName]) {
          throw new Error(`unknown block_name: ${blockName}`);
        }
        runtimeConfig.blocks[blockName].config[command.key] = command.value;
        if (blockName === "summarizer" && command.key === "keys") {
          runtimeConfig.summary.keys = normalizeKeys(
            command.value,
            runtimeConfig.summary.keys,
          );
          runtimeConfig.blocks.summarizer.config.keys = cloneJson(
            runtimeConfig.summary.keys,
          );
        }
        if (blockName === "summarizer" && command.key === "window") {
          const window = Math.max(1, Math.floor(Number(command.value)));
          runtimeConfig.summary.window = window;
          runtimeConfig.blocks.summarizer.config.window = window;
          eventDetector.reset(runtimeConfig.summary.events);
        }
        buildPipeline();
        return { applied: true };
      }
      case "set_keys": {
        runtimeConfig.summary.keys = normalizeKeys(
          command.keys,
          runtimeConfig.summary.keys,
        );
        runtimeConfig.blocks.summarizer.config.keys = cloneJson(
          runtimeConfig.summary.keys,
        );
        buildPipeline();
        return { applied: true };
      }
      case "set_window": {
        runtimeConfig.summary.window = Math.max(1, Math.floor(command.window));
        runtimeConfig.blocks.summarizer.config.window = runtimeConfig.summary.window;
        buildPipeline();
        eventDetector.reset(runtimeConfig.summary.events);
        return { applied: true };
      }
      case "set_interval_ms": {
        runtimeConfig.summary.interval_ms = Math.max(
          100,
          Math.floor(command.interval_ms),
        );
        restartLogTimer();
        return { applied: true };
      }
      default:
        throw new Error(`unsupported cmd: ${command.cmd}`);
    }
  };

  buildPipeline();
  restartLogTimer();

  const controlPlane = startControlPlane({
    applyCommand,
    getState,
  });

  const shutdown = (reason) => {
    if (isClosing) return;
    isClosing = true;
    controlPlane.stop();
    if (logTimer) clearInterval(logTimer);
    if (runtimeTimer) clearTimeout(runtimeTimer);
    console.log(
      JSON.stringify({
        type: "bridge_shutdown",
        reason,
        totalLines,
        totalFrames,
        parseErrors,
      }),
    );
    socket.end();
    socket.destroy();
    process.exit(0);
  };

  socket.on("connect", () => {
    console.log(
      JSON.stringify({
        type: "bridge_connected",
        host: runtimeConfig.telemetry.host,
        port: runtimeConfig.telemetry.port,
        config_path: args.configPath,
        interval_ms: runtimeConfig.summary.interval_ms,
        window: runtimeConfig.summary.window,
        keys: runtimeConfig.summary.keys,
      }),
    );
  });

  socket.on("data", (chunk) => {
    lineBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = lineBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const rawLine = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (!rawLine) continue;

      totalLines += 1;
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(rawLine);
      } catch {
        parseErrors += 1;
        continue;
      }
      if (
        !parsedPayload ||
        typeof parsedPayload !== "object" ||
        Array.isArray(parsedPayload)
      ) {
        continue;
      }

      if (!pipeline) continue;
      pipeline.process(toFrame(rawLine, parsedPayload));
      totalFrames += 1;
      framesSinceLastSummary += 1;
    }
  });

  socket.on("error", (error) => {
    console.error(
      JSON.stringify({
        type: "bridge_socket_error",
        message: String(error),
      }),
    );
    shutdown("socket_error");
  });

  socket.on("close", () => {
    shutdown("socket_closed");
  });

  const runtimeTimer =
    args.maxRuntimeS > 0
      ? setTimeout(() => shutdown("max_runtime"), args.maxRuntimeS * 1000)
      : null;

  process.on("SIGINT", () => shutdown("sigint"));
  process.on("SIGTERM", () => shutdown("sigterm"));
}

main();
