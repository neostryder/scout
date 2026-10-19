# Runs the Scout hub in production mode and restarts it 10 seconds after any exit. Output goes to .scout-data/hub.log.
# Usage: pwsh -NoProfile -File tools/run-hub.ps1 [extra hub arguments]
# tools/install-app.ps1 registers it as a logon task. Optional settings come from the environment first, then from .scout-data/hub-settings.json, then from the defaults:
#   aiToolkit           SCOUT_AI_TOOLKIT            Path to ai.ps1. Default: %LOCALAPPDATA%\AiCliToolkit\ai.ps1. Models stay off when the file is missing.
#   modelRoutePublic    SCOUT_MODEL_ROUTE_PUBLIC    Default: m3
#   modelRouteInternal  SCOUT_MODEL_ROUTE_INTERNAL  Default: luna
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force (Join-Path $root '.scout-data') | Out-Null
$log = Join-Path $root '.scout-data/hub.log'
function Write-Supervisor([string]$Message) { "[supervisor] $Message $(Get-Date -Format o)" | Out-File -FilePath $log -Append -Encoding utf8 }

$settings = @{}
$settingsFile = Join-Path $root '.scout-data/hub-settings.json'
if (Test-Path -LiteralPath $settingsFile) {
    try { $settings = Get-Content -Raw -LiteralPath $settingsFile | ConvertFrom-Json -AsHashtable } catch { Write-Supervisor 'ignoring unreadable hub-settings.json' }
    if (-not $settings) { $settings = @{} }
}
function Resolve-Setting([string]$Variable, [string]$Key, [string]$Default) {
    $current = [Environment]::GetEnvironmentVariable($Variable)
    if ($current) { return $current }
    if ($settings[$Key]) { return [string]$settings[$Key] }
    return $Default
}
$toolkit = Resolve-Setting 'SCOUT_AI_TOOLKIT' 'aiToolkit' (Join-Path $env:LOCALAPPDATA 'AiCliToolkit/ai.ps1')
if (Test-Path -LiteralPath $toolkit) { $env:SCOUT_AI_TOOLKIT = $toolkit -replace '\\', '/' }
else { Write-Supervisor "AI toolkit not found at $toolkit, so models stay off"; Remove-Item Env:SCOUT_AI_TOOLKIT -ErrorAction SilentlyContinue }
$env:SCOUT_MODEL_ROUTE_PUBLIC = Resolve-Setting 'SCOUT_MODEL_ROUTE_PUBLIC' 'modelRoutePublic' 'm3'
$env:SCOUT_MODEL_ROUTE_INTERNAL = Resolve-Setting 'SCOUT_MODEL_ROUTE_INTERNAL' 'modelRouteInternal' 'luna'

Set-Location (Join-Path $root 'packages/hub')
while ($true) {
    Write-Supervisor 'starting hub'
    & node src/main.ts --production --schedule-models @args *>> $log
    Write-Supervisor "hub exited with code $LASTEXITCODE at"
    Start-Sleep -Seconds 10
}
