param(
  [string]$OpenClaw = "$env:APPDATA\npm\openclaw.cmd",
  [string]$Agent = "main",
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OpenClaw)) {
  throw "openclaw executable not found: $OpenClaw"
}

function Get-FirstJsonObjectText {
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

function Invoke-AgentJson {
  param(
    [string]$Message
  )
  $lastError = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      $raw = & $OpenClaw agent --agent $Agent --message $Message --json --timeout $TimeoutSeconds | Out-String -Width 100000
      $outerText = Get-FirstJsonObjectText -Text $raw
      $obj = $outerText | ConvertFrom-Json -ErrorAction Stop

      if ($null -ne $obj.result -and $null -ne $obj.result.payloads -and $obj.result.payloads.Count -ge 1) {
        $text = [string]$obj.result.payloads[0].text
        $jsonText = Get-FirstJsonObjectText -Text $text
        return ($jsonText | ConvertFrom-Json -ErrorAction Stop)
      }
      return $obj
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 450
    }
  }
  throw "Invoke-AgentJson failed after retries: $lastError"
}

$steps = @(
  [PSCustomObject]@{
    name = "quickcheck"
    message = @"
Run serial_quickcheck with observeMs=1200, driveAngle=90, triggerProbe=false.
Return ONLY minified JSON with this exact schema:
{"step":"quickcheck","status":"ok|fail","imu_detected":true|false,"verified":true|false,"reason":"short string"}
Do not include summary objects. Do not include markdown. Do not include extra text.
"@
  },
  [PSCustomObject]@{
    name = "nudge_left"
    message = @"
Run serial_intent with instruction='move a bit left', verifyMs=1200.
Return ONLY minified JSON with this exact schema:
{"step":"nudge_left","status":"ok|fail","verified":true|false,"reason":"short string"}
Do not include markdown. Do not include extra text.
"@
  },
  [PSCustomObject]@{
    name = "stop"
    message = @"
Run serial_intent with instruction='stop the motor', verifyMs=1200.
Return ONLY minified JSON with this exact schema:
{"step":"stop","status":"ok|fail","verified":true|false,"reason":"short string"}
Do not include markdown. Do not include extra text.
"@
  }
)

$results = @()
foreach ($step in $steps) {
  $payload = Invoke-AgentJson -Message $step.message
  $verified = $false
  if ($null -ne $payload.verified) {
    $verified = [bool]$payload.verified
  } elseif ($null -ne $payload.verification -and $null -ne $payload.verification.verified) {
    $verified = [bool]$payload.verification.verified
  }

  $imuDetected = $false
  if ($null -ne $payload.imu_detected) {
    $imuDetected = [bool]$payload.imu_detected
  } elseif ($null -ne $payload.summary -and $null -ne $payload.summary.imu -and $null -ne $payload.summary.imu.detected) {
    $imuDetected = [bool]$payload.summary.imu.detected
  }

  $reason = ""
  if ($null -ne $payload.reason) {
    $reason = [string]$payload.reason
  } elseif ($null -ne $payload.verification -and $null -ne $payload.verification.reason) {
    $reason = [string]$payload.verification.reason
  }

  $latestServo = $null
  if ($null -ne $payload.latest_servo) {
    $latestServo = $payload.latest_servo
  } elseif ($null -ne $payload.summary -and $null -ne $payload.summary.servo -and $null -ne $payload.summary.servo.last) {
    $latestServo = $payload.summary.servo.last
  }

  $results += [PSCustomObject]@{
    step = $step.name
    status = $payload.status
    intent = $payload.intent
    verified = $verified
    reason = $reason
    latest_servo = $latestServo
    imu_detected = $imuDetected
  }
  Start-Sleep -Milliseconds 300
}

$ok = $true
if (-not ($results | Where-Object { $_.step -eq "quickcheck" -and $_.imu_detected -eq $true })) {
  $ok = $false
}
if (-not ($results | Where-Object { $_.step -eq "nudge_left" -and $_.verified -eq $true })) {
  $ok = $false
}
if (-not ($results | Where-Object { $_.step -eq "stop" -and $_.verified -eq $true })) {
  $ok = $false
}

[PSCustomObject]@{
  type = "semantic_e2e_check"
  ok = $ok
  results = $results
} | ConvertTo-Json -Depth 6
