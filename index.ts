import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import {
  PythonLauncher,
  listSerialPorts,
  chooseBestSerialPort,
} from "./src/launcher.js";
import { TelemetryClient, ControlClient } from "./src/tcp-client.js";
import type { PluginConfig, TelemetryFrame } from "./src/types.js";

export type {
  PluginConfig,
  ReadyMessage,
  TelemetryFrame,
  AdapterStatus,
  SerialPortInfo,
} from "./src/types.js";

let launcher: PythonLauncher | null = null;
let telemetryClient: TelemetryClient | null = null;
let controlClient: ControlClient | null = null;
let log: OpenClawPluginApi["logger"];

const MOTION_TEMPLATES = [
  "slow_sway",
  "fast_jitter",
  "sweep",
  "center_stop",
] as const;
type MotionTemplateName = (typeof MOTION_TEMPLATES)[number];
const IMU_ACCEL_KEYS = ["ax", "ay", "az"] as const;
const IMU_GYRO_KEYS = ["gx", "gy", "gz"] as const;
const DEFAULT_POLL_COUNT = 20;
const DEFAULT_OBSERVE_MS = 1200;
const DEFAULT_OBSERVE_MAX_FRAMES = 80;
const STOP_TARGET_DEFAULT = 90;

interface StopVerification {
  verified: boolean | null;
  mode: "servo_feedback" | "motor_pwm_feedback" | "unverifiable";
  reason: string;
  last_servo?: number;
  servo_range?: number;
  target_angle?: number;
  last_motor_pwm?: number;
  motor_pwm_range?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

type NormalizedSerialCommand =
  | {
      mode: "json";
      payload: Record<string, unknown>;
      source: string;
    }
  | {
      mode: "raw";
      payload: string;
      source: string;
    };

function normalizeSerialSendCommand(
  candidate: unknown
): NormalizedSerialCommand | null {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return {
      mode: "json",
      payload: candidate as Record<string, unknown>,
      source: "json_object",
    };
  }

  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return {
      mode: "raw",
      payload: String(Math.trunc(candidate)),
      source: "numeric_scalar",
    };
  }

  if (typeof candidate !== "string") {
    return null;
  }

  const text = candidate.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        mode: "json",
        payload: parsed as Record<string, unknown>,
        source: "json_string",
      };
    }
  } catch {
    // fall through to shorthand raw
  }

  const upper = text.toUpperCase();
  if (
    /^A-?\d{1,4}$/.test(upper) ||
    /^P-?\d{1,5}$/.test(upper) ||
    /^-?\d{1,4}$/.test(text)
  ) {
    return {
      mode: "raw",
      payload: upper.startsWith("A") || upper.startsWith("P") ? upper : text,
      source: "raw_shorthand",
    };
  }

  return {
    mode: "raw",
    payload: text,
    source: "raw_text",
  };
}

function compactPortInfo(configuredPort: string | null, allPorts: ReturnType<PythonLauncher["getLastProbePorts"]>) {
  return {
    selected: configuredPort,
    available: allPorts.map((port) => port.device),
  };
}

function buildMotionSequence(
  template: MotionTemplateName,
  options: {
    minPwm: number;
    maxPwm: number;
    centerPwm: number;
  }
): number[] {
  const minPwm = clamp(options.minPwm, 500, 2500);
  const maxPwm = clamp(options.maxPwm, 500, 2500);
  const centerPwm = clamp(options.centerPwm, 500, 2500);

  switch (template) {
    case "slow_sway":
      return [minPwm, centerPwm, maxPwm, centerPwm];
    case "fast_jitter":
      return [
        centerPwm - 120,
        centerPwm + 120,
        centerPwm - 80,
        centerPwm + 80,
        centerPwm,
      ].map((value) => clamp(value, 500, 2500));
    case "sweep":
      return [minPwm, maxPwm];
    case "center_stop":
      return [centerPwm, 0];
    default:
      return [centerPwm];
  }
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getParsedRecord(frame: TelemetryFrame): Record<string, unknown> {
  if (frame.parsed && typeof frame.parsed === "object" && !Array.isArray(frame.parsed)) {
    return frame.parsed;
  }
  return {};
}

function readNumericField(frame: TelemetryFrame, key: string): number | null {
  const top = asFiniteNumber(frame[key]);
  if (top !== null) return top;
  const parsed = getParsedRecord(frame);
  return asFiniteNumber(parsed[key]);
}

function rangeOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min;
}

