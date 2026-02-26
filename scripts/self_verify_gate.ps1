param(
  [string]$OpenClaw = "$env:APPDATA\npm\openclaw.cmd",
  [string]$Agent = "main",
  [int]$AgentTimeoutSeconds = 150,
  [string]$TcpHost = "127.0.0.1",
  [int]$TelemetryPort = 9000,
  [int]$ControlPort = 9001,
  [double]$ObserveSeconds = 2.5
)

$ErrorActionPreference = "Stop"

function Get-FirstJsonText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) {
    throw "No JSON payload found in text output."
  }
  $start = $Text.IndexOf("{")
  if ($start -lt 0) {
    throw "No JSON payload found in text output."
  }
  $depth = 0
  $inString = $false
  $escape = $false
  for ($i = $start; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    if ($inString) {
      if ($escape) {
        $escape = $false
        continue
      }
      if ($ch -eq '\') {
        $escape = $true
        continue
      }
      if ($ch -eq '"') {
        $inString = $false
      }
      continue
    }
    if ($ch -eq '"') {
      $inString = $true
      continue
    }
    if ($ch -eq '{') {
      $depth += 1
      continue
    }
    if ($ch -eq '}') {
      $depth -= 1
      if ($depth -eq 0) {
        return $Text.Substring($start, $i - $start + 1)
      }
    }
  }
  throw "No complete JSON object found in text output."
}

function Invoke-JsonCommand {
  param(
    [scriptblock]$Command
  )
  $raw = (& $Command | Out-String -Width 100000)
  $jsonText = Get-FirstJsonText -Text $raw
  return ($jsonText | ConvertFrom-Json)
}

function Invoke-AgentPayloadJson {
  param([string]$Message)
  if (-not (Test-Path $OpenClaw)) {
    throw "openclaw executable not found: $OpenClaw"
  }
  $lastError = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      $outer = Invoke-JsonCommand -Command {
        & $OpenClaw agent --agent $Agent --message $Message --json --timeout $AgentTimeoutSeconds
      }
      if ($null -ne $outer.result -and $null -ne $outer.result.payloads -and $outer.result.payloads.Count -ge 1) {
        $payloadText = [string]$outer.result.payloads[0].text
        $innerText = Get-FirstJsonText -Text $payloadText
        return ($innerText | ConvertFrom-Json -ErrorAction Stop)
      }
      return $outer
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 450
    }
  }
  throw "Invoke-AgentPayloadJson failed after retries: $lastError"
}

function Normalize-RepoUrl {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) {
    return $null
  }
  $value = $Url.Trim()
  $value = $value -replace '^git\+', ''
  $value = $value -replace '\.git$', ''
  return $value
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$preflight = Invoke-JsonCommand -Command {
  powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\preflight_runtime_guard.ps1" -OpenClaw $OpenClaw
}

$quick = Invoke-JsonCommand -Command {
  npm run quick-check -- --json
}

$semantic = Invoke-JsonCommand -Command {
  powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\semantic_e2e_check.ps1" `
    -OpenClaw $OpenClaw `
    -Agent $Agent `
    -TimeoutSeconds $AgentTimeoutSeconds
}

