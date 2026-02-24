import process from "node:process";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKeys(keys) {
  if (!Array.isArray(keys)) return null;
  const out = keys
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length > 0 ? out : null;
}

export function validateCommand(command) {
  if (!isObject(command)) return { ok: false, error: "command must be a JSON object" };
  if (typeof command.cmd !== "string") {
    return { ok: false, error: "missing cmd" };
  }

  switch (command.cmd) {
    case "enable_block":
    case "disable_block":
      if (typeof command.block_name !== "string" || !command.block_name.trim()) {
        return { ok: false, error: "block_name must be a non-empty string" };
      }
      return { ok: true };

    case "set_param":
      if (typeof command.block_name !== "string" || !command.block_name.trim()) {
        return { ok: false, error: "block_name must be a non-empty string" };
      }
      if (typeof command.key !== "string" || !command.key.trim()) {
        return { ok: false, error: "key must be a non-empty string" };
      }
      if (!Object.prototype.hasOwnProperty.call(command, "value")) {
        return { ok: false, error: "value is required" };
      }
      return { ok: true };

    case "set_keys": {
      const keys = normalizeKeys(command.keys);
      if (!keys) return { ok: false, error: "keys must be a non-empty string array" };
      return { ok: true };
    }

    case "set_window":
      if (!Number.isInteger(command.window) || command.window <= 0) {
        return { ok: false, error: "window must be an integer > 0" };
      }
      return { ok: true };

    case "set_interval_ms":
      if (!Number.isInteger(command.interval_ms) || command.interval_ms < 100) {
        return { ok: false, error: "interval_ms must be an integer >= 100" };
      }
      return { ok: true };

    case "set_profile":
      if (typeof command.profile !== "string" || !command.profile.trim()) {
        return { ok: false, error: "profile must be a non-empty string" };
      }
      return { ok: true };

    case "save_state":
      if (
        Object.prototype.hasOwnProperty.call(command, "path") &&
        (typeof command.path !== "string" || !command.path.trim())
      ) {
        return { ok: false, error: "path must be a non-empty string when provided" };
      }
      return { ok: true };

    case "load_state":
      if (
        Object.prototype.hasOwnProperty.call(command, "path") &&
        (typeof command.path !== "string" || !command.path.trim())
      ) {
        return { ok: false, error: "path must be a non-empty string when provided" };
      }
      return { ok: true };

    case "set_autosave":
      if (typeof command.enabled !== "boolean") {
        return { ok: false, error: "enabled must be boolean" };
      }
      return { ok: true };

    default:
      return { ok: false, error: `unsupported cmd: ${command.cmd}` };
  }
}

function makeAckEnvelope(body) {
  return JSON.stringify(body) + "\n";
}

export function startControlPlane({
  applyCommand,
  getState,
  input = process.stdin,
  output = process.stdout,
}) {
  input.setEncoding("utf8");
  input.resume();

  let buffer = "";

  const writeAck = (payload) => {
    output.write(makeAckEnvelope(payload));
  };

  const onData = (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const rawLine = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!rawLine) continue;

      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch (error) {
        writeAck({
          type: "control_ack",
          ok: false,
          error: "invalid_json",
          detail: String(error),
        });
        continue;
      }

      const valid = validateCommand(parsed);
      if (!valid.ok) {
        writeAck({
          type: "control_ack",
          ok: false,
          cmd: parsed?.cmd ?? null,
          error: valid.error,
        });
        continue;
      }

      try {
        const result = applyCommand(parsed);
        writeAck({
          type: "control_ack",
          ok: true,
          cmd: parsed.cmd,
          result,
          state: getState(),
        });
      } catch (error) {
        writeAck({
          type: "control_ack",
          ok: false,
          cmd: parsed.cmd,
          error: "apply_failed",
          detail: String(error),
          state: getState(),
        });
      }
    }
  };

  input.on("data", onData);

  return {
    stop() {
      input.off("data", onData);
    },
  };
}
