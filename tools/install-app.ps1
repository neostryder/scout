# Installs Scout as a per-user app so the hub, watchdog, and any scheduled job run from a copy outside the source tree.
# Usage: pwsh -NoProfile -File tools/install-app.ps1 [-Target <dir>] [-NoTasks] [-NoStart] [-NoData]
#   -Target   Install root. Default: %LOCALAPPDATA%\Scout.
#   -NoTasks  Build the copy only: no process is stopped, no task is changed or started, and data is not migrated unless -Data is given.
#   -NoStart  Register the tasks but leave them stopped.
#   -NoData   Never migrate .scout-data, even on a first install.
# The install mirrors the code into the target, runs pnpm install --prod there, and keeps data and settings in the target's .scout-data folder, machines.json, and access.json.
# Rerun it after a rebuild to reinstall: code is replaced, data and settings stay. On the first install it migrates .scout-data from the source and leaves the source copy in place.
[CmdletBinding()]
param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'Scout'),
    [switch]$NoTasks,
    [switch]$NoStart,
    [switch]$NoData,
    [switch]$Data
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$Target = [IO.Path]::GetFullPath($Target)
$sourceFull = [IO.Path]::GetFullPath($source).TrimEnd('\')
$targetFull = $Target.TrimEnd('\')
if ($targetFull -eq $sourceFull -or $targetFull.StartsWith("$sourceFull\") -or $sourceFull.StartsWith("$targetFull\")) { throw "Target $Target and source $source must not contain each other." }

function Step([string]$Message) { Write-Host "[install] $Message" }
function Find-Processes([string[]]$Patterns) {
    Get-CimInstance Win32_Process | Where-Object {
        $line = $_.CommandLine
        $_.ProcessId -ne $PID -and $_.Name -in 'pwsh.exe', 'node.exe' -and $line -and @($Patterns | Where-Object { $line -like $_ }).Count -gt 0
    }
}

$hubTask = 'Scout Hub'
$watchdogTask = 'Scout Watchdog'
if (-not $NoTasks) {
    # Keep the names an earlier install registered.
    foreach ($legacy in 'Scout Version Tracker (scout.rpgm.tools)') { if (Get-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue) { $hubTask = $legacy } }
    foreach ($legacy in 'Scout Watchdog (outage heartbeat)') { if (Get-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue) { $watchdogTask = $legacy } }
}

function Stop-Scout {
    Step 'stopping the Scout tasks, supervisors, and hub processes'
    foreach ($name in $hubTask, $watchdogTask) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
    # Stopping a task ends only its wrapper, so the supervisor loops are stopped before the node processes they restart.
    foreach ($process in @(Find-Processes @('*run-hub.ps1*', '*run-watchdog.ps1*'))) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($process in @(Find-Processes @('*src/main.ts*--production*', '*src\main.ts*--production*', '*src/watchdog.ts*', '*src\watchdog.ts*'))) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

if (-not $NoTasks) { Stop-Scout }

Step "copying the code to $Target"
New-Item -ItemType Directory -Force $Target | Out-Null
$firstInstall = -not (Test-Path -LiteralPath (Join-Path $Target '.scout-data/catalog.db'))
& robocopy $source $Target /MIR /XD node_modules .git .scout-data target dist /XF access.json machines.json /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy of the code failed with exit code $LASTEXITCODE" }

Step 'installing production dependencies'
Push-Location $Target
try {
    & pnpm install --prod --frozen-lockfile --reporter=silent
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }

$dataDir = Join-Path $Target '.scout-data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
if ($firstInstall -and -not $NoData -and ((-not $NoTasks) -or $Data) -and (Test-Path -LiteralPath (Join-Path $source '.scout-data'))) {
    Step 'migrating .scout-data (scratch files named _* and profiling leftovers stay behind)'
    & robocopy (Join-Path $source '.scout-data') $dataDir /E /XD '_*' /XF '_*' 'flaky*' 'hub-prof*' 'cl.crlf' '*.bak-*' 'catalog-backup-*' 'preview.db*' /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy of the data failed with exit code $LASTEXITCODE" }
}
foreach ($config in 'machines.json', 'access.json') {
    $from = Join-Path $source $config
    $to = Join-Path $Target $config
    if ((Test-Path -LiteralPath $from) -and -not (Test-Path -LiteralPath $to)) { Copy-Item -LiteralPath $from -Destination $to }
}

if ($NoTasks) { Step "copy built at $Target; no task was touched"; return }

$pwsh = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
if (-not (Test-Path -LiteralPath $pwsh)) { $pwsh = (Get-Command pwsh).Source }
function New-ScoutAction([string]$Script) {
    $arguments = "--headless `"$pwsh`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $Target "tools\$Script")`""
    New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\conhost.exe') -Argument $arguments -WorkingDirectory $Target
}
function Set-ScoutTask([string]$Name, [string]$Script, [int]$RestartCount) {
    $action = New-ScoutAction $Script
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Set-ScheduledTask -TaskName $Name -Action $action | Out-Null
        return
    }
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount $RestartCount -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) | Out-Null
}
Step "registering the $hubTask and $watchdogTask tasks"
Set-ScoutTask $hubTask 'run-hub.ps1' 999
Set-ScoutTask $watchdogTask 'run-watchdog.ps1' 3

[ordered]@{ installedAt = (Get-Date).ToUniversalTime().ToString('o'); source = $sourceFull; target = $targetFull; hubTask = $hubTask; watchdogTask = $watchdogTask } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDir 'install.json') -Encoding utf8

if (-not $NoStart) {
    Step 'starting the tasks'
    Start-ScheduledTask -TaskName $hubTask
    Start-ScheduledTask -TaskName $watchdogTask
}
Step "done: Scout runs from $Target"
