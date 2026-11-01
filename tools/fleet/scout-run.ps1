#requires -Version 7
# The child must not inherit the ingest token or the hub address.

# PowerShell treats "--" as an empty parameter name, so the tail is parsed from $args.
$ErrorActionPreference = "Stop"
$FleetHost = ""
$Component = ""
$TimeoutSeconds = 0
$ExpectOutput = $false
$FailureClass = ""
$Command = @()
$index = 0
while ($index -lt $args.Count) {
  $item = [string]$args[$index]
  if ($item -eq "--") {
    $index += 1
    while ($index -lt $args.Count) {
      $Command += [string]$args[$index]
      $index += 1
    }
    break
  }
  if ($item -eq "-ExpectOutput") { $ExpectOutput = $true; $index += 1; continue }
  if ($item -eq "-FleetHost" -or $item -eq "-Component" -or $item -eq "-TimeoutSeconds" -or $item -eq "-FailureClass") {
    $index += 1
    if ($index -ge $args.Count) {
      [Console]::Error.WriteLine("usage: scout-run.ps1 -FleetHost name -Component name -- <command>")
      exit 2
    }
    $value = [string]$args[$index]
    $index += 1
    if ($item -eq "-FleetHost") { $FleetHost = $value }
    elseif ($item -eq "-Component") { $Component = $value }
    elseif ($item -eq "-FailureClass") { $FailureClass = $value }
    else {
      $parsedTimeout = 0
      if (-not [int]::TryParse($value, [ref]$parsedTimeout) -or $parsedTimeout -lt 0) {
        [Console]::Error.WriteLine("usage: scout-run.ps1 -FleetHost name -Component name -- <command>")
        exit 2
      }
      $TimeoutSeconds = $parsedTimeout
    }
    continue
  }
  [Console]::Error.WriteLine("usage: scout-run.ps1 -FleetHost name -Component name -- <command>")
  exit 2
}
if ([string]::IsNullOrWhiteSpace($FleetHost) -or [string]::IsNullOrWhiteSpace($Component) -or $Command.Count -lt 1) {
  [Console]::Error.WriteLine("usage: scout-run.ps1 -FleetHost name -Component name -- <command>")
  exit 2
}

$Utf8 = [System.Text.UTF8Encoding]::new($false)

function Get-FleetFingerprint([string]$Name, [string]$Unit, [string]$Class, [string]$Key) {
  $parts = New-Object System.Collections.Generic.List[string]
  [void]$parts.Add($Name.ToLowerInvariant())
  [void]$parts.Add($Unit.ToLowerInvariant())
  [void]$parts.Add($Class.ToLowerInvariant())
  if ($Key.Length -gt 0) {
    $collapsed = $Key.ToLowerInvariant()
    $collapsed = [regex]::Replace($collapsed, "[0-9a-f]{8,}", "#")
    $collapsed = [regex]::Replace($collapsed, "\d{2,}", "#")
    [void]$parts.Add($collapsed)
  }
  $text = [string]::Join("`n", $parts)
  $hash = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($text))
  return [System.Convert]::ToHexString($hash).ToLowerInvariant().Substring(0, 16)
}

function Add-FleetRule([ref]$Text, [System.Collections.Generic.List[string]]$Rules, [string]$Id, [string]$Pattern, [string]$Replacement, [bool]$IgnoreCase) {
  $options = [System.Text.RegularExpressions.RegexOptions]::None
  if ($IgnoreCase) { $options = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase }
  $next = [regex]::Replace($Text.Value, $Pattern, $Replacement, $options)
  if ($next -ne $Text.Value) {
    [void]$Rules.Add($Id)
    $Text.Value = $next
  }
}

