import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import {
  PythonLauncher,
  listSerialPorts,
  chooseBestSerialPort,
} from "./src/launcher.js";
import { TelemetryClient, ControlClient } from "./src/tcp-client.js";
import type { ControlAckPayload } from "./src/tcp-client.js";
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
let bridgeSessionId = 0;
let bridgeSessionStartedAtMs: number | null = null;
let bridgeReconnectCount = 0;

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
const DEFAULT_SEMANTIC_VERIFY_MS = 1000;
const DEFAULT_SEMANTIC_SOURCE_ID = "serial_intent";
const AUTO_PROBE_SEQUENCE = [
  "STATUS?",
  "IMU_ON",
  "TELEMETRY_ON",
  "STREAM_ON",
  "IMU?",
] as const;
const DEFAULT_ACK_TIMEOUT_MS = 1200;
const DEFAULT_TOOL_AUTO_CONNECT = true;
const DEFAULT_AUTO_RESUME_ON_USE = true;

type SemanticIntensity = "small" | "medium" | "large";
type SemanticIntent =
  | "status"
  | "stop"
  | "center"
  | "nudge_left"
  | "nudge_right"
  | "nod"
  | "shake"
  | "unknown";

const INTENSITY_TO_DELTA: Record<SemanticIntensity, number> = {
  small: 8,
  medium: 15,
  large: 25,
};

let connectInFlight: Promise<void> | null = null;

interface StopVerification {
  verified: boolean | null;
  mode: "servo_feedback" | "motor_pwm_feedback" | "unverifiable";
  reason: string;
  last_servo?: number;
  servo_range?: number;
  servo_tail_range?: number;
  target_angle?: number;
  last_motor_pwm?: number;
  motor_pwm_range?: number;
}

interface BridgeEnsureOptions {
  autoConnect?: boolean;
  autoResume?: boolean;
  port?: string;
  baudrate?: number;
  portHints?: string[];
}

interface BridgeEnsureResult {
  connected: boolean;
  auto_connected: boolean;
  resumed: boolean;
  serial_port: string | null;
  runtime_status: Record<string, unknown> | null;
  bridge_session: Record<string, unknown>;
  error?: string;
  next_step?: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isBridgeConnected(): boolean {
  return Boolean(telemetryClient?.isConnected() && controlClient?.isConnected());
}

function resolveToolAutoConnect(
  config: PluginConfig,
  override?: boolean
): boolean {
  if (typeof override === "boolean") return override;
  if (typeof config.toolAutoConnect === "boolean") return config.toolAutoConnect;
  return DEFAULT_TOOL_AUTO_CONNECT;
}

function resolveAutoResumeOnUse(
  config: PluginConfig,
  override?: boolean
): boolean {
  if (typeof override === "boolean") return override;
  if (typeof config.autoResumeOnUse === "boolean") return config.autoResumeOnUse;
  return DEFAULT_AUTO_RESUME_ON_USE;
}

function resolveAckTimeoutMs(config: PluginConfig): number {
  const configured = config.bridgeAckTimeoutMs;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(100, Math.min(Math.floor(configured), 5000));
  }
  return DEFAULT_ACK_TIMEOUT_MS;
}

function buildDynamicConfig(
  config: PluginConfig,
  options: Pick<BridgeEnsureOptions, "port" | "baudrate" | "portHints">
): PluginConfig {
  return {
    ...config,
    serialPort: options.port ?? config.serialPort,
    baudrate: options.baudrate ?? config.baudrate,
    portHints: options.portHints ?? config.portHints,
    autoDetectSerialPort: config.autoDetectSerialPort ?? true,
  };
}

function extractRuntimeStatus(ack: ControlAckPayload | null): Record<string, unknown> | null {
  const record = asRecord(ack);
  if (!record) return null;
  return asRecord(record.status);
}

function extractRuntimeCapabilities(
  ack: ControlAckPayload | null
): Record<string, unknown> | null {
  const record = asRecord(ack);
  if (!record) return null;
  return asRecord(record.capabilities);
}

