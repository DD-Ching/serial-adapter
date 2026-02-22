# Local Development Guide

## Prerequisites

- Node.js >= 22
- [uv](https://docs.astral.sh/uv/) (for Python environment management)
- OpenClaw CLI installed (`npm i -g openclaw`)

## Setup

```bash
# Install JS dependencies
npm install

# Install Python dependencies (handled automatically by postinstall via uv)
uv sync

# Build TypeScript
npm run build
```

## Running Tests

```bash
# Python tests
npm test                    # or: uv run pytest tests/ -x
uv run pytest tests/ -v     # verbose output

# TypeScript type check
npx tsc --noEmit

# Linting
uv run ruff check python/
uv run ruff format --check python/
```

## Local Plugin Testing with OpenClaw

OpenClaw recommends [link mode](https://docs.openclaw.ai/tools/plugin) for local
plugin development. This creates a symbolic link instead of copying files, so
code changes take effect after a rebuild without reinstalling.

### 1. Link-install the plugin

```bash
npm run build
openclaw plugins install -l .
```

### 2. Configure the plugin

```bash
openclaw config edit
```

Add under `plugins.entries`:

```yaml
plugins:
  entries:
    serial-adapter:
      enabled: true
      config:
        serialPort: "/dev/tty.usbserial-XXX"   # your device path
        baudrate: 115200                         # optional, default 115200
        telemetryPort: 9000                      # optional
        controlPort: 9001                        # optional
```

See `openclaw.plugin.json` for the full config schema.

### 3. Restart the gateway

```bash
openclaw gateway restart
```

### 4. Verify

```bash
openclaw plugins list          # should show serial-adapter as "loaded"
```

Once loaded, the AI can invoke:

- `serial_connect` — connect to the serial device
- `serial_poll` — read telemetry frames
- `serial_send` — send control commands
- `serial_status` — check adapter status

### Development loop

After making changes:

```bash
npm run build                  # rebuild TypeScript
openclaw gateway restart       # reload plugin
```

Python-only changes (under `python/`) do not require `npm run build` — just
restart the gateway.

## Pre-commit Hook

The `.husky/pre-commit` hook runs automatically on `git commit`:

1. `npx tsc --noEmit` — TypeScript type check
2. `uv run ruff check python/` — lint
3. `uv run ruff format --check python/` — format check
4. `uv run pytest tests/ -x` — test suite

## Project Structure

```
.
├── src/                  # TypeScript plugin entry + launcher
│   ├── launcher.ts       # Spawns Python subprocess, auto-creates .venv
│   ├── tcp-client.ts     # Telemetry/control TCP clients
│   └── types.ts          # Shared type definitions
├── python/               # Python core package (shipped with npm package)
│   ├── __main__.py       # CLI entry point (python3 -m python)
│   ├── plugin.py         # SerialAdapter + RingBuffer exports
│   ├── ring_buffer.py    # Frame ring buffer with delimiter extraction
│   ├── statistics.py     # Rolling numeric statistics
│   └── tcp_server.py     # TCP telemetry/control servers
├── tests/                # pytest test suite
│   ├── conftest.py       # Shared fixtures (FakeSerial, helpers)
│   ├── test_ring_buffer.py
│   └── test_adapter.py
├── dist/                 # Built JS output (git-ignored)
├── openclaw.plugin.json  # Plugin manifest for OpenClaw
├── pyproject.toml        # Python project config (uv/pytest/ruff)
└── uv.lock               # Python dependency lockfile
```