function Redact-Fleet([string]$InputText) {
  $rules = New-Object System.Collections.Generic.List[string]
  $text = $InputText
  Add-FleetRule ([ref]$text) $rules "private-key" '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----' '[redacted:private-key]' $false
  Add-FleetRule ([ref]$text) $rules "discord" 'https?://(?:discord(?:app)?\.com)/api/webhooks/\d+/[A-Za-z0-9_-]+' '[redacted:discord]' $false
  Add-FleetRule ([ref]$text) $rules "url-credential" '(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@' '$1[redacted:url-credential]@' $false
  Add-FleetRule ([ref]$text) $rules "github" '(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,})' '[redacted:github]' $false
  Add-FleetRule ([ref]$text) $rules "telegram" '(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])' '[redacted:telegram]' $false
  Add-FleetRule ([ref]$text) $rules "aws" '\b(?:AKIA|ASIA)[A-Z0-9]{16}\b' '[redacted:aws]' $false
  Add-FleetRule ([ref]$text) $rules "jwt" '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b' '[redacted:jwt]' $false
  Add-FleetRule ([ref]$text) $rules "authorization" 'Authorization:\s*\S+' '[redacted:authorization]' $true
  Add-FleetRule ([ref]$text) $rules "bearer" '\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}' '[redacted:bearer]' $false
  Add-FleetRule ([ref]$text) $rules "secret" '(?<![A-Za-z0-9_])(password|passwd|secret|token|api[_-]?key|apikey|credential)(\s*[=:]\s*)(["'']?)(?!\[redacted:)([^\s"'',;&]+)' '$1$2$3[redacted:secret]' $true
  $before = $text
  $flags = @{ hex = $false; base64 = $false }
  $text = [regex]::Replace($text, '[A-Za-z0-9+/]{40,}={0,2}', {
    param($match)
    $value = $match.Value
    $body = $value.TrimEnd('=')
    if ($body -match '^[0-9a-fA-F]+$') {
      $start = [Math]::Max(0, $match.Index - 24)
      $prefix = $before.Substring($start, $match.Index - $start)
      if ($body.Length -eq 40 -and [regex]::IsMatch($prefix, 'commit:?\s+$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $value }
      $flags.hex = $true
      return '[redacted:hex]'
    }
    $flags.base64 = $true
    return '[redacted:base64]'
  })
  if ($flags.hex) { [void]$rules.Add("hex") }
  if ($flags.base64) { [void]$rules.Add("base64") }
  return @{ text = $text; rules = @($rules) }
}

function Get-FleetSeverity([string]$Class) {
  switch ($Class) {
    { $_ -in @("dead", "wedged", "resources") } { "critical" }
    "alert-quality" { "info" }
    default { "warning" }
  }
}

function Hide-FleetSecrets([System.Diagnostics.ProcessStartInfo]$Start) {
  $names = @($Start.Environment.Keys)
  if ($names.Count -eq 0) {
    foreach ($pair in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
      $name = [string]$pair.Key
      if ($name -match '^(SCOUT_FLEET_TOKEN|SCOUT_FLEET_URL)$') { continue }
      $Start.Environment[$name] = [string]$pair.Value
    }
    return
  }
  foreach ($name in $names) {
    if ($name -match '^(SCOUT_FLEET_TOKEN|SCOUT_FLEET_URL)$') { [void]$Start.Environment.Remove($name) }
  }
}

function Write-FleetLine([string]$Path, [string]$Json) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::AppendAllText($Path, ($Json + "`n"), $Utf8)
}

function Remove-FleetLine([string]$Path, [string]$Json) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $raw = [System.IO.File]::ReadAllText($Path, $Utf8)
  $kept = @($raw -split "`r?`n" | Where-Object { $_ -ne "" -and $_ -ne $Json })
  $next = ""
  if ($kept.Count -gt 0) { $next = ($kept -join "`n") + "`n" }
  $tmp = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($tmp, $next, $Utf8)
  [System.IO.File]::Move($tmp, $Path, $true)
}

function Send-FleetPacket([string]$Json) {
  $spool = $env:SCOUT_FLEET_SPOOL
  $path = $null
  if ($spool) {
    $path = Join-Path $spool "packets.jsonl"
    Write-FleetLine $path $Json
  }
  if (-not $env:SCOUT_FLEET_URL -or -not $env:SCOUT_FLEET_TOKEN) { return [bool]$spool }
  try {
    Invoke-WebRequest -Method Post -Uri $env:SCOUT_FLEET_URL -Headers @{ Authorization = "Bearer $($env:SCOUT_FLEET_TOKEN)" } -ContentType "application/json" -Body $Json -TimeoutSec 10 -UseBasicParsing | Out-Null
    if ($path) { Remove-FleetLine $path $Json }
    return $true
  } catch {
    [Console]::Error.WriteLine("fleet post failed")
    return [bool]$spool
  }
}

