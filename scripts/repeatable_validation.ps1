param(
  [string]$OpenClaw = "$env:APPDATA\npm\openclaw.cmd",
  [string]$Agent = "main",
  [switch]$AutoRecoverTelemetry
)

$ErrorActionPreference = "Stop"

function ConvertFrom-JsonBestEffort {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }

  try {
    return ($Text | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    # Continue to substring probing.
  }

  $starts = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -lt $Text.Length; $i++) {
    if ($Text[$i] -eq '{') {
      $starts.Add($i)
    }
  }
  if ($starts.Count -eq 0) {
    return $null
  }

  $ends = New-Object System.Collections.Generic.List[int]
  for ($i = $Text.Length - 1; $i -ge 0; $i--) {
    if ($Text[$i] -eq '}') {
      $ends.Add($i)
    }
  }
  if ($ends.Count -eq 0) {
    return $null
  }

  foreach ($start in $starts) {
    foreach ($end in $ends) {
      if ($end -le $start) {
        continue
      }
      $candidate = $Text.Substring($start, $end - $start + 1)
      try {
        return ($candidate | ConvertFrom-Json -ErrorAction Stop)
      } catch {
        continue
      }
    }
  }

  return $null
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )

  $raw = ""
  $ok = $false
  $exitCode = 0
  try {
    $raw = (& $Command 2>&1 | Out-String -Width 100000)
    $exitCode = $LASTEXITCODE
    $ok = ($exitCode -eq 0)
  } catch {
    $raw = ($_ | Out-String)
    $ok = $false
    $exitCode = 1
  }

  $parsed = ConvertFrom-JsonBestEffort -Text $raw
  $summary = if ($raw.Length -gt 800) { $raw.Substring(0, 800) } else { $raw }

  return [PSCustomObject]@{
    name = $Name
    ok = $ok
    exit_code = $exitCode
    parsed = $parsed
    output_preview = $summary.Trim()
  }
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$steps = @()

$steps += Invoke-Step -Name "quick_check" -Command {
  powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\quick_check.ps1" -Json
}

$steps += Invoke-Step -Name "preflight_runtime" -Command {
  powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\preflight_runtime_guard.ps1" -OpenClaw $OpenClaw
}

if ($AutoRecoverTelemetry) {
  $preflight = $steps | Where-Object { $_.name -eq "preflight_runtime" } | Select-Object -First 1
  $diag = $preflight.parsed.control_runtime.diagnosis.code
  if ([string]$diag -eq "serial_silent_no_telemetry_bytes") {
    $steps += Invoke-Step -Name "auto_recover_pause_resume" -Command {
      python examples/runtime_ops.py pause --hold-s 5
      Start-Sleep -Milliseconds 600
      python examples/runtime_ops.py resume
      Start-Sleep -Milliseconds 1500
      python examples/runtime_ops.py status
    }
  }
}

$steps += Invoke-Step -Name "self_verify" -Command {
  powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\self_verify_gate.ps1" -OpenClaw $OpenClaw -Agent $Agent
}

$steps += Invoke-Step -Name "pytest_core" -Command {
  uv run pytest tests/test_tcp_server.py tests/test_adapter.py
}

$final = [ordered]@{
  type = "repeatable_validation"
  timestamp = (Get-Date).ToString("o")
  branch = (& git rev-parse --abbrev-ref HEAD | Out-String).Trim()
  commit = (& git rev-parse --short HEAD | Out-String).Trim()
  all_ok = (($steps | Where-Object { -not $_.ok }).Count -eq 0)
  steps = $steps
}

$final | ConvertTo-Json -Depth 10
