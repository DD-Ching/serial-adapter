param(
  [string]$PluginName = "serial-adapter",
  [string]$ExtensionsRoot = "$HOME\.openclaw\extensions",
  [string]$SourceRoot = "",
  [switch]$RestartGateway
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Copy-MirrorDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$From,
    [Parameter(Mandatory = $true)][string]$To
  )

  if (-not (Test-Path $From)) {
    return
  }

  New-Item -ItemType Directory -Path $To -Force | Out-Null

  $null = & robocopy $From $To *.* /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP `
    /XD ".git" "node_modules" "__pycache__" ".venv" `
    /XF "*.pyc"
  $code = $LASTEXITCODE
  if ($code -ge 8) {
    throw "robocopy failed ($code) for $From -> $To"
  }
}

function Ensure-Marker {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Pattern
  )
  if (-not (Test-Path $Path)) {
    throw "Missing expected file: $Path"
  }
  $matched = Select-String -Path $Path -Pattern $Pattern -SimpleMatch -Quiet
  if (-not $matched) {
    throw "Marker '$Pattern' not found in $Path"
  }
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Split-Path -Parent $PSScriptRoot
}

$sourceDist = Join-Path $SourceRoot "dist\index.js"
if (-not (Test-Path $sourceDist)) {
  throw "Build artifact missing: $sourceDist (run npm run build first)"
}

$targetRoot = Join-Path $ExtensionsRoot $PluginName
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

Copy-MirrorDirectory -From (Join-Path $SourceRoot "dist") -To (Join-Path $targetRoot "dist")
Copy-MirrorDirectory -From (Join-Path $SourceRoot "python") -To (Join-Path $targetRoot "python")
Copy-MirrorDirectory -From (Join-Path $SourceRoot "firmware") -To (Join-Path $targetRoot "firmware")
Copy-MirrorDirectory -From (Join-Path $SourceRoot "docs") -To (Join-Path $targetRoot "docs")
Copy-MirrorDirectory -From (Join-Path $SourceRoot "scripts") -To (Join-Path $targetRoot "scripts")
Copy-MirrorDirectory -From (Join-Path $SourceRoot "plugins\openclaw_ts_bridge") -To (Join-Path $targetRoot "plugins\openclaw_ts_bridge")
Copy-MirrorDirectory -From (Join-Path $SourceRoot "plugins\algorithm_blocks_ts\dist") -To (Join-Path $targetRoot "plugins\algorithm_blocks_ts\dist")

$topFiles = @(
  "package.json",
  "package-lock.json",
  "openclaw.plugin.json",
  "README.md",
  "pyproject.toml",
  "uv.lock"
)
foreach ($file in $topFiles) {
  $src = Join-Path $SourceRoot $file
  if (Test-Path $src) {
    Copy-Item -Path $src -Destination (Join-Path $targetRoot $file) -Force
  }
}

$targetDist = Join-Path $targetRoot "dist\index.js"
Ensure-Marker -Path $targetDist -Pattern "serial_intent"
Ensure-Marker -Path $targetDist -Pattern "serial_bridge_sync"

$gatewayCmd = Join-Path $env:APPDATA "npm\openclaw.cmd"
$restartResult = "skipped"
if ($RestartGateway) {
  if (-not (Test-Path $gatewayCmd)) {
    throw "openclaw.cmd not found: $gatewayCmd"
  }
  & $gatewayCmd gateway restart | Out-Null
  $restartResult = "restarted"
}

$result = [ordered]@{
  type = "deploy_local_extension"
  ok = $true
  plugin = $PluginName
  source_root = $SourceRoot
  target_root = $targetRoot
  gateway = $restartResult
  marker_checks = @("serial_intent", "serial_bridge_sync")
}

$result | ConvertTo-Json -Depth 6 -Compress