function buildFramePreview(frame: TelemetryFrame | null): Record<string, unknown> | null {
  if (!frame) return null;
  const parsed = getParsedRecord(frame);
  const parsedPreview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      parsedPreview[key] = value;
    }
    if (Object.keys(parsedPreview).length >= 10) break;
  }
  return {
    ts: frame.ts ?? frame.timestamp ?? null,
    raw: String(frame.raw ?? "").slice(0, 160),
    parsed: parsedPreview,
  };
}

function summarizeTelemetryFrames(
  frames: TelemetryFrame[],
  bufferedCount: number
): Record<string, unknown> {
  const observedNumericKeys = new Set<string>();
  const accelSeen = new Set<string>();
  const gyroSeen = new Set<string>();
  const servoValues: number[] = [];
  const motorValues: number[] = [];

  for (const frame of frames) {
    const parsed = getParsedRecord(frame);
    for (const [key, value] of Object.entries(parsed)) {
      if (asFiniteNumber(value) !== null) observedNumericKeys.add(key.toLowerCase());
    }

    for (const key of IMU_ACCEL_KEYS) {
      if (readNumericField(frame, key) !== null) accelSeen.add(key);
    }
    for (const key of IMU_GYRO_KEYS) {
      if (readNumericField(frame, key) !== null) gyroSeen.add(key);
    }

    const servo = readNumericField(frame, "servo");
    if (servo !== null) servoValues.push(servo);
    const motor = readNumericField(frame, "motor_pwm");
    if (motor !== null) motorValues.push(motor);
  }

  const accelDetected = IMU_ACCEL_KEYS.every((key) => accelSeen.has(key));
  const gyroDetected = IMU_GYRO_KEYS.every((key) => gyroSeen.has(key));
  const imuDetected = accelDetected || gyroDetected;

  const latest = frames.length > 0 ? frames[frames.length - 1] : null;
  const servoRange = rangeOf(servoValues);
  const motorRange = rangeOf(motorValues);

  let diagnosis = "no_telemetry_frames";
  let nextStep =
    "Call serial_connect, then ensure firmware emits telemetry lines over serial.";
  if (frames.length > 0 && !imuDetected) {
    diagnosis = "telemetry_present_but_no_imu_fields";
    nextStep =
      "Firmware is streaming, but no ax/ay/az(/gx/gy/gz) fields were seen. Enable IMU output in firmware (for example IMU_ON / TELEMETRY_ON).";
  } else if (frames.length > 0 && imuDetected) {
    diagnosis = "imu_telemetry_detected";
    nextStep = "IMU telemetry is flowing.";
  }

  return {
    frame_count: frames.length,
    buffered_count: bufferedCount,
    observed_numeric_keys: Array.from(observedNumericKeys).sort(),
    imu: {
      detected: imuDetected,
      accel_detected: accelDetected,
      gyro_detected: gyroDetected,
    },
    servo: {
      samples: servoValues.length,
      last: servoValues.length > 0 ? servoValues[servoValues.length - 1] : null,
      range: servoRange,
      moving: servoRange !== null ? servoRange > 2 : null,
    },
    motor_pwm: {
      samples: motorValues.length,
      last: motorValues.length > 0 ? motorValues[motorValues.length - 1] : null,
      range: motorRange,
    },
    latest: buildFramePreview(latest),
    diagnosis,
    next_step: nextStep,
  };
}

async function collectTelemetryFrames(
  durationMs: number,
  maxFrames: number
): Promise<TelemetryFrame[]> {
  if (!telemetryClient) return [];
  const safeDuration = Math.max(0, Math.min(Math.floor(durationMs), 8000));
  const safeMax = Math.max(1, Math.min(Math.floor(maxFrames), 400));
  const deadline = Date.now() + safeDuration;
  const collected: TelemetryFrame[] = [];

  while (collected.length < safeMax) {
    const need = safeMax - collected.length;
    const batch = telemetryClient.pollFrames(need);
    if (batch.length > 0) {
      collected.push(...batch);
      if (collected.length >= safeMax) break;
    }
    if (Date.now() >= deadline) break;
    await sleep(40);
  }
  return collected.slice(0, safeMax);
}