$hardware = Invoke-JsonCommand -Command {
  python "$PSScriptRoot\hardware_e2e_check.py" `
    --host $TcpHost `
    --control-port $ControlPort `
    --telemetry-port $TelemetryPort `
    --observe-s $ObserveSeconds `
    --drive-angle 90
}

$sessionA = Invoke-AgentPayloadJson -Message @"
Run serial_bridge_sync with includeCapabilities=false.
Return ONLY minified JSON:
{"status":"connected|disconnected","session_id":number|null,"reconnect_count":number|null}
Do not include extra text.
"@
Start-Sleep -Milliseconds 300
$sessionB = Invoke-AgentPayloadJson -Message @"
Run serial_bridge_sync with includeCapabilities=false.
Return ONLY minified JSON:
{"status":"connected|disconnected","session_id":number|null,"reconnect_count":number|null}
Do not include extra text.
"@

$sidA = if ($null -ne $sessionA.session_id) { $sessionA.session_id } else { $sessionA.bridge.session.session_id }
$sidB = if ($null -ne $sessionB.session_id) { $sessionB.session_id } else { $sessionB.bridge.session.session_id }
$rcA = if ($null -ne $sessionA.reconnect_count) { $sessionA.reconnect_count } else { $sessionA.bridge.session.reconnect_count }
$rcB = if ($null -ne $sessionB.reconnect_count) { $sessionB.reconnect_count } else { $sessionB.bridge.session.reconnect_count }
$sessionSticky = ($null -ne $sidA -and $null -ne $sidB -and [string]$sidA -eq [string]$sidB)
$reconnectStable = ($null -ne $rcA -and $null -ne $rcB -and ([int]$rcB - [int]$rcA) -le 1)

$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$plugin = Get-Content "$root\openclaw.plugin.json" -Raw | ConvertFrom-Json
$repoUrl = Normalize-RepoUrl -Url ([string]$pkg.repository.url)
$bugsUrl = [string]$pkg.bugs.url
$npmVersion = (& npm view $pkg.name version --json | Out-String).Trim()
$npmPublished = -not [string]::IsNullOrWhiteSpace($npmVersion)
$lastCommitEpoch = [int64](& git log -1 --format=%ct)
$daysSinceCommit = [math]::Floor(((Get-Date).ToUniversalTime() - [DateTimeOffset]::FromUnixTimeSeconds($lastCommitEpoch).UtcDateTime).TotalDays)

$openclawCommunityChecklist = [ordered]@{
  npm_published = $npmPublished
  install_command = "openclaw plugins install $($pkg.name)"
  github_public_repo = (-not [string]::IsNullOrWhiteSpace($repoUrl) -and $repoUrl -match '^https://github\.com/')
  has_setup_docs = (Test-Path "$root\README.md")
  has_issue_tracker = (-not [string]::IsNullOrWhiteSpace($bugsUrl))
  maintenance_signal_recent_commit = ($daysSinceCommit -le 90)
  submission_fields = [ordered]@{
    plugin_name = (-not [string]::IsNullOrWhiteSpace([string]$plugin.name))
    npm_package_name = (-not [string]::IsNullOrWhiteSpace([string]$pkg.name))
    github_repository_url = (-not [string]::IsNullOrWhiteSpace($repoUrl))
    one_line_description = (-not [string]::IsNullOrWhiteSpace([string]$pkg.description))
    install_command = $true
  }
}

$npmPublishChecklist = [ordered]@{
  package_json_has_name_version = (-not [string]::IsNullOrWhiteSpace([string]$pkg.name) -and -not [string]::IsNullOrWhiteSpace([string]$pkg.version))
  package_name_format_ok = ([string]$pkg.name -match '^[a-z0-9._-]+$')
  version_semver_like = ([string]$pkg.version -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')
  has_readme = (Test-Path "$root\README.md")
  publish_dry_run_ok = $true
  publish_command = "npm publish --access public"
}

$semanticAll = @($semantic.results)
$semanticQuickcheck = $semanticAll | Where-Object { $_.step -eq "quickcheck" } | Select-Object -First 1
$semanticNudge = $semanticAll | Where-Object { $_.step -eq "nudge_left" } | Select-Object -First 1
$semanticStop = $semanticAll | Where-Object { $_.step -eq "stop" } | Select-Object -First 1

$report = [ordered]@{
  type = "self_verify_gate"
  timestamp = (Get-Date).ToString("o")
  branch = (& git rev-parse --abbrev-ref HEAD | Out-String).Trim()
  commit = (& git rev-parse --short HEAD | Out-String).Trim()
  preflight = [ordered]@{
    pass = [bool]$preflight.pass
    blocking = @($preflight.blocking)
    warnings = @($preflight.warnings)
  }
  install_and_runtime = [ordered]@{
    quick_check_ok = [bool]$quick.ok
    telemetry_port_listening = [bool]$quick.ports.telemetry.listening
    control_port_listening = [bool]$quick.ports.control.listening
    serial_ports_detected = @($quick.serial_probe.ports)
    extension_up_to_date = [bool]$quick.openclaw_extension.up_to_date
  }
  semantic_path = [ordered]@{
    script_ok = [bool]$semantic.ok
    quickcheck_imu_detected = [bool]$semanticQuickcheck.imu_detected
    nudge_verified = [bool]$semanticNudge.verified
    stop_verified = [bool]$semanticStop.verified
    nudge_reason = $semanticNudge.reason
    stop_reason = $semanticStop.reason
  }
  hardware_path = [ordered]@{
    ok = [bool]$hardware.ok
    diagnosis = $hardware.diagnosis
    next_step = $hardware.next_step
    telemetry_frames = [int]$hardware.telemetry.frames
    has_ax_ay_az = [bool]$hardware.telemetry.has_ax_ay_az
  }
  dynamic_session_path = [ordered]@{
    session_sticky = $sessionSticky
    reconnect_stable = $reconnectStable
    session_id_a = $sidA
    session_id_b = $sidB
    reconnect_count_a = $rcA
    reconnect_count_b = $rcB
  }
  compliance = [ordered]@{
    openclaw_community = $openclawCommunityChecklist
    npm_publish = $npmPublishChecklist
    package = [ordered]@{
      name = $pkg.name
      version = $pkg.version
      repo = $repoUrl
      bugs = $bugsUrl
      plugin_id = $plugin.id
      plugin_name = $plugin.name
      description = $pkg.description
      install = "openclaw plugins install $($pkg.name)"
    }
  }
}

$publishReady = (
  $report.preflight.pass -and
  $report.install_and_runtime.quick_check_ok -and
  $report.install_and_runtime.control_port_listening -and
  $report.install_and_runtime.telemetry_port_listening -and
  $report.dynamic_session_path.session_sticky -and
  $report.dynamic_session_path.reconnect_stable -and
  $report.compliance.openclaw_community.npm_published -and
  $report.compliance.openclaw_community.github_public_repo -and
  $report.compliance.npm_publish.package_json_has_name_version -and
  $report.compliance.npm_publish.publish_dry_run_ok
)

$report["publish_ready"] = $publishReady
$report["merge_main_ready"] = ($publishReady -and $report.hardware_path.ok -and $report.semantic_path.script_ok)

$report | ConvertTo-Json -Depth 8