function New-FleetPacket([string]$Class, [string]$Summary, [bool]$HasExit, [int]$ExitCode, [string]$StderrText, [bool]$TimedOut, [int]$DurationMs, [bool]$Recovered, [string]$Fingerprint) {
  $redacted = Redact-Fleet $StderrText
  if ($Summary.Length -gt 300) { $Summary = $Summary.Substring(0, 300) }
  $fp = if ($Fingerprint) { $Fingerprint } else { Get-FleetFingerprint $FleetHost $Component $Class "" }
  $now = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $evidence = [ordered]@{ snapshot = [ordered]@{ durationMs = $DurationMs; timedOut = $TimedOut } }
  if ($HasExit) { $evidence.exitCode = $ExitCode }
  if ($redacted.text.Length -gt 0) {
    $tail = $redacted.text
    if ($tail.Length -gt 4000) { $tail = $tail.Substring($tail.Length - 4000) }
    $evidence.stderrTail = $tail
  }
  $packet = [ordered]@{
    version = 1
    host = $FleetHost
    component = $Component
    severity = (Get-FleetSeverity $Class)
    failureClass = $Class
    firstSeen = $now
    lastSeen = $now
    count = 1
    fingerprint = $fp
    summary = $Summary
    evidence = $evidence
    redaction = [ordered]@{ applied = ($redacted.rules.Count -gt 0); rules = @($redacted.rules) }
    ownerChat = $null
    runbook = $null
  }
  if ($Recovered) { $packet.recovered = $true }
  return @{ json = ($packet | ConvertTo-Json -Compress -Depth 6); fingerprint = $fp; class = $Class }
}

$watch = [System.Diagnostics.Stopwatch]::StartNew()
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Command[0]
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.WorkingDirectory = (Get-Location).Path
if ($Command.Count -gt 1) {
  foreach ($arg in $Command[1..($Command.Count - 1)]) { [void]$psi.ArgumentList.Add($arg) }
}
Hide-FleetSecrets $psi
$proc = [System.Diagnostics.Process]::new()
$proc.StartInfo = $psi
try { [void]$proc.Start() } catch {
  $watch.Stop()
  $built = New-FleetPacket "ran-failed" "$Component on $FleetHost failed to start" $false 0 $_.Exception.Message $false ([int]$watch.ElapsedMilliseconds) $false ""
  [void](Send-FleetPacket $built.json)
  exit 127
}
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()
$timedOut = $false
if ($TimeoutSeconds -gt 0) {
  if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
    $timedOut = $true
    try { $proc.Kill($true) } catch { try { $proc.Kill() } catch {} }
    [void]$proc.WaitForExit()
  }
} else {
  [void]$proc.WaitForExit()
}
$stdoutText = $outTask.GetAwaiter().GetResult()
$stderrText = $errTask.GetAwaiter().GetResult()
$watch.Stop()
if ($stdoutText.Length -gt 0) { [Console]::Out.Write($stdoutText) }
if ($stderrText.Length -gt 0) { [Console]::Error.Write($stderrText) }

$exitCode = 0
if ($null -ne $proc.ExitCode) { $exitCode = [int]$proc.ExitCode }
$class = ""
if ($timedOut) { $class = "slow-or-timeout" }
elseif ($exitCode -ne 0) { if ($FailureClass) { $class = $FailureClass } else { $class = "ran-failed" } }
elseif ($ExpectOutput -and $stdoutText.Length -eq 0) { $class = "degraded-output" }

$duration = [int]$watch.ElapsedMilliseconds
if ($class) {
  $built = New-FleetPacket $class "$Component on $FleetHost failed" (-not $timedOut) $exitCode $stderrText $timedOut $duration $false ""
  if ($env:SCOUT_FLEET_SPOOL) {
    $openDir = Join-Path $env:SCOUT_FLEET_SPOOL "open"
    if (-not (Test-Path -LiteralPath $openDir)) { New-Item -ItemType Directory -Path $openDir | Out-Null }
    [System.IO.File]::WriteAllText((Join-Path $openDir $built.fingerprint), "$FleetHost`n$Component`n$($built.class)`n$($built.fingerprint)`n", $Utf8)
  }
  [void](Send-FleetPacket $built.json)
  if ($timedOut) { exit 124 }
  exit $exitCode
}

if ($env:SCOUT_FLEET_SPOOL) {
  $openDir = Join-Path $env:SCOUT_FLEET_SPOOL "open"
  if (Test-Path -LiteralPath $openDir) {
    foreach ($file in @(Get-ChildItem -LiteralPath $openDir -File)) {
      $lines = [System.IO.File]::ReadAllLines($file.FullName, $Utf8)
      if ($lines.Count -lt 4) { continue }
      if ($lines[0] -ne $FleetHost -or $lines[1] -ne $Component) { continue }
      $built = New-FleetPacket $lines[2] "$Component on $FleetHost recovered" $true 0 "" $false $duration $true $lines[3]
      $kept = Send-FleetPacket $built.json
      if ($kept) { Remove-Item -LiteralPath $file.FullName -Force }
    }
  }
}
exit 0