function pwmToApproxAngle(pwm: number): number {
  const normalized = clamp(Math.round(((pwm - 500) / 2000) * 180), 0, 180);
  return normalized;
}

async function sendBestEffortStopSequence(options: {
  targetAngle: number;
  repeats: number;
  intervalMs: number;
}): Promise<void> {
  if (!controlClient) {
    throw new Error("Not connected. Call serial_connect first.");
  }
  const targetAngle = clamp(Math.round(options.targetAngle), 0, 180);
  const repeats = Math.max(1, Math.min(Math.floor(options.repeats), 8));
  const intervalMs = Math.max(20, Math.min(Math.floor(options.intervalMs), 1000));

  for (let i = 0; i < repeats; i += 1) {
    // Send both plain angle and A<angle> to cover common UNO parser variants.
    controlClient.sendRawLine(String(targetAngle));
    controlClient.sendRawLine(`A${targetAngle}`);
    controlClient.sendCommand({ motor_pwm: 0 });
    controlClient.sendCommand({ target_velocity: 0 });
    await sleep(intervalMs);
  }
}

function evaluateStopVerification(
  frames: TelemetryFrame[],
  targetAngle: number
): StopVerification {
  const servoValues = frames
    .map((frame) => readNumericField(frame, "servo"))
    .filter((value): value is number => value !== null);
  const motorValues = frames
    .map((frame) => readNumericField(frame, "motor_pwm"))
    .filter((value): value is number => value !== null);

  if (servoValues.length > 0) {
    const last = servoValues[servoValues.length - 1];
    const servoRange = rangeOf(servoValues) ?? 0;
    const nearTarget = Math.abs(last - targetAngle) <= 4;
    const stable = servoRange <= 4;
    return {
      verified: nearTarget && stable,
      mode: "servo_feedback",
      last_servo: last,
      servo_range: servoRange,
      target_angle: targetAngle,
      reason:
        nearTarget && stable
          ? "servo_stable_near_target"
          : "servo_not_stable_or_not_near_target",
    };
  }

  if (motorValues.length > 0) {
    const last = motorValues[motorValues.length - 1];
    const motorRange = rangeOf(motorValues) ?? 0;
    const nearZero = Math.abs(last) <= 1;
    const stable = motorRange <= 2;
    return {
      verified: nearZero && stable,
      mode: "motor_pwm_feedback",
      last_motor_pwm: last,
      motor_pwm_range: motorRange,
      reason:
        nearZero && stable
          ? "motor_pwm_stable_near_zero"
          : "motor_pwm_not_stable_or_not_zero",
    };
  }

  return {
    verified: null,
    mode: "unverifiable",
    reason: "no_servo_or_motor_feedback_fields",
  };
}

async function connectAdapter(config: PluginConfig) {
  launcher = new PythonLauncher(config);
  const ready = await launcher.start();

  const host = config.host ?? "127.0.0.1";
  const resolvedPort = launcher.getResolvedPort() ?? config.serialPort ?? null;
  const portInfo = compactPortInfo(resolvedPort, launcher.getLastProbePorts());

  telemetryClient = new TelemetryClient();
  controlClient = new ControlClient();
  try {
    await telemetryClient.connect(host, ready.telemetry_port);
    await controlClient.connect(host, ready.control_port);
  } catch (error) {
    telemetryClient?.disconnect();
    telemetryClient = null;
    controlClient?.disconnect();
    controlClient = null;
    await launcher.stop();
    launcher = null;
    throw new Error(
      [
        "Adapter subprocess started, but channel attachment failed.",
        toErrorMessage(error),
      ].join(" ")
    );
  }

  const result = {
    status: "connected" as const,
    serial_port: resolvedPort,
    serial_ports_available: portInfo.available,
    telemetry_port: ready.telemetry_port,
    control_port: ready.control_port,
    pid: ready.pid,
  };
  log.info(
    JSON.stringify({
      event: "serial_adapter_connected",
      serial_port: result.serial_port,
      serial_ports_available: result.serial_ports_available,
      telemetry_port: result.telemetry_port,
      control_port: result.control_port,
      pid: result.pid,
    })
  );
  return result;
}

