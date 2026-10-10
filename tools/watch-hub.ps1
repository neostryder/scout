# Watches the Scout hub from outside it. The hub writes .scout-data/heartbeat.json every 30 seconds; this script alerts when the file goes quiet and again when it moves.
# Usage: pwsh -NoProfile -File tools/watch-hub.ps1 [-StaleSeconds 180] [-IntervalSeconds 60]
# Register it as a second logon task beside tools/run-hub.ps1, with the same environment, so SCOUT_DISCORD_WEBHOOK reaches both.
# It sends a Discord post (when SCOUT_DISCORD_WEBHOOK is set) and a desktop notification on this machine. It never reads the catalog.
param(
    [int]$StaleSeconds = 180,
    [int]$IntervalSeconds = 60
)
$root = Split-Path -Parent $PSScriptRoot
$beat = Join-Path $root '.scout-data/heartbeat.json'
$log = Join-Path $root '.scout-data/watch-hub.log'
New-Item -ItemType Directory -Force (Join-Path $root '.scout-data') | Out-Null

function Write-Log([string]$line) { "[watchdog] $(Get-Date -Format o) $line" | Out-File -FilePath $log -Append -Encoding utf8 }

function Send-Notice([string]$title, [string]$body) {
    $hook = $env:SCOUT_DISCORD_WEBHOOK
    if ($hook -and $hook -match '^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$') {
        try {
            $payload = @{ content = "**$title**`n$body"; allowed_mentions = @{ parse = @() } } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri $hook -ContentType 'application/json' -Body $payload -TimeoutSec 15 | Out-Null
        } catch { Write-Log 'The Discord post failed.' }
    }
    try {
        # The text travels in environment variables, so nothing in a notice can become a command.
        $env:SCOUT_NOTICE_TITLE = $title
        $env:SCOUT_NOTICE_BODY = $body
        $script = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true; $n.ShowBalloonTip(15000, $env:SCOUT_NOTICE_TITLE, $env:SCOUT_NOTICE_BODY, [System.Windows.Forms.ToolTipIcon]::Warning); Start-Sleep -Seconds 16; $n.Dispose()'
        Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $script) -WindowStyle Hidden | Out-Null
    } catch { Write-Log 'The desktop notice failed.' }
}

function Format-Span([TimeSpan]$span) {
    if ($span.TotalMinutes -lt 1) { return "$([int]$span.TotalSeconds) s" }
    if ($span.TotalHours -lt 1) { return "$([int]$span.TotalMinutes) min" }
    return "$([int]$span.TotalHours) h $($span.Minutes) min"
}

function Read-Beat {
    try {
        # ConvertFrom-Json turns the timestamp into a local DateTime and shifts it by the UTC offset, so read the text itself.
        $raw = Get-Content -Raw -Path $beat
        if ($raw -notmatch '"at"\s*:\s*"([^"]+)"') { return $null }
        return [DateTimeOffset]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    } catch { return $null }
}

$silentSince = $null
Write-Log 'started'
while ($true) {
    $at = Read-Beat
    if ($null -ne $at) {
        $age = [DateTimeOffset]::UtcNow - $at
        if ($age.TotalSeconds -gt $StaleSeconds -and $null -eq $silentSince) {
            $silentSince = $at
            Write-Log "heartbeat is $([int]$age.TotalSeconds) s old"
            Send-Notice 'Scout hub is not responding' "The hub has not written a heartbeat since $($at.ToLocalTime().ToString('g')). Outage checks are not running."
        } elseif ($age.TotalSeconds -le $StaleSeconds -and $null -ne $silentSince) {
            $span = $at - $silentSince
            Write-Log "heartbeat resumed after $(Format-Span $span)"
            Send-Notice 'Scout hub recovered' "The hub is writing heartbeats again after $(Format-Span $span)."
            $silentSince = $null
        }
    }
    Start-Sleep -Seconds $IntervalSeconds
}
