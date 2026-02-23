export const DEFAULT_LLM_POLICY = {
  unsafePassthrough: false,
  allowTargets: ["target_velocity", "motor_pwm", "servo_pos"],
  maxCommandsPerSec: 5,
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class LlmRateLimiter {
  constructor(maxCommandsPerSec = 5) {
    this.maxCommandsPerSec = Math.max(1, Math.floor(Number(maxCommandsPerSec)));
    this.timestamps = [];
  }

  consume(nowMs = Date.now()) {
    const cutoff = nowMs - 1000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxCommandsPerSec) {
      const oldest = this.timestamps[0];
      const retryAfterMs = Math.max(1, Math.ceil(1000 - (nowMs - oldest)));
      return {
        ok: false,
        retryAfterMs,
      };
    }
    this.timestamps.push(nowMs);
    return { ok: true, retryAfterMs: 0 };
  }

  state(nowMs = Date.now()) {
    const cutoff = nowMs - 1000;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
    return {
      maxCommandsPerSec: this.maxCommandsPerSec,
      inCurrentWindow: this.timestamps.length,
      remaining: Math.max(0, this.maxCommandsPerSec - this.timestamps.length),
    };
  }
}

export function validateLlmCommand(command) {
  if (!isObject(command)) {
    return { ok: false, error: "command must be a JSON object" };
  }
  if (command.cmd === "stop") {
    return { ok: true };
  }
  if (command.cmd !== "set") {
    return { ok: false, error: "cmd must be set|stop" };
  }
  if (
    typeof command.target !== "string" ||
    !["target_velocity", "motor_pwm", "servo_pos"].includes(command.target)
  ) {
    return {
      ok: false,
      error: "target must be target_velocity|motor_pwm|servo_pos",
    };
  }
  if (!isFiniteNumber(command.value)) {
    return { ok: false, error: "value must be a finite number" };
  }
  return { ok: true };
}

export function translateLlmCommand(command, policy = DEFAULT_LLM_POLICY) {
  const validation = validateLlmCommand(command);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
    };
  }

  if (command.cmd === "stop") {
    return {
      ok: true,
      translated: {
        servo_action: "center",
        target_velocity: 0,
        motor_pwm: 0,
      },
      normalized: { cmd: "stop" },
    };
  }

  if (
    !policy.unsafePassthrough &&
    !policy.allowTargets.includes(command.target)
  ) {
    return {
      ok: false,
      error: `target not allowlisted: ${command.target}`,
    };
  }

  switch (command.target) {
    case "target_velocity":
      return {
        ok: true,
        translated: { target_velocity: Number(command.value) },
        normalized: {
          cmd: "set",
          target: "target_velocity",
          value: Number(command.value),
        },
      };
    case "motor_pwm":
      return {
        ok: true,
        translated: { motor_pwm: Math.round(Number(command.value)) },
        normalized: {
          cmd: "set",
          target: "motor_pwm",
          value: Math.round(Number(command.value)),
        },
      };
    case "servo_pos":
      return {
        ok: true,
        translated: {
          servo_angle: clamp(Math.round(Number(command.value)), 0, 180),
        },
        normalized: {
          cmd: "set",
          target: "servo_pos",
          value: clamp(Math.round(Number(command.value)), 0, 180),
        },
      };
    default:
      return {
        ok: false,
        error: "unsupported target",
      };
  }
}
