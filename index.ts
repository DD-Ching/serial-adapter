import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import {
  PythonLauncher,
  listSerialPorts,
  chooseBestSerialPort,
} from "./src/launcher.js";
import { TelemetryClient, ControlClient } from "./src/tcp-client.js";
import type { PluginConfig } from "./src/types.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

async function connectAdapter(config: PluginConfig) {
  launcher = new PythonLauncher(config);
  const ready = await launcher.start();

  const host = config.host ?? "127.0.0.1";

  telemetryClient = new TelemetryClient();
  await telemetryClient.connect(host, ready.telemetry_port);

  controlClient = new ControlClient();
  await controlClient.connect(host, ready.control_port);

  const result = {
    status: "connected" as const,
    serial_port: launcher.getResolvedPort() ?? config.serialPort ?? null,
    telemetry_port: ready.telemetry_port,
    control_port: ready.control_port,
    pid: ready.pid,
  };
  log.info(
    `Adapter connected on ${result.serial_port ?? "<unknown-port>"} telemetry:${ready.telemetry_port} control:${ready.control_port}`
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
  log.info("Adapter disconnected");
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
          log.warn(`serial-adapter auto-start skipped: ${String(error)}`);
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
          return jsonResult({ error: String(error) });
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
          return jsonResult({ error: String(error) });
        }
      },
    });

    api.registerTool({
      name: "serial_poll",
      label: "Poll Telemetry",
      description: "Read available telemetry frames from serial adapter",
      parameters: Type.Object({
        count: Type.Optional(
          Type.Number({ description: "Max number of frames to return" })
        ),
      }),
      async execute(_toolCallId, params) {
        if (!telemetryClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        const frames = telemetryClient.pollFrames(params.count);
        return jsonResult({ frames, count: frames.length });
      },
    });

    api.registerTool({
      name: "serial_send",
      label: "Send Command",
      description: "Send a control command to serial device",
      parameters: Type.Object({
        command: Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON command payload",
        }),
      }),
      async execute(_toolCallId, params) {
        if (!controlClient) {
          return jsonResult({
            error: "Not connected. Call serial_connect first.",
          });
        }
        controlClient.sendCommand(params.command as Record<string, unknown>);
        return jsonResult({ status: "sent" });
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
        if (!controlClient) {
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
      description: "Get serial adapter runtime status",
      parameters: Type.Object({}),
      async execute() {
        if (!launcher?.isRunning()) {
          return jsonResult({ status: "disconnected" });
        }
        return jsonResult({
          status: "connected",
          port: launcher.getResolvedPort() ?? config.serialPort ?? null,
          ready: launcher.getReadyMessage(),
        });
      },
    });
  },
};

export default plugin;
