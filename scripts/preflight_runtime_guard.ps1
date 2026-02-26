param(
  [string]$OpenClaw = "$env:APPDATA\npm\openclaw.cmd",
  [string]$PluginId = "serial-adapter",
  [string]$TcpHost = "127.0.0.1",
  [int]$TelemetryPort = 9000,
  [int]$ControlPort = 9001,
  [int]$AuthWarnMinutes = 30
)

$ErrorActionPreference = "Stop"

function Get-JsonResult {
  param([scriptblock]$Command)
  $text = (& $Command | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  return ($text | ConvertFrom-Json)
}

function Test-TcpListening {
  param(
    [string]$TcpHost,
    [int]$Port,
    [int]$TimeoutMs = 1200
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($TcpHost, $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    if (-not $ok) {
      $client.Close()
      return [PSCustomObject]@{ listening = $false; error = "timeout" }
    }
    $client.EndConnect($iar)
    $client.Close()
    return [PSCustomObject]@{ listening = $true; error = $null }
  } catch {
    try { $client.Close() } catch {}
    return [PSCustomObject]@{ listening = $false; error = $_.Exception.Message }
  }
}

function Invoke-ControlStatus {
  param(
    [string]$TcpHost,
    [int]$Port
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect($TcpHost, $Port)
    $stream = $client.GetStream()
    $writer = New-Object System.IO.StreamWriter($stream)
    $writer.AutoFlush = $true
    $reader = New-Object System.IO.StreamReader($stream)
    $writer.WriteLine('{"__adapter_cmd":"status"}')
    $stream.ReadTimeout = 1600
    $line = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) {
      return [PSCustomObject]@{ ok = $false; error = "no_ack"; ack = $null }
    }
    $ack = $line | ConvertFrom-Json
    return [PSCustomObject]@{ ok = [bool]$ack.ok; error = $null; ack = $ack }
  } catch {
    return [PSCustomObject]@{ ok = $false; error = $_.Exception.Message; ack = $null }
  } finally {
    try { $client.Close() } catch {}
  }
}

$blocking = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$toolchain = [ordered]@{
  openclaw_path = $OpenClaw
  openclaw_exists = (Test-Path $OpenClaw)
  node = $null
  npm = $null
  python = $null
}

if (-not $toolchain.openclaw_exists) {
  $blocking.Add("openclaw executable not found at $OpenClaw")
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
$toolchain.node = if ($nodeCmd) { $nodeCmd.Source } else { $null }
$toolchain.npm = if ($npmCmd) { $npmCmd.Source } else { $null }
$toolchain.python = if ($pythonCmd) { $pythonCmd.Source } else { $null }

if (-not $toolchain.node) { $blocking.Add("node not found in PATH") }
if (-not $toolchain.npm) { $blocking.Add("npm not found in PATH") }
if (-not $toolchain.python) { $warnings.Add("python not found in PATH") }

$gateway = $null
$plugin = $null
$models = $null

if ($toolchain.openclaw_exists) {
  try {
    $gateway = Get-JsonResult -Command { & $OpenClaw gateway status --json }
  } catch {
    $blocking.Add("openclaw gateway status --json failed: $($_.Exception.Message)")
  }

  try {
    $plugin = Get-JsonResult -Command { & $OpenClaw plugins info $PluginId --json }
  } catch {
    $blocking.Add("openclaw plugins info $PluginId --json failed: $($_.Exception.Message)")
  }

  try {
    $models = Get-JsonResult -Command { & $OpenClaw models status --json }
  } catch {
    $warnings.Add("openclaw models status --json failed: $($_.Exception.Message)")
  }
}

if ($gateway) {
  if (-not $gateway.config.cli.valid) {
    $blocking.Add("openclaw cli config invalid: $($gateway.config.cli.path)")
  }
  if (-not $gateway.config.daemon.valid) {
    $blocking.Add("openclaw service config invalid: $($gateway.config.daemon.path)")
  }
  if (-not $gateway.rpc.ok) {
    $blocking.Add("gateway rpc probe failed at $($gateway.gateway.probeUrl)")
  }
}

if ($plugin) {
  if ($plugin.status -ne "loaded") {
    $blocking.Add("plugin $PluginId is not loaded (status=$($plugin.status))")
  }
}

$telemetryListen = Test-TcpListening -TcpHost $TcpHost -Port $TelemetryPort
$controlListen = Test-TcpListening -TcpHost $TcpHost -Port $ControlPort

if (-not $telemetryListen.listening) {
  $blocking.Add("telemetry port $TcpHost`:$TelemetryPort not listening ($($telemetryListen.error))")
}
if (-not $controlListen.listening) {
  $blocking.Add("control port $TcpHost`:$ControlPort not listening ($($controlListen.error))")
}

$controlStatus = $null
if ($controlListen.listening) {
  $controlStatus = Invoke-ControlStatus -TcpHost $TcpHost -Port $ControlPort
  if (-not $controlStatus.ok) {
    $blocking.Add("control status probe failed: $($controlStatus.error)")
  } else {
    $runtime = $controlStatus.ack.status
    if (-not $runtime.serial_connected) {
      $warnings.Add("serial not connected; hardware actions may fail")
    }
    if ($runtime.serial_paused) {
      $warnings.Add("serial is paused; resume before runtime control")
    }
    if ($null -eq $runtime.telemetry_last_rx_s_ago -and $runtime.serial_connected) {
      $warnings.Add("serial connected but no telemetry received yet")
    } elseif ($runtime.telemetry_last_rx_s_ago -gt 10) {
      $warnings.Add("telemetry stale ($([math]::Round([double]$runtime.telemetry_last_rx_s_ago,2))s)")
    }
    if ($runtime.auto_probe.fail_streak -ge 8) {
      $warnings.Add("auto-probe fail streak high ($($runtime.auto_probe.fail_streak)); check firmware protocol")
    }
    if ($runtime.diagnosis -and $runtime.diagnosis.code -and $runtime.diagnosis.code -ne "ok") {
      $diag = [string]$runtime.diagnosis.code
      $next = [string]$runtime.diagnosis.next_step
      if ([string]::IsNullOrWhiteSpace($next)) {
        $warnings.Add("runtime diagnosis: $diag")
      } else {
        $warnings.Add("runtime diagnosis: $diag; next: $next")
      }
    }
  }
}

$auth = [ordered]@{
  provider = $null
  status = "unknown"
  remaining_ms = $null
}

if ($models) {
  $resolved = [string]$models.resolvedDefault
  if ($resolved -and $resolved.Contains("/")) {
    $providerName = $resolved.Split("/")[0]
    $auth.provider = $providerName
    $providerStatuses = @($models.auth.oauth.providers)
    $provider = $providerStatuses | Where-Object { $_.provider -eq $providerName } | Select-Object -First 1
    if ($provider) {
      $auth.status = [string]$provider.status
      $auth.remaining_ms = $provider.remainingMs
      if ($provider.status -ne "ok") {
        $blocking.Add("model provider auth not ok for $providerName (status=$($provider.status))")
      } elseif ($null -ne $provider.remainingMs) {
        $warnMs = [int64]$AuthWarnMinutes * 60 * 1000
        if ([int64]$provider.remainingMs -le 0) {
          $blocking.Add("model provider auth token expired for $providerName; re-auth required")
        } elseif ([int64]$provider.remainingMs -lt $warnMs) {
          $warnings.Add("model provider auth token near expiry for $providerName")
        }
      }
    } else {
      $warnings.Add("cannot locate oauth provider status for resolved default model: $providerName")
    }
  }
}

$report = [ordered]@{
  type = "preflight_runtime_guard"
  timestamp = (Get-Date).ToString("o")
  pass = ($blocking.Count -eq 0)
  blocking = @($blocking)
  warnings = @($warnings)
  toolchain = $toolchain
  gateway = $gateway
  plugin = $plugin
  auth = $auth
  ports = [ordered]@{
    telemetry = [ordered]@{
      host = $TcpHost
      port = $TelemetryPort
      listening = $telemetryListen.listening
      error = $telemetryListen.error
    }
    control = [ordered]@{
      host = $TcpHost
      port = $ControlPort
      listening = $controlListen.listening
      error = $controlListen.error
    }
  }
  control_runtime = if ($controlStatus -and $controlStatus.ack) { $controlStatus.ack.status } else { $null }
}

$report | ConvertTo-Json -Depth 9