function extractSerialPort(status: Record<string, unknown> | null): string | null {
  const value = status?.serial_port;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveKnownSerialPort(
  config: PluginConfig,
  runtimeStatus?: Record<string, unknown> | null
): string | null {
  return (
    launcher?.getResolvedPort() ??
    extractSerialPort(runtimeStatus ?? null) ??
    config.serialPort ??
    null
  );
}

async function sendRuntimeCommandWithAck(
  command: Record<string, unknown>,
  config: PluginConfig
): Promise<ControlAckPayload | null> {
  if (!controlClient) return null;
  try {
    return await controlClient.sendCommandWithAck(command, resolveAckTimeoutMs(config));
  } catch {
    return null;
  }
}

async function requestRuntimeStatus(
  config: PluginConfig
): Promise<Record<string, unknown> | null> {
  const ack = await sendRuntimeCommandWithAck({ __adapter_cmd: "status" }, config);
  return extractRuntimeStatus(ack);
}

async function requestRuntimeCapabilities(
  config: PluginConfig
): Promise<Record<string, unknown> | null> {
  const ack = await sendRuntimeCommandWithAck(
    { __adapter_cmd: "capabilities" },
    config
  );
  return extractRuntimeCapabilities(ack);
}

async function tryAttachExistingBridge(
  config: PluginConfig
): Promise<{
  attached: boolean;
  runtimeStatus: Record<string, unknown> | null;
  serialPort: string | null;
}> {
  const telemetryPort = config.telemetryPort ?? 9000;
  const controlPort = config.controlPort ?? 9001;
  try {
    await attachAdapterChannels(config, {
      telemetry_port: telemetryPort,
      control_port: controlPort,
    });
  } catch {
    return {
      attached: false,
      runtimeStatus: null,
      serialPort: null,
    };
  }

  const capabilities = await requestRuntimeCapabilities(config);
  const runtimeStatus = await requestRuntimeStatus(config);
  const looksLikeAdapter =
    Boolean(capabilities?.runtime_protocol_version) ||
    Boolean(
      runtimeStatus &&
        Object.prototype.hasOwnProperty.call(runtimeStatus, "serial_connected") &&
        Object.prototype.hasOwnProperty.call(runtimeStatus, "serial_port")
    );
  const serialPort = extractSerialPort(runtimeStatus);
  const requestedPort =
    typeof config.serialPort === "string" ? config.serialPort.trim() : "";

  if (!looksLikeAdapter) {
    telemetryClient?.disconnect();
    telemetryClient = null;
    controlClient?.disconnect();
    controlClient = null;
    return {
      attached: false,
      runtimeStatus: null,
      serialPort: null,
    };
  }

  if (
    requestedPort &&
    serialPort &&
    requestedPort.toLowerCase() !== serialPort.toLowerCase()
  ) {
    telemetryClient?.disconnect();
    telemetryClient = null;
    controlClient?.disconnect();
    controlClient = null;
    return {
      attached: false,
      runtimeStatus: null,
      serialPort: null,
    };
  }

  return {
    attached: true,
    runtimeStatus,
    serialPort,
  };
}

function getBridgeSessionState(): Record<string, unknown> {
  return {
    session_id: bridgeSessionId,
    session_started_at_ms: bridgeSessionStartedAtMs,
    reconnect_count: bridgeReconnectCount,
  };
}

function markNewBridgeSession(): void {
  bridgeSessionId += 1;
  bridgeReconnectCount += 1;
  bridgeSessionStartedAtMs = Date.now();
}

async function attachAdapterChannels(
  config: PluginConfig,
  ready: { telemetry_port: number; control_port: number }
): Promise<void> {
  const host = config.host ?? "127.0.0.1";

  telemetryClient?.disconnect();
  telemetryClient = null;
  controlClient?.disconnect();
  controlClient = null;

  const nextTelemetry = new TelemetryClient();
  const nextControl = new ControlClient();
  try {
    await nextTelemetry.connect(host, ready.telemetry_port);
    await nextControl.connect(host, ready.control_port);
  } catch (error) {
    nextTelemetry.disconnect();
    nextControl.disconnect();
    throw new Error(
      [
        "Adapter subprocess is running, but channel re-attach failed.",
        toErrorMessage(error),
      ].join(" ")
    );
  }

  telemetryClient = nextTelemetry;
  controlClient = nextControl;
}

async function ensureBridgeReady(
  config: PluginConfig,
  options: BridgeEnsureOptions = {}
): Promise<BridgeEnsureResult> {
  const autoConnect = resolveToolAutoConnect(config, options.autoConnect);
  const autoResume = resolveAutoResumeOnUse(config, options.autoResume);
  const dynamicConfig = buildDynamicConfig(config, options);
  let autoConnected = false;
  let resumed = false;

  if (!isBridgeConnected()) {
    if (!autoConnect) {
      return {
        connected: false,
        auto_connected: false,
        resumed: false,
        serial_port: resolveKnownSerialPort(dynamicConfig),
        runtime_status: null,
        bridge_session: getBridgeSessionState(),
        error: "Not connected and autoConnect is disabled.",
        next_step: "Call serial_connect or enable toolAutoConnect.",
      };
    }

    const connectTask = async () => {
      if (launcher?.isRunning()) {
        const ready = launcher.getReadyMessage();
        if (ready) {
          await attachAdapterChannels(dynamicConfig, ready);
          return;
        }

        await disconnectAdapter();
      }
      await connectAdapter(dynamicConfig);
    };

    if (connectInFlight) {
      try {
        await connectInFlight;
      } catch (error) {
        return {
          connected: false,
          auto_connected: false,
          resumed: false,
          serial_port: resolveKnownSerialPort(dynamicConfig),
          runtime_status: null,
          bridge_session: getBridgeSessionState(),
          error: toErrorMessage(error),
          next_step:
            "Run serial_probe, close Arduino Serial Monitor/uploader on the same COM, then retry.",
        };
      }
    } else {
      connectInFlight = connectTask().finally(() => {
        if (connectInFlight) connectInFlight = null;
      });
      try {
        await connectInFlight;
      } catch (error) {
        return {
          connected: false,
          auto_connected: false,
          resumed: false,
          serial_port: resolveKnownSerialPort(dynamicConfig),
          runtime_status: null,
          bridge_session: getBridgeSessionState(),
          error: toErrorMessage(error),
          next_step:
            "Run serial_probe, close Arduino Serial Monitor/uploader on the same COM, then retry.",
        };
      }
    }
    autoConnected = true;
  }

  if (!isBridgeConnected()) {
    return {
      connected: false,
      auto_connected: autoConnected,
      resumed: false,
      serial_port: launcher?.getResolvedPort() ?? dynamicConfig.serialPort ?? null,
      runtime_status: null,
      bridge_session: getBridgeSessionState(),
      error: "Adapter is not connected (missing telemetry/control channel).",
      next_step: "Call serial_connect and verify adapter startup logs.",
    };
  }

  let runtimeStatus = await requestRuntimeStatus(dynamicConfig);
  if (autoResume && runtimeStatus?.serial_paused === true) {
    await sendRuntimeCommandWithAck({ __adapter_cmd: "resume" }, dynamicConfig);
    resumed = true;
    runtimeStatus = await requestRuntimeStatus(dynamicConfig);
  }

  return {
    connected: true,
    auto_connected: autoConnected,
    resumed,
    serial_port: resolveKnownSerialPort(dynamicConfig, runtimeStatus),
    runtime_status: runtimeStatus,
    bridge_session: getBridgeSessionState(),
  };
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

function normalizeIntentText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function parseSemanticIntensity(
  text: string,
  override?: SemanticIntensity
): SemanticIntensity {
  if (override) return override;

  const smallKeywords = ["一點", "一點點", "微", "稍微", "小", "slight", "little"];
  if (includesAny(text, smallKeywords)) return "small";

  const largeKeywords = ["很多", "大幅", "大一點", "強", "快一點", "more", "larger", "faster"];
  if (includesAny(text, largeKeywords)) return "large";

  return "medium";
}

function parseDeltaOverride(text: string, explicitDelta?: number): number | null {
  if (typeof explicitDelta === "number" && Number.isFinite(explicitDelta)) {
    return Math.max(1, Math.min(Math.floor(Math.abs(explicitDelta)), 60));
  }

  const match = text.match(/(-?\d{1,3})\s*(?:deg|degree|度)?/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.max(1, Math.min(Math.floor(Math.abs(parsed)), 60));
  return safe;
}

function parseAbsoluteAngle(text: string, explicitAngle?: number): number | null {
  if (typeof explicitAngle === "number" && Number.isFinite(explicitAngle)) {
    return clamp(Math.round(explicitAngle), 0, 180);
  }
  const absoluteHints = ["到", "設", "set", "angle", "角度", "position", "pos"];
  if (!includesAny(text, absoluteHints)) return null;

  const match = text.match(/(-?\d{1,3})\s*(?:deg|degree|度)?/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.round(parsed), 0, 180);
}

function detectSemanticIntent(input: string): SemanticIntent {
  const text = normalizeIntentText(input);

  if (!text) return "unknown";

  if (includesAny(text, ["狀態", "觀測", "觀察", "summary", "status", "imu", "偵測", "check"])) {
    return "status";
  }
  if (includesAny(text, ["停", "停止", "stop", "靜止", "別動", "hold"])) {
    return "stop";
  }
  if (includesAny(text, ["回中", "置中", "center", "中間"])) {
    return "center";
  }
  if (includesAny(text, ["點頭", "nod"])) {
    return "nod";
  }
  if (includesAny(text, ["搖頭", "shake"])) {
    return "shake";
  }
  if (includesAny(text, ["往左", "左轉", "向左", "left"])) {
    return "nudge_left";
  }
  if (includesAny(text, ["往右", "右轉", "向右", "right"])) {
    return "nudge_right";
  }
  return "unknown";
}

function resolveServoAngleFromTelemetryFallback(): number {
  const latest = telemetryClient?.snapshotFrames(1)[0] ?? null;
  const measured = latest ? readNumericField(latest, "servo") : null;
  if (measured === null) return STOP_TARGET_DEFAULT;
  return clamp(Math.round(measured), 0, 180);
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

function flushTelemetryBacklog(maxFrames = 400): number {
  if (!telemetryClient) return 0;
  const safeMax = Math.max(1, Math.min(Math.floor(maxFrames), 1000));
  return telemetryClient.pollFrames(safeMax).length;
}

interface ObservedTelemetryWindow {
  frames: TelemetryFrame[];
  summary: Record<string, unknown>;
}

async function observeTelemetryWindow(
  durationMs: number,
  maxFrames = DEFAULT_OBSERVE_MAX_FRAMES
): Promise<ObservedTelemetryWindow> {
  const frames = await collectTelemetryFrames(durationMs, maxFrames);
  return {
    frames,
    summary: summarizeTelemetryFrames(
      frames,
      telemetryClient?.bufferedCount() ?? 0
    ),
  };
}

function extractRuntimeDiagnosis(
  runtimeStatus: Record<string, unknown> | null
): Record<string, unknown> | null {
  const diag = asRecord(runtimeStatus?.diagnosis);
  if (!diag) return null;
  const code = typeof diag.code === "string" ? diag.code : null;
  if (!code) return null;
  return {
    code,
    severity: typeof diag.severity === "string" ? diag.severity : null,
    detail: typeof diag.detail === "string" ? diag.detail : null,
    next_step: typeof diag.next_step === "string" ? diag.next_step : null,
    auto_repair: asRecord(diag.auto_repair),
  };
}

function mergeRuntimeDiagnosisIntoSummary(
  summary: Record<string, unknown>,
  runtimeStatus: Record<string, unknown> | null,
  frameCount: number
): Record<string, unknown> {
  const runtimeDiagnosis = extractRuntimeDiagnosis(runtimeStatus);
  const merged: Record<string, unknown> = { ...(summary ?? {}) };
  if (!runtimeDiagnosis) return merged;

  const runtimeCode =
    typeof runtimeDiagnosis.code === "string" ? runtimeDiagnosis.code : null;
  const runtimeNextStep =
    typeof runtimeDiagnosis.next_step === "string"
      ? runtimeDiagnosis.next_step
      : null;
  const observedDiagnosis =
    typeof merged.diagnosis === "string" ? merged.diagnosis : null;

  const shouldOverride =
    runtimeCode !== null &&
    runtimeCode !== "ok" &&
    (frameCount <= 0 ||
      observedDiagnosis === null ||
      observedDiagnosis === "no_telemetry_frames");
  if (shouldOverride) {
    merged.diagnosis = runtimeCode;
    if (runtimeNextStep) merged.next_step = runtimeNextStep;
  }
  merged.runtime_diagnosis = runtimeDiagnosis;
  return merged;
}

function enrichUnverifiableVerification(
  verification: StopVerification,
  runtimeStatus: Record<string, unknown> | null
): {
  verification: StopVerification;
  runtime_diagnosis?: Record<string, unknown>;
  next_step?: string;
} {
  const runtimeDiagnosis = extractRuntimeDiagnosis(runtimeStatus);
  if (!runtimeDiagnosis) return { verification };
  if (verification.mode !== "unverifiable") {
    return { verification, runtime_diagnosis: runtimeDiagnosis };
  }

  const runtimeCode =
    typeof runtimeDiagnosis.code === "string" ? runtimeDiagnosis.code : null;
  const runtimeNextStep =
    typeof runtimeDiagnosis.next_step === "string"
      ? runtimeDiagnosis.next_step
      : null;
  if (!runtimeCode || runtimeCode === "ok") {
    return { verification, runtime_diagnosis: runtimeDiagnosis };
  }

  const enriched: StopVerification = {
    ...verification,
    reason: `unverifiable_runtime_${runtimeCode}`,
  };
  return {
    verification: enriched,
    runtime_diagnosis: runtimeDiagnosis,
    next_step: runtimeNextStep ?? undefined,
  };
}

function optionalFrames(
  frames: TelemetryFrame[],
  includeFrames?: boolean
): TelemetryFrame[] | undefined {
  return includeFrames === true ? frames : undefined;
}

function pwmToApproxAngle(pwm: number): number {
  const normalized = clamp(Math.round(((pwm - 500) / 2000) * 180), 0, 180);
  return normalized;
}

interface ControlSourceContext {
  sourceId?: string;
  priority?: number;
  leaseMs?: number;
}

function toControlSourceContext(
  params: { sourceId?: unknown; priority?: unknown; leaseMs?: unknown },
  defaults?: ControlSourceContext
): ControlSourceContext | undefined {
  const sourceId =
    typeof params.sourceId === "string" && params.sourceId.trim().length > 0
      ? params.sourceId.trim()
      : defaults?.sourceId;
  const priority =
    typeof params.priority === "number" && Number.isFinite(params.priority)
      ? params.priority
      : defaults?.priority;
  const leaseMs =
    typeof params.leaseMs === "number" && Number.isFinite(params.leaseMs)
      ? params.leaseMs
      : defaults?.leaseMs;

  if (
    typeof sourceId !== "string" &&
    typeof priority !== "number" &&
    typeof leaseMs !== "number"
  ) {
    return undefined;
  }

  return { sourceId, priority, leaseMs };
}

function buildControlSourceMeta(
  context?: ControlSourceContext
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const sourceId = context?.sourceId?.trim();
  if (sourceId) meta.source_id = sourceId.slice(0, 64);
  if (typeof context?.priority === "number" && Number.isFinite(context.priority)) {
    meta.priority = clamp(Math.floor(context.priority), -100, 100);
  }
  if (typeof context?.leaseMs === "number" && Number.isFinite(context.leaseMs)) {
    meta.lease_ms = clamp(Math.floor(context.leaseMs), 200, 120000);
  }
  return meta;
}

function sendManagedRawLine(line: string, context?: ControlSourceContext): void {
  if (!controlClient) {
    throw new Error("Not connected. Call serial_connect first.");
  }
  const meta = buildControlSourceMeta(context);
  if (Object.keys(meta).length === 0) {
    controlClient.sendRawLine(line);
    return;
  }
  controlClient.sendCommand({
    cmd: "raw_line",
    line,
    ...meta,
  });
}

function sendManagedJsonCommand(
  payload: Record<string, unknown>,
  context?: ControlSourceContext
): void {
  if (!controlClient) {
    throw new Error("Not connected. Call serial_connect first.");
  }
  const meta = buildControlSourceMeta(context);
  controlClient.sendCommand({
    ...payload,
    ...meta,
  });
}

async function sendProbeBurst(options?: {
  source?: ControlSourceContext;
  spacingMs?: number;
  lines?: readonly string[];
}): Promise<void> {
  const lines = options?.lines?.length ? options.lines : AUTO_PROBE_SEQUENCE;
  const spacingMs =
    typeof options?.spacingMs === "number" && Number.isFinite(options.spacingMs)
      ? Math.max(0, Math.min(Math.floor(options.spacingMs), 500))
      : 60;
  for (const line of lines) {
    sendManagedRawLine(String(line), options?.source);
    if (spacingMs > 0) {
      await sleep(spacingMs);
    }
  }
}

async function sendBestEffortStopSequence(options: {
  targetAngle: number;
  repeats: number;
  intervalMs: number;
  source?: ControlSourceContext;
}): Promise<void> {
  if (!controlClient) {
    throw new Error("Not connected. Call serial_connect first.");
  }
  const targetAngle = clamp(Math.round(options.targetAngle), 0, 180);
  const repeats = Math.max(1, Math.min(Math.floor(options.repeats), 8));
  const intervalMs = Math.max(20, Math.min(Math.floor(options.intervalMs), 1000));

  for (let i = 0; i < repeats; i += 1) {
    // Motor-style stop first, then servo-safe center/hold to avoid firmware
    // variants mapping motor_pwm=0 to an endpoint angle.
    sendManagedJsonCommand({ motor_pwm: 0 }, options.source);
    sendManagedJsonCommand({ target_velocity: 0 }, options.source);
    sendManagedRawLine("STOP", options.source);
    sendManagedRawLine("SWEEP_OFF", options.source);
    sendManagedRawLine("CENTER", options.source);
    // Send both plain angle and A<angle> to cover common UNO parser variants.
    sendManagedRawLine(String(targetAngle), options.source);
    sendManagedRawLine(`A${targetAngle}`, options.source);
    sendManagedRawLine("HOLD", options.source);
    await sleep(intervalMs);
  }
}

async function sendServoAngleBestEffort(
  targetAngle: number,
  source?: ControlSourceContext
): Promise<void> {
  if (!controlClient) {
    throw new Error("Not connected. Call serial_connect first.");
  }
  const clamped = clamp(Math.round(targetAngle), 0, 180);
  sendManagedRawLine(String(clamped), source);
  await sleep(20);
  sendManagedRawLine(`A${clamped}`, source);
}

function evaluateStopVerification(
  frames: TelemetryFrame[],
  targetAngle: number,
  mode: "target" | "stop" = "target"
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
    const tailWindow = servoValues.slice(-Math.min(6, servoValues.length));
    const servoTailRange = rangeOf(tailWindow) ?? servoRange;
    const nearTarget = Math.abs(last - targetAngle) <= 4;
    const stable = servoTailRange <= 3;
    const verified = mode === "stop" ? stable : nearTarget && stable;
    return {
      verified,
      mode: "servo_feedback",
      last_servo: last,
      servo_range: servoRange,
      servo_tail_range: servoTailRange,
      target_angle: targetAngle,
      reason:
        mode === "stop"
          ? verified
            ? "servo_tail_stable_no_motion"
            : "servo_still_moving"
          : nearTarget && stable
            ? "servo_tail_stable_near_target"
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

async function executeSemanticIntent(options: {
  instruction: string;
  verifyMs?: number;
  intensity?: SemanticIntensity;
  delta?: number;
  targetAngle?: number;
  includeFrames?: boolean;
  source?: ControlSourceContext;
}): Promise<Record<string, unknown>> {
  const text = normalizeIntentText(options.instruction);
  const intent = detectSemanticIntent(text);
  const verifyMs =
    typeof options.verifyMs === "number" && Number.isFinite(options.verifyMs)
      ? Math.max(300, Math.min(Math.floor(options.verifyMs), 8000))
      : DEFAULT_SEMANTIC_VERIFY_MS;
  const includeFrames = options.includeFrames === true;

  if (intent === "unknown") {
    return {
      status: "intent_unrecognized",
      intent,
      instruction: options.instruction,
      next_step:
        "Try phrases like: 往左一點 / 往右一點 / 停下來 / 回中 / 點頭 / 搖頭 / 看狀態",
    };
  }

  if (intent === "status") {
    const observed = await observeTelemetryWindow(verifyMs);
    return {
      status: "ok",
      intent,
      action: "observe_only",
      summary: observed.summary,
      frames: optionalFrames(observed.frames, includeFrames),
    };
  }

  if (intent === "stop") {
    flushTelemetryBacklog();
    await sendBestEffortStopSequence({
      targetAngle: STOP_TARGET_DEFAULT,
      repeats: 2,
      intervalMs: 120,
      source: options.source,
    });
    const observed = await observeTelemetryWindow(verifyMs);
    const verification = evaluateStopVerification(
      observed.frames,
      STOP_TARGET_DEFAULT,
      "stop"
    );
    return {
      status: "ok",
      intent,
      action: "best_effort_stop",
      target_angle: STOP_TARGET_DEFAULT,
      verification,
      summary: observed.summary,
      frames: optionalFrames(observed.frames, includeFrames),
    };
  }

  if (intent === "center") {
    const target = parseAbsoluteAngle(text, options.targetAngle) ?? STOP_TARGET_DEFAULT;
    flushTelemetryBacklog();
    await sendServoAngleBestEffort(target, options.source);
    const observed = await observeTelemetryWindow(verifyMs);
    const verification = evaluateStopVerification(observed.frames, target);
    return {
      status: "ok",
      intent,
      action: "set_center",
      target_angle: target,
      verification,
      summary: observed.summary,
      frames: optionalFrames(observed.frames, includeFrames),
    };
  }

  if (intent === "nudge_left" || intent === "nudge_right") {
    const current = resolveServoAngleFromTelemetryFallback();
    const intensity = parseSemanticIntensity(text, options.intensity);
    const delta = parseDeltaOverride(text, options.delta) ?? INTENSITY_TO_DELTA[intensity];
    const sign = intent === "nudge_left" ? -1 : 1;
    const absoluteOverride = parseAbsoluteAngle(text, options.targetAngle);
    const target =
      absoluteOverride !== null ? absoluteOverride : clamp(current + sign * delta, 0, 180);

    flushTelemetryBacklog();
    await sendServoAngleBestEffort(target, options.source);
    const observed = await observeTelemetryWindow(verifyMs);
    const verification = evaluateStopVerification(observed.frames, target);
    return {
      status: "ok",
      intent,
      action: "nudge_servo",
      from_angle: current,
      target_angle: target,
      delta: Math.abs(target - current),
      intensity,
      verification,
      summary: observed.summary,
      frames: optionalFrames(observed.frames, includeFrames),
    };
  }

  const sequence =
    intent === "nod" ? [90, 75, 100, 80, 90] : [90, 70, 110, 75, 105, 90];
  flushTelemetryBacklog();
  for (const angle of sequence) {
    await sendServoAngleBestEffort(angle, options.source);
    await sleep(180);
  }
  const observed = await observeTelemetryWindow(verifyMs);
  const verification = evaluateStopVerification(observed.frames, 90);
  return {
    status: "ok",
    intent,
    action: intent === "nod" ? "motion_nod" : "motion_shake",
    sequence,
    verification,
    summary: observed.summary,
    frames: optionalFrames(observed.frames, includeFrames),
  };
}

async function connectAdapter(config: PluginConfig) {
  const existing = await tryAttachExistingBridge(config);
  if (existing.attached) {
    markNewBridgeSession();
    let availablePorts: string[] = [];
    try {
      availablePorts = (await listSerialPorts(config)).map((port) => port.device);
    } catch {
      // Keep lightweight attach path even when probe fails.
    }
    const resolvedPort = existing.serialPort ?? resolveKnownSerialPort(config, existing.runtimeStatus);
    if (resolvedPort && !availablePorts.includes(resolvedPort)) {
      availablePorts = [resolvedPort, ...availablePorts];
    }
    const result = {
      status: "connected" as const,
      bridge_mode: "attached_existing" as const,
      serial_port: resolvedPort,
      serial_ports_available: availablePorts,
      telemetry_port: config.telemetryPort ?? 9000,
      control_port: config.controlPort ?? 9001,
      pid: null,
      runtime_status: existing.runtimeStatus,
      bridge_session: getBridgeSessionState(),
    };
    log.info(
      JSON.stringify({
        event: "serial_adapter_attached_existing",
        bridge_session: getBridgeSessionState(),
        serial_port: result.serial_port,
        serial_ports_available: result.serial_ports_available,
        telemetry_port: result.telemetry_port,
        control_port: result.control_port,
      })
    );
    return result;
  }

  launcher = new PythonLauncher(config);
  const ready = await launcher.start();
  markNewBridgeSession();

  const resolvedPort = launcher.getResolvedPort() ?? config.serialPort ?? null;
  const portInfo = compactPortInfo(resolvedPort, launcher.getLastProbePorts());

  try {
    await attachAdapterChannels(config, ready);
  } catch (error) {
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
    bridge_session: getBridgeSessionState(),
  };
  log.info(
    JSON.stringify({
      event: "serial_adapter_connected",
      bridge_session: getBridgeSessionState(),
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
      bridge_session: getBridgeSessionState(),
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
        const dynamicConfig: PluginConfig = {
          ...config,
          serialPort: params.port ?? config.serialPort,
          baudrate: params.baudrate ?? config.baudrate,
          autoDetectSerialPort:
            params.autoDetect ?? config.autoDetectSerialPort ?? true,
          portHints: params.portHints ?? config.portHints,
        };

        if (launcher?.isRunning()) {
          if (isBridgeConnected()) {
            return jsonResult({
              status: "already_connected",
              serial_port: launcher.getResolvedPort() ?? dynamicConfig.serialPort ?? null,
              bridge_session: getBridgeSessionState(),
            });
          }

          const ready = launcher.getReadyMessage();
          if (ready) {
            try {
              await attachAdapterChannels(dynamicConfig, ready);
              return jsonResult({
                status: "channels_reattached",
                serial_port: launcher.getResolvedPort() ?? dynamicConfig.serialPort ?? null,
                telemetry_port: ready.telemetry_port,
                control_port: ready.control_port,
                bridge_session: getBridgeSessionState(),
              });
            } catch (error) {
              return jsonResult({
                status: "reattach_failed",
                error: toErrorMessage(error),
                next_step:
                  "Retry serial_connect. If still failing, run serial_bridge_sync or restart gateway.",
              });
            }
          }

          await disconnectAdapter();
        }

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
      name: "serial_intent",
      label: "Semantic Intent Control",
      description:
        "Execute natural-language control intent (for example: 往左一點/往右一點/停下來/點頭/看狀態) without requiring low-level Arduino command syntax.",
      parameters: Type.Object({
        instruction: Type.String({
          description:
            "Natural language command from user conversation, e.g. '往左一點' or '停下來'.",
        }),
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
        verifyMs: Type.Optional(
          Type.Number({
            description: "Telemetry verification/observe window in ms (default 1000).",
            minimum: 300,
            maximum: 8000,
          })
        ),
        intensity: Type.Optional(
          Type.Union(
            [
              Type.Literal("small"),
              Type.Literal("medium"),
              Type.Literal("large"),
            ],
            { description: "Optional intent intensity override." }
          )
        ),
        delta: Type.Optional(
          Type.Number({
            description: "Optional angle delta override for nudge actions.",
            minimum: 1,
            maximum: 60,
          })
        ),
        targetAngle: Type.Optional(
          Type.Number({
            description: "Optional absolute servo angle override.",
            minimum: 0,
            maximum: 180,
          })
        ),
        includeFrames: Type.Optional(
          Type.Boolean({
            description: "Include sampled frames for debug mode.",
          })
        ),
        sourceId: Type.Optional(
          Type.String({
            description:
              "Optional control source id for arbitration lease. Default: serial_intent.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        priority: Type.Optional(
          Type.Number({
            description:
              "Optional arbitration priority (-100..100). Higher can preempt lower priority owners.",
            minimum: -100,
            maximum: 100,
          })
        ),
        leaseMs: Type.Optional(
          Type.Number({
            description:
              "Optional lease time in ms for this source ownership (200..120000).",
            minimum: 200,
            maximum: 120000,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
        });
        if (!bridge.connected || !telemetryClient || !controlClient) {
          return jsonResult({
            status: "bridge_unavailable",
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
            bridge: {
              auto_connected: bridge.auto_connected,
              resumed: bridge.resumed,
              serial_port: bridge.serial_port,
              session: bridge.bridge_session,
            },
          });
        }

        const resolvedVerifyMs =
          typeof params.verifyMs === "number" && Number.isFinite(params.verifyMs)
            ? Math.max(300, Math.min(Math.floor(params.verifyMs), 8000))
            : DEFAULT_SEMANTIC_VERIFY_MS;
        const source = toControlSourceContext(
          {
            sourceId: params.sourceId,
            priority: params.priority,
            leaseMs: params.leaseMs,
          },
          {
            sourceId: DEFAULT_SEMANTIC_SOURCE_ID,
            priority: 20,
            leaseMs: resolvedVerifyMs + 1500,
          }
        );

        const result = await executeSemanticIntent({
          instruction: params.instruction,
          verifyMs: resolvedVerifyMs,
          intensity: params.intensity as SemanticIntensity | undefined,
          delta: params.delta,
          targetAngle: params.targetAngle,
          includeFrames: params.includeFrames,
          source,
        });

        const runtimeStatus =
          bridge.runtime_status ?? (await requestRuntimeStatus(config));
        const output: Record<string, unknown> = { ...result };
        const summaryRecord = asRecord(output.summary);
        if (summaryRecord) {
          const frameCountFromSummary = asFiniteNumber(summaryRecord.frame_count);
          const frameCount =
            frameCountFromSummary !== null
              ? Math.max(0, Math.floor(frameCountFromSummary))
              : Array.isArray(output.frames)
                ? output.frames.length
                : 0;
          output.summary = mergeRuntimeDiagnosisIntoSummary(
            summaryRecord,
            runtimeStatus,
            frameCount
          );
        }

        const verificationRecord = asRecord(output.verification);
        if (verificationRecord) {
          const enriched = enrichUnverifiableVerification(
            verificationRecord as unknown as StopVerification,
            runtimeStatus
          );
          output.verification = enriched.verification;
          if (enriched.runtime_diagnosis) {
            output.runtime_diagnosis = enriched.runtime_diagnosis;
          }
          if (enriched.next_step) {
            output.next_step = enriched.next_step;
          }
        }

        return jsonResult({
          ...output,
          control_source: buildControlSourceMeta(source),
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
        });
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
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
        includeFrames: Type.Optional(
          Type.Boolean({
            description:
              "Include raw frame objects in response. Keep false for LLM observer mode.",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
        });
        if (!bridge.connected || !telemetryClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
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
          return jsonResult({
            frames,
            count: frames.length,
            summary,
            bridge: {
              auto_connected: bridge.auto_connected,
              resumed: bridge.resumed,
              serial_port: bridge.serial_port,
              session: bridge.bridge_session,
            },
          });
        }
        return jsonResult({
          count: frames.length,
          summary,
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
        });
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
        portHints: Type.Optional(
          Type.Array(Type.String({ description: "Port matching hints for auto-connect." }))
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
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
              "Send handshake probe sequence (STATUS?/IMU_ON/TELEMETRY_ON/STREAM_ON/IMU?) before observing.",
          })
        ),
        includeFrames: Type.Optional(
          Type.Boolean({ description: "Include sampled frames for debug." })
        ),
        includeRuntimeStatus: Type.Optional(
          Type.Boolean({
            description:
              "Include full bridge.runtime_status in response (default false for compact output).",
          })
        ),
        driveAngle: Type.Optional(
          Type.Number({
            description:
              "Optional servo angle drive test before observe (0..180).",
            minimum: 0,
            maximum: 180,
          })
        ),
        sourceId: Type.Optional(
          Type.String({
            description:
              "Optional control source id for probe/drive lease.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        priority: Type.Optional(
          Type.Number({
            description:
              "Optional arbitration priority (-100..100) for probe/drive lease.",
            minimum: -100,
            maximum: 100,
          })
        ),
        leaseMs: Type.Optional(
          Type.Number({
            description:
              "Optional lease time in ms for probe/drive lease (200..120000).",
            minimum: 200,
            maximum: 120000,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
          port: params.port,
          baudrate: params.baudrate,
          portHints: params.portHints,
        });
        if (!bridge.connected) {
          return jsonResult({
            status: "disconnected",
            error: bridge.error ?? "Not connected.",
            next_step:
              bridge.next_step ??
              "Run serial_probe, close Arduino Serial Monitor/uploader on the same COM, then retry serial_connect.",
          });
        }
        if (!telemetryClient || !controlClient) {
          return jsonResult({
            status: "degraded",
            error: "Adapter connected state is inconsistent (missing telemetry/control channel).",
          });
        }

        const observeMs =
          typeof params.observeMs === "number"
            ? Math.max(200, Math.min(Math.floor(params.observeMs), 8000))
            : DEFAULT_OBSERVE_MS;
        const maxFrames =
          typeof params.maxFrames === "number"
            ? Math.max(1, Math.min(Math.floor(params.maxFrames), 400))
            : DEFAULT_OBSERVE_MAX_FRAMES;
        const source = toControlSourceContext(
          {
            sourceId: params.sourceId,
            priority: params.priority,
            leaseMs: params.leaseMs,
          },
          {
            sourceId: "serial_quickcheck",
            priority: 10,
            leaseMs: observeMs + 1500,
          }
        );
        const runtimeStatus = asRecord(bridge.runtime_status);
        const telemetryLastRxSAgo = asFiniteNumber(
          runtimeStatus?.telemetry_last_rx_s_ago
        );
        const runtimeAutoProbe = asRecord(runtimeStatus?.auto_probe);
        const runtimeDiagnosis = asRecord(runtimeStatus?.diagnosis);
        const runtimeDiagnosisCode =
          runtimeDiagnosis && typeof runtimeDiagnosis.code === "string"
            ? runtimeDiagnosis.code
            : null;
        const runtimeDiagnosisSeverity =
          runtimeDiagnosis && typeof runtimeDiagnosis.severity === "string"
            ? runtimeDiagnosis.severity
            : null;
        const runtimeDiagnosisDetail =
          runtimeDiagnosis && typeof runtimeDiagnosis.detail === "string"
            ? runtimeDiagnosis.detail
            : null;
        const runtimeDiagnosisNextStep =
          runtimeDiagnosis && typeof runtimeDiagnosis.next_step === "string"
            ? runtimeDiagnosis.next_step
            : null;
        const runtimeAutoRepair = asRecord(runtimeDiagnosis?.auto_repair);
        const runtimeProbeSuppressedRemaining = asFiniteNumber(
          runtimeAutoRepair?.probe_suppressed_remaining_s
        );
        const runtimeLastAutoProbeSAgo = asFiniteNumber(
          runtimeAutoProbe?.last_sent_s_ago
        );
        const probeRequested = params.triggerProbe !== false;
        let probePerformed = false;
        let probeReason = "disabled_by_param";
        let probeError: string | null = null;
        let driveAction: Record<string, unknown> | null = null;

        if (probeRequested) {
          if (telemetryLastRxSAgo !== null && telemetryLastRxSAgo <= 1.2) {
            probeReason = "skipped_recent_telemetry";
          } else if (
            runtimeProbeSuppressedRemaining !== null &&
            runtimeProbeSuppressedRemaining > 0
          ) {
            probeReason = "runtime_probe_suppressed";
          } else if (
            runtimeLastAutoProbeSAgo !== null &&
            runtimeLastAutoProbeSAgo <= 0.9
          ) {
            probeReason = "skipped_recent_runtime_probe";
          } else {
            try {
              await sendProbeBurst({ source, spacingMs: 60 });
              probePerformed = true;
              probeReason = "sent";
            } catch (error) {
              probeReason = "send_failed";
              probeError = toErrorMessage(error);
            }
          }
        }

        if (typeof params.driveAngle === "number" && Number.isFinite(params.driveAngle)) {
          const target = clamp(Math.round(params.driveAngle), 0, 180);
          try {
            flushTelemetryBacklog();
            await sendServoAngleBestEffort(target, source);
            driveAction = { requested: target, sent: true };
          } catch (error) {
            driveAction = {
              requested: target,
              sent: false,
              error: toErrorMessage(error),
            };
          }
        }

        const observed = await observeTelemetryWindow(observeMs, maxFrames);
        const summary: Record<string, unknown> = {
          ...(observed.summary ?? {}),
        };
        const observedDiagnosis =
          typeof summary.diagnosis === "string" ? summary.diagnosis : null;
        const shouldApplyRuntimeDiagnosis =
          runtimeDiagnosisCode !== null &&
          runtimeDiagnosisCode !== "ok" &&
          (observed.frames.length === 0 ||
            observedDiagnosis === null ||
            observedDiagnosis === "no_telemetry_frames");
        if (shouldApplyRuntimeDiagnosis) {
          summary.diagnosis = runtimeDiagnosisCode;
          if (runtimeDiagnosisNextStep) {
            summary.next_step = runtimeDiagnosisNextStep;
          }
        }
        if (runtimeDiagnosisCode !== null) {
          summary.runtime_diagnosis = {
            code: runtimeDiagnosisCode,
            severity: runtimeDiagnosisSeverity,
            detail: runtimeDiagnosisDetail,
            next_step: runtimeDiagnosisNextStep,
            probe_suppressed_remaining_s: runtimeProbeSuppressedRemaining,
          };
        }
        const includeFrames = params.includeFrames === true;
        const includeRuntimeStatus = params.includeRuntimeStatus === true;

        return jsonResult({
          status: "connected",
          port: bridge.serial_port,
          observe_ms: observeMs,
          sampled_frames: observed.frames.length,
          summary,
          probe: {
            requested: probeRequested,
            performed: probePerformed,
            reason: probeReason,
            error: probeError,
            telemetry_last_rx_s_ago: telemetryLastRxSAgo,
            runtime_last_probe_s_ago: runtimeLastAutoProbeSAgo,
          },
          drive_action: driveAction,
          control_source: buildControlSourceMeta(source),
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            runtime_status: includeRuntimeStatus ? bridge.runtime_status : undefined,
            session: bridge.bridge_session,
          },
          frames: optionalFrames(observed.frames, includeFrames),
        });
      },
    });

    api.registerTool({
      name: "serial_send",
      label: "Send Command",
      description: "Send a control command to serial device",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
        command: Type.Unknown({
          description:
            "Control payload. Supports JSON object or shorthand text (A90/P1500/90).",
        }),
        sourceId: Type.Optional(
          Type.String({
            description:
              "Optional control source id used for runtime arbitration lease.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        priority: Type.Optional(
          Type.Number({
            description:
              "Optional arbitration priority (-100..100). Higher can preempt lower priority owners.",
            minimum: -100,
            maximum: 100,
          })
        ),
        leaseMs: Type.Optional(
          Type.Number({
            description:
              "Optional lease time in ms for this source ownership (200..120000).",
            minimum: 200,
            maximum: 120000,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
        });
        if (!bridge.connected || !controlClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
          });
        }
        const normalized = normalizeSerialSendCommand(params.command);
        if (!normalized) {
          return jsonResult({
            error:
              "Invalid command format. Use JSON object or shorthand text (A90/P1500/90).",
          });
        }

        const source = toControlSourceContext({
          sourceId: params.sourceId,
          priority: params.priority,
          leaseMs: params.leaseMs,
        });

        if (normalized.mode === "json") {
          sendManagedJsonCommand(normalized.payload, source);
        } else {
          sendManagedRawLine(normalized.payload, source);
        }

        return jsonResult({
          status: "sent",
          mode: normalized.mode,
          source: normalized.source,
          normalized: normalized.payload,
          control_source: buildControlSourceMeta(source),
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
        });
      },
    });

    api.registerTool({
      name: "serial_stop",
      label: "Stop And Verify",
      description:
        "Best-effort stop sequence (center + zero outputs) with telemetry verification to avoid false 'stopped' claims.",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
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
        sourceId: Type.Optional(
          Type.String({
            description:
              "Optional control source id used for runtime arbitration lease.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        priority: Type.Optional(
          Type.Number({
            description:
              "Optional arbitration priority (-100..100). Higher can preempt lower priority owners.",
            minimum: -100,
            maximum: 100,
          })
        ),
        leaseMs: Type.Optional(
          Type.Number({
            description:
              "Optional lease time in ms for this source ownership (200..120000).",
            minimum: 200,
            maximum: 120000,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
        });
        if (!bridge.connected || !controlClient || !telemetryClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
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
        const source = toControlSourceContext(
          {
            sourceId: params.sourceId,
            priority: params.priority,
            leaseMs: params.leaseMs,
          },
          {
            sourceId: "serial_stop",
            priority: 30,
            leaseMs: verifyMs + repeats * intervalMs + 1200,
          }
        );

        try {
          flushTelemetryBacklog();
          await sendBestEffortStopSequence({
            targetAngle,
            repeats,
            intervalMs,
            source,
          });
        } catch (error) {
          return jsonResult({
            status: "stop_send_failed",
            error: toErrorMessage(error),
            next_step:
              "Check serial connection and control channel, then retry serial_stop.",
          });
        }

        const observed = await observeTelemetryWindow(verifyMs);
        const runtimeStatus =
          bridge.runtime_status ?? (await requestRuntimeStatus(config));
        const rawVerification = evaluateStopVerification(
          observed.frames,
          targetAngle,
          "stop"
        );
        const enriched = enrichUnverifiableVerification(
          rawVerification,
          runtimeStatus
        );
        const mergedSummary = mergeRuntimeDiagnosisIntoSummary(
          observed.summary,
          runtimeStatus,
          observed.frames.length
        );
        const effectiveNextStep =
          enriched.next_step ??
          (enriched.verification.verified === true
            ? "Stop verified from telemetry."
            : "If motor is still moving, firmware may ignore runtime serial stop commands. Flash firmware that accepts stop/idle commands.");

        return jsonResult({
          status: "stop_sequence_sent",
          target_angle: targetAngle,
          repeats,
          interval_ms: intervalMs,
          verify_ms: verifyMs,
          control_source: buildControlSourceMeta(source),
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
          verification: enriched.verification,
          runtime_diagnosis: enriched.runtime_diagnosis,
          summary: mergedSummary,
          frames: optionalFrames(observed.frames, includeFrames),
          next_step: effectiveNextStep,
        });
      },
    });

    api.registerTool({
      name: "serial_motion_template",
      label: "Servo Motion Template",
      description:
        "Run built-in servo motion templates (slow_sway, fast_jitter, sweep, center_stop)",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
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
        sourceId: Type.Optional(
          Type.String({
            description:
              "Optional control source id used for runtime arbitration lease.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        priority: Type.Optional(
          Type.Number({
            description:
              "Optional arbitration priority (-100..100). Higher can preempt lower priority owners.",
            minimum: -100,
            maximum: 100,
          })
        ),
        leaseMs: Type.Optional(
          Type.Number({
            description:
              "Optional lease time in ms for this source ownership (200..120000).",
            minimum: 200,
            maximum: 120000,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
        });
        if (!bridge.connected || !controlClient || !telemetryClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
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
        const source = toControlSourceContext(
          {
            sourceId: params.sourceId,
            priority: params.priority,
            leaseMs: params.leaseMs,
          },
          {
            sourceId: "serial_motion_template",
            priority: 15,
            leaseMs: intervalMs * Math.max(1, sequence.length * repeats) + 1200,
          }
        );

        if (template === "center_stop") {
          const targetAngle = pwmToApproxAngle(params.centerPwm ?? 1500);
          flushTelemetryBacklog();
          await sendBestEffortStopSequence({
            targetAngle,
            repeats,
            intervalMs,
            source,
          });
          const observed = await observeTelemetryWindow(
            Math.max(400, Math.min(2000, intervalMs * repeats + 600))
          );
          const verification = evaluateStopVerification(
            observed.frames,
            targetAngle,
            "stop"
          );
          return jsonResult({
            status: "sent",
            template,
            repeats,
            intervalMs,
            sequence,
            totalCommands: sequence.length * repeats,
            control_source: buildControlSourceMeta(source),
            bridge: {
              auto_connected: bridge.auto_connected,
              resumed: bridge.resumed,
              serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
          verification,
          summary: observed.summary,
          note:
            verification.verified === true
              ? "center_stop verified from telemetry."
              : "center_stop command sent but not verified from telemetry.",
          });
        }

        for (let r = 0; r < repeats; r += 1) {
          for (const pwm of sequence) {
            sendManagedJsonCommand({ motor_pwm: pwm }, source);
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
          control_source: buildControlSourceMeta(source),
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
        });
      },
    });

    api.registerTool({
      name: "serial_bridge_sync",
      label: "Bridge Sync",
      description:
        "One-shot bridge synchronizer: ensure connected, auto-resume if paused, and return machine-readable runtime status/capabilities.",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
        port: Type.Optional(
          Type.String({
            description: "Serial port override when auto-connect creates a new session.",
          })
        ),
        baudrate: Type.Optional(
          Type.Number({
            description: "Baudrate override when auto-connect creates a new session.",
          })
        ),
        portHints: Type.Optional(
          Type.Array(Type.String({ description: "Port matching hints for auto-connect." }))
        ),
        includeCapabilities: Type.Optional(
          Type.Boolean({
            description: "Include runtime capabilities from adapter ACK.",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
          port: params.port,
          baudrate: params.baudrate,
          portHints: params.portHints,
        });

        if (!bridge.connected) {
          return jsonResult({
            status: "disconnected",
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
            bridge: {
              auto_connected: bridge.auto_connected,
              resumed: bridge.resumed,
              serial_port: bridge.serial_port,
              session: bridge.bridge_session,
            },
          });
        }

        const runtimeStatus =
          bridge.runtime_status ?? (await requestRuntimeStatus(config));
        const capabilities =
          params.includeCapabilities === true
            ? await requestRuntimeCapabilities(config)
            : undefined;
        const previewFrames = telemetryClient?.snapshotFrames(DEFAULT_POLL_COUNT) ?? [];
        const telemetrySummary = summarizeTelemetryFrames(
          previewFrames,
          telemetryClient?.bufferedCount() ?? 0
        );

        return jsonResult({
          status: "connected",
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
          runtime_status: runtimeStatus,
          capabilities,
          telemetry_summary: telemetrySummary,
          latest_control_ack: controlClient?.getLatestAck() ?? null,
        });
      },
    });

    api.registerTool({
      name: "serial_status",
      label: "Adapter Status",
      description:
        "Get adapter runtime status plus a compact snapshot of recent telemetry/IMU visibility",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        autoResume: Type.Optional(
          Type.Boolean({
            description:
              "Auto resume when runtime is paused for COM yield (default from autoResumeOnUse).",
          })
        ),
        includeCapabilities: Type.Optional(
          Type.Boolean({
            description: "Include runtime capabilities from the Python adapter ACK.",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: params.autoResume,
        });
        if (!bridge.connected) {
          return jsonResult({
            status: "disconnected",
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect, then serial_quickcheck.",
          });
        }
        const previewFrames = telemetryClient?.snapshotFrames(DEFAULT_POLL_COUNT) ?? [];
        const summary = summarizeTelemetryFrames(
          previewFrames,
          telemetryClient?.bufferedCount() ?? 0
        );
        const runtimeStatus =
          bridge.runtime_status ?? (await requestRuntimeStatus(config));
        const capabilities =
          params.includeCapabilities === true
            ? await requestRuntimeCapabilities(config)
            : undefined;
        return jsonResult({
          status: "connected",
          port: bridge.serial_port,
          ready: launcher?.getReadyMessage() ?? null,
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            session: bridge.bridge_session,
          },
          runtime_status: runtimeStatus,
          capabilities,
          latest_control_ack: controlClient?.getLatestAck() ?? null,
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
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        seconds: Type.Optional(
          Type.Number({
            description: "Pause duration seconds (default 25, 0 = manual resume)",
            minimum: 0,
          })
        ),
        requestedBy: Type.Optional(
          Type.String({
            description:
              "Who requested the COM yield (for arbitration trace), e.g. arduino_ide/uploader.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        reason: Type.Optional(
          Type.String({
            description:
              "Why COM is paused (for trace), e.g. firmware_upload.",
            minLength: 1,
            maxLength: 80,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: false,
        });
        if (!bridge.connected || !controlClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
          });
        }
        const holdS =
          typeof params.seconds === "number"
            ? Math.max(0, Math.min(params.seconds, 300))
            : 25;
        const ack = await sendRuntimeCommandWithAck(
          {
          __adapter_cmd: "pause",
          hold_s: holdS > 0 ? holdS : undefined,
          requested_by:
            typeof params.requestedBy === "string" && params.requestedBy.trim().length > 0
              ? params.requestedBy.trim()
              : "serial_pause_tool",
          reason:
            typeof params.reason === "string" && params.reason.trim().length > 0
              ? params.reason.trim()
              : "manual_pause",
          },
          config
        );
        return jsonResult({
          status: "pause_requested",
          hold_s: holdS > 0 ? holdS : null,
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
          runtime_ack: ack,
          runtime_status: extractRuntimeStatus(ack),
        });
      },
    });

    api.registerTool({
      name: "serial_yield",
      label: "Yield COM (Arbitration)",
      description:
        "Request COM yield via arbitration metadata so uploader/IDE can take over temporarily.",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
        seconds: Type.Optional(
          Type.Number({
            description: "Yield duration seconds (default 30, 0 = manual resume)",
            minimum: 0,
          })
        ),
        requestedBy: Type.Optional(
          Type.String({
            description:
              "Requester id for arbitration trace, e.g. arduino_ide/uploader/cli.",
            minLength: 1,
            maxLength: 64,
          })
        ),
        reason: Type.Optional(
          Type.String({
            description:
              "Reason for yield, e.g. firmware_upload/serial_monitor.",
            minLength: 1,
            maxLength: 80,
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: false,
        });
        if (!bridge.connected || !controlClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
          });
        }
        const holdS =
          typeof params.seconds === "number"
            ? Math.max(0, Math.min(params.seconds, 300))
            : 30;
        const requestedBy =
          typeof params.requestedBy === "string" && params.requestedBy.trim().length > 0
            ? params.requestedBy.trim()
            : "serial_yield_tool";
        const reason =
          typeof params.reason === "string" && params.reason.trim().length > 0
            ? params.reason.trim()
            : "com_arbitration_request";
        const ack = await sendRuntimeCommandWithAck(
          {
            __adapter_cmd: "yield",
            hold_s: holdS > 0 ? holdS : undefined,
            requested_by: requestedBy,
            reason,
          },
          config
        );
        return jsonResult({
          status: "yield_requested",
          hold_s: holdS > 0 ? holdS : null,
          requested_by: requestedBy,
          reason,
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
          runtime_ack: ack,
          runtime_status: extractRuntimeStatus(ack),
        });
      },
    });

    api.registerTool({
      name: "serial_resume",
      label: "Resume Serial",
      description: "Re-open COM after upload",
      parameters: Type.Object({
        autoConnect: Type.Optional(
          Type.Boolean({
            description:
              "Auto connect if disconnected (default from toolAutoConnect, usually true).",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const bridge = await ensureBridgeReady(config, {
          autoConnect: params.autoConnect,
          autoResume: false,
        });
        if (!bridge.connected || !controlClient) {
          return jsonResult({
            error: bridge.error ?? "Not connected.",
            next_step: bridge.next_step ?? "Call serial_connect first.",
          });
        }
        const ack = await sendRuntimeCommandWithAck(
          { __adapter_cmd: "resume" },
          config
        );
        return jsonResult({
          status: "resume_requested",
          bridge: {
            auto_connected: bridge.auto_connected,
            resumed: bridge.resumed,
            serial_port: bridge.serial_port,
            session: bridge.bridge_session,
          },
          runtime_ack: ack,
          runtime_status: extractRuntimeStatus(ack),
        });
      },
    });
  },
};

export default plugin;
