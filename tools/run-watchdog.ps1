# Runs the Scout outage watchdog and restarts it 10 seconds after any exit. The watchdog writes its own events to .scout-data/watch-hub.log and anything it prints to .scout-data/watch-hub.out.log.
# Usage: pwsh -NoProfile -File tools/run-watchdog.ps1 [extra watchdog arguments]
# Register it as a second logon task beside the hub. The Discord address comes from SCOUT_DISCORD_WEBHOOK or .scout-data/discord-webhook.dpapi.
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root 'packages/hub')
New-Item -ItemType Directory -Force (Join-Path $root '.scout-data') | Out-Null
$log = Join-Path $root '.scout-data/watch-hub.log'
$out = Join-Path $root '.scout-data/watch-hub.out.log'
while ($true) {
    "[supervisor] starting watchdog $(Get-Date -Format o)" | Out-File -FilePath $log -Append -Encoding utf8
    & node src/watchdog.ts @args *>> $out
    "[supervisor] watchdog exited with code $LASTEXITCODE at $(Get-Date -Format o); restarting in 10s" | Out-File -FilePath $log -Append -Encoding utf8
    Start-Sleep -Seconds 10
}