async function disconnectAdapter() {
  telemetryClient?.disconnect();
  telemetryClient = null;
  controlClient?.disconnect();
  controlClient = null;
  await launcher?.stop();
  launcher = null;
  log.info(
    JSON.stringify({
      event: "serial_adapter_disconnected",
    })
  );
}

const plugin = {
  id: "serial-adapter",
  name: "Serial Adapter",
  description:
    "Serial device telemetry adapter with ring-buffer frame assembly and split TCP channels",

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as unknown as PluginConfig;
    log = api.logger;

    api.registerService({
      id: "serial-adapter",
      async start() {
        const autoDetect = config.autoDetectSerialPort !== false;
        if (!config.serialPort && !autoDetect) {
          log.info(
            "serialPort is not configured and autoDetectSerialPort=false. Service stays idle until serial_connect."
          );
          return;
        }
        try {
          await connectAdapter(config);
        } catch (error) {
          // Service should not crash the full gateway on boot.
          log.warn(
            JSON.stringify({
              event: "serial_adapter_autostart_skipped",
              error: toErrorMessage(error),
              next_step:
                "Run serial_probe, ensure COM is not occupied, then call serial_connect.",
            })
          );
        }
      },
      async stop() {
        await disconnectAdapter();
      },
    });

    api.registerTool({
      name: "serial_probe",
      label: "Probe Serial",
      description: "List serial ports and suggest a likely device port",
      parameters: Type.Object({
        portHints: Type.Optional(
          Type.Array(Type.String({ description: "Port matching hint" }))
        ),
      }),
      async execute(_toolCallId, params) {
        try {
          const probeConfig: PluginConfig = {
            ...config,
            portHints: params.portHints ?? config.portHints,
          };
          const ports = await listSerialPorts(probeConfig);
          const suggested = chooseBestSerialPort(ports, probeConfig.portHints);
          return jsonResult({
            ports,
            suggested: suggested?.device ?? null,
          });
        } catch (error) {
          return jsonResult({
            error: toErrorMessage(error),
            next_step:
              "Ensure Python + pyserial are available, then run serial_probe again.",
          });
        }
      },
    });

    api.registerTool({
      name: "serial_connect",
      label: "Connect Serial",
      description:
        "Connect to serial device and start telemetry adapter (supports auto-detect)",
      parameters: Type.Object({
        port: Type.Optional(
          Type.String({ description: "Serial port path (e.g. COM3 or /dev/ttyUSB0)" })
        ),
        baudrate: Type.Optional(
          Type.Number({ description: "Baud rate (default 115200)" })
        ),
        autoDetect: Type.Optional(
          Type.Boolean({ description: "Enable auto serial port detection" })
        ),
        portHints: Type.Optional(
          Type.Array(Type.String({ description: "Port matching hint" }))
        ),
      }),
      async execute(_toolCallId, params) {
        if (launcher?.isRunning()) {
          return jsonResult({ status: "already_connected" });
        }

        const dynamicConfig: PluginConfig = {
          ...config,
          serialPort: params.port ?? config.serialPort,
          baudrate: params.baudrate ?? config.baudrate,
          autoDetectSerialPort:
            params.autoDetect ?? config.autoDetectSerialPort ?? true,
          portHints: params.portHints ?? config.portHints,
        };

        try {
          return jsonResult(await connectAdapter(dynamicConfig));
        } catch (error) {
          return jsonResult({
            error: toErrorMessage(error),
            next_step:
              "Run serial_probe, close Arduino Serial Monitor/uploader on the same COM, then retry serial_connect.",
          });
        }
      },
    });

    api.registerTool({
      name: "serial_poll",
      label: "Poll Telemetry",
      description:
        "Read telemetry frames and return a compact IMU/servo summary (set includeFrames=true only for debug)",
      parameters: Type.Object({
        count: Type.Optional(
          Type.Number({ description: "Max number of frames to return (default 20)" })
        ),
        includeFrames: Type.Optional(
          Type.Boolean({
            description:
              "Include raw frame objects in response. Keep false for LLM observer mode.",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!telemetryClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const requestedCount =
          typeof params.count === "number" && Number.isFinite(params.count)
            ? Math.max(1, Math.min(Math.floor(params.count), 200))
            : DEFAULT_POLL_COUNT;
        const includeFrames = params.includeFrames === true;
        const frames = telemetryClient.pollFrames(requestedCount);
        const summary = summarizeTelemetryFrames(frames, telemetryClient.bufferedCount());
        if (includeFrames) {
          return jsonResult({ frames, count: frames.length, summary });
        }
        return jsonResult({ count: frames.length, summary });
      },
    });

    api.registerTool({
      name: "serial_quickcheck",
      label: "Quick Check Serial+IMU",
      description:
        "One-shot diagnostic: auto-connect (optional), sample telemetry, and report if IMU fields (ax/ay/az or gx/gy/gz) are actually present.",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description: "Auto call serial_connect when currently disconnected (default true).",
          })
        ),
        port: Type.Optional(
          Type.String({ description: "Serial port path override when auto-connect is used." })
        ),
        baudrate: Type.Optional(
          Type.Number({ description: "Baud rate override when auto-connect is used." })
        ),
        observeMs: Type.Optional(
          Type.Number({ description: "Observe window in ms (default 1200)", minimum: 200, maximum: 8000 })
        ),
        maxFrames: Type.Optional(
          Type.Number({ description: "Max frames to sample (default 80)", minimum: 1, maximum: 400 })
        ),
        triggerProbe: Type.Optional(
          Type.Boolean({
            description:
              "Send probe raw commands (IMU?/STATUS?) before observing, useful when firmware is idle.",
          })
        ),
        includeFrames: Type.Optional(
          Type.Boolean({ description: "Include sampled frames for debug." })
        ),
      }),
      async execute(_toolCallId, params) {
        const autoConnect = params.autoConnect !== false;
        if (!launcher?.isRunning()) {
          if (!autoConnect) {
            return jsonResult({
              status: "disconnected",
              next_step: "Call serial_connect first, then run serial_quickcheck again.",
            });
          }
          const dynamicConfig: PluginConfig = {
            ...config,
            serialPort: params.port ?? config.serialPort,
            baudrate: params.baudrate ?? config.baudrate,
            autoDetectSerialPort: true,
          };
          try {
            await connectAdapter(dynamicConfig);
          } catch (error) {
            return jsonResult({
              status: "disconnected",
              error: toErrorMessage(error),
              next_step:
                "Run serial_probe, close Arduino Serial Monitor/uploader on the same COM, then retry serial_connect.",
            });
          }
        }

        if (!telemetryClient || !controlClient) {
          return jsonResult({
            status: "degraded",
            error: "Adapter connected state is inconsistent (missing telemetry/control channel).",
          });
        }

        if (params.triggerProbe !== false) {
          try {
            controlClient.sendRawLine("IMU?");
            controlClient.sendRawLine("STATUS?");
          } catch {
            // Probe is best-effort only.
          }
        }

        const observeMs =
          typeof params.observeMs === "number"
            ? Math.max(200, Math.min(Math.floor(params.observeMs), 8000))
            : DEFAULT_OBSERVE_MS;
        const maxFrames =
          typeof params.maxFrames === "number"
            ? Math.max(1, Math.min(Math.floor(params.maxFrames), 400))
            : DEFAULT_OBSERVE_MAX_FRAMES;
        const frames = await collectTelemetryFrames(observeMs, maxFrames);
        const summary = summarizeTelemetryFrames(frames, telemetryClient.bufferedCount());
        const includeFrames = params.includeFrames === true;

        return jsonResult({
          status: "connected",
          port: launcher?.getResolvedPort() ?? config.serialPort ?? null,
          observe_ms: observeMs,
          sampled_frames: frames.length,
          summary,
          frames: includeFrames ? frames : undefined,
        });
      },
    });

    api.registerTool({
      name: "serial_send",
      label: "Send Command",
      description: "Send a control command to serial device",
      parameters: Type.Object({
        command: Type.Unknown({
          description:
            "Control payload. Supports JSON object or shorthand text (A90/P1500/90).",
        }),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const normalized = normalizeSerialSendCommand(params.command);
        if (!normalized) {
          return jsonResult({
            error:
              "Invalid command format. Use JSON object or shorthand text (A90/P1500/90).",
          });
        }

        if (normalized.mode === "json") {
          controlClient.sendCommand(normalized.payload);
        } else {
          controlClient.sendRawLine(normalized.payload);
        }

        return jsonResult({
          status: "sent",
          mode: normalized.mode,
          source: normalized.source,
          normalized: normalized.payload,
        });
      },
    });

    api.registerTool({
      name: "serial_stop",
      label: "Stop And Verify",
      description:
        "Best-effort stop sequence (center + zero outputs) with telemetry verification to avoid false 'stopped' claims.",
      parameters: Type.Object({
        targetAngle: Type.Optional(
          Type.Number({ description: "Servo center target angle (default 90)", minimum: 0, maximum: 180 })
        ),
        repeats: Type.Optional(
          Type.Number({ description: "How many stop packets to send (default 2)", minimum: 1, maximum: 8 })
        ),
        intervalMs: Type.Optional(
          Type.Number({ description: "Delay between stop packets (default 120ms)", minimum: 20, maximum: 1000 })
        ),
        verifyMs: Type.Optional(
          Type.Number({ description: "Telemetry verification window in ms (default 1200)", minimum: 200, maximum: 8000 })
        ),
        includeFrames: Type.Optional(
          Type.Boolean({ description: "Include verification frames for debug." })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient || !telemetryClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }

        const targetAngle =
          typeof params.targetAngle === "number"
            ? clamp(Math.round(params.targetAngle), 0, 180)
            : STOP_TARGET_DEFAULT;
        const repeats =
          typeof params.repeats === "number"
            ? Math.max(1, Math.min(Math.floor(params.repeats), 8))
            : 2;
        const intervalMs =
          typeof params.intervalMs === "number"
            ? Math.max(20, Math.min(Math.floor(params.intervalMs), 1000))
            : 120;
        const verifyMs =
          typeof params.verifyMs === "number"
            ? Math.max(200, Math.min(Math.floor(params.verifyMs), 8000))
            : DEFAULT_OBSERVE_MS;
        const includeFrames = params.includeFrames === true;

        try {
          await sendBestEffortStopSequence({
            targetAngle,
            repeats,
            intervalMs,
          });
        } catch (error) {
          return jsonResult({
            status: "stop_send_failed",
            error: toErrorMessage(error),
            next_step:
              "Check serial connection and control channel, then retry serial_stop.",
          });
        }

        const frames = await collectTelemetryFrames(verifyMs, DEFAULT_OBSERVE_MAX_FRAMES);
        const summary = summarizeTelemetryFrames(frames, telemetryClient.bufferedCount());
        const verification = evaluateStopVerification(frames, targetAngle);

        return jsonResult({
          status: "stop_sequence_sent",
          target_angle: targetAngle,
          repeats,
          interval_ms: intervalMs,
          verify_ms: verifyMs,
          verification,
          summary,
          frames: includeFrames ? frames : undefined,
          next_step:
            verification.verified === true
              ? "Stop verified from telemetry."
              : "If motor is still moving, firmware may ignore runtime serial stop commands. Flash firmware that accepts stop/idle commands.",
        });
      },
    });

    api.registerTool({
      name: "serial_motion_template",
      label: "Servo Motion Template",
      description:
        "Run built-in servo motion templates (slow_sway, fast_jitter, sweep, center_stop)",
      parameters: Type.Object({
        template: Type.Union(
          MOTION_TEMPLATES.map((name) => Type.Literal(name)),
          { description: "Built-in motion template name" }
        ),
        repeats: Type.Optional(
          Type.Number({ description: "How many times to replay the template", minimum: 1 })
        ),
        intervalMs: Type.Optional(
          Type.Number({ description: "Delay between PWM writes (ms)", minimum: 10 })
        ),
        minPwm: Type.Optional(
          Type.Number({ description: "Lower PWM bound", minimum: 500, maximum: 2500 })
        ),
        maxPwm: Type.Optional(
          Type.Number({ description: "Upper PWM bound", minimum: 500, maximum: 2500 })
        ),
        centerPwm: Type.Optional(
          Type.Number({ description: "Center PWM", minimum: 500, maximum: 2500 })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient || !telemetryClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }

        const template = params.template as MotionTemplateName;
        const repeats = Math.max(1, Math.floor(params.repeats ?? 1));
        const intervalMs = Math.max(10, Math.floor(params.intervalMs ?? 350));
        const sequence = buildMotionSequence(template, {
          minPwm: params.minPwm ?? 1100,
          maxPwm: params.maxPwm ?? 1900,
          centerPwm: params.centerPwm ?? 1500,
        });

        if (template === "center_stop") {
          const targetAngle = pwmToApproxAngle(params.centerPwm ?? 1500);
          await sendBestEffortStopSequence({
            targetAngle,
            repeats,
            intervalMs,
          });
          const frames = await collectTelemetryFrames(
            Math.max(400, Math.min(2000, intervalMs * repeats + 600)),
            DEFAULT_OBSERVE_MAX_FRAMES
          );
          const summary = summarizeTelemetryFrames(frames, telemetryClient.bufferedCount());
          const verification = evaluateStopVerification(frames, targetAngle);
          return jsonResult({
            status: "sent",
            template,
            repeats,
            intervalMs,
            sequence,
            totalCommands: sequence.length * repeats,
            verification,
            summary,
            note:
              verification.verified === true
                ? "center_stop verified from telemetry."
                : "center_stop command sent but not verified from telemetry.",
          });
        }

        for (let r = 0; r < repeats; r += 1) {
          for (const pwm of sequence) {
            controlClient.sendCommand({ motor_pwm: pwm });
            await sleep(intervalMs);
          }
        }

        return jsonResult({
          status: "sent",
          template,
          repeats,
          intervalMs,
          sequence,
          totalCommands: sequence.length * repeats,
        });
      },
    });

    api.registerTool({
      name: "serial_status",
      label: "Adapter Status",
      description:
        "Get adapter runtime status plus a compact snapshot of recent telemetry/IMU visibility",
      parameters: Type.Object({}),
      async execute() {
        if (!launcher?.isRunning()) {
          return jsonResult({
            status: "disconnected",
            next_step: "Call serial_connect, then serial_quickcheck.",
          });
        }
        const previewFrames = telemetryClient?.snapshotFrames(DEFAULT_POLL_COUNT) ?? [];
        const summary = summarizeTelemetryFrames(
          previewFrames,
          telemetryClient?.bufferedCount() ?? 0
        );
        return jsonResult({
          status: "connected",
          port: launcher.getResolvedPort() ?? config.serialPort ?? null,
          ready: launcher.getReadyMessage(),
          telemetry_summary: summary,
        });
      },
    });

    api.registerTool({
      name: "serial_pause",
      label: "Pause Serial",
      description:
        "Temporarily release COM for firmware upload (adapter stays alive)",
      parameters: Type.Object({
        seconds: Type.Optional(
          Type.Number({
            description: "Pause duration seconds (default 25, 0 = manual resume)",
            minimum: 0,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const holdS =
          typeof params.seconds === "number"
            ? Math.max(0, Math.min(params.seconds, 300))
            : 25;
        controlClient.sendCommand({
          __adapter_cmd: "pause",
          hold_s: holdS > 0 ? holdS : undefined,
        });
        return jsonResult({
          status: "pause_requested",
          hold_s: holdS > 0 ? holdS : null,
        });
      },
    });

    api.registerTool({
      name: "serial_resume",
      label: "Resume Serial",
      description: "Re-open COM after upload",
      parameters: Type.Object({}),
      async execute() {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        controlClient.sendCommand({ __adapter_cmd: "resume" });
        return jsonResult({ status: "resume_requested" });
      },
    });
  },
};

export default plugin;
