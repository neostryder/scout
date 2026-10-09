# Runs the Scout hub in production mode and restarts it 10 seconds after any exit. Output goes to .scout-data/hub.log.
# Usage: pwsh -NoProfile -File tools/run-hub.ps1 [extra hub arguments]
# Register it as a logon task to keep the hub up; set SCOUT_AI_TOOLKIT and the other optional variables here if you use them.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root '.scout-data') | Out-Null
$log = Join-Path $root '.scout-data/hub.log'
while ($true) {
    "[supervisor] starting hub $(Get-Date -Format o)" | Out-File -FilePath $log -Append -Encoding utf8
    cmd /c "pnpm --filter @scout/hub start:production $($args -join ' ') >> `"$log`" 2>&1"
    "[supervisor] hub exited with code $LASTEXITCODE at $(Get-Date -Format o); restarting in 10s" | Out-File -FilePath $log -Append -Encoding utf8
    Start-Sleep -Seconds 10
}
