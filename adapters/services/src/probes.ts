export const WINDOWS_SERVICE_STATE_SCRIPT = `$rows = Get-CimInstance Win32_Service | Select-Object Name, DisplayName, PathName, State, StartMode, ProcessId, StartName
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`;

export const WINDOWS_TASKS_SCRIPT = `$rows = Get-ScheduledTask | ForEach-Object {
  $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -ErrorAction SilentlyContinue
  [pscustomobject]@{
    TaskName = $_.TaskName
    TaskPath = $_.TaskPath
    State = [string]$_.State
    Execute = ($_.Actions | Select-Object -First 1).Execute
    Triggers = @($_.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task','' -replace 'Trigger$','' })
    RunAs = $_.Principal.UserId
    LastRun = if ($info -and $info.LastRunTime.Year -gt 1999) { $info.LastRunTime.ToString('o') } else { $null }
    LastResult = if ($info) { $info.LastTaskResult } else { $null }
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`;

export const MAC_LAUNCHD_STATE_SCRIPT = `echo '---SCOUT-SYSTEM---'
launchctl print system 2>/dev/null | awk '/^\\tservices = \\{/{f=1;next} f&&/^\\t\\}/{exit} f'
echo '---SCOUT-GUI---'
launchctl print "gui/$(id -u)" 2>/dev/null | awk '/^\\tservices = \\{/{f=1;next} f&&/^\\t\\}/{exit} f'
echo '---SCOUT-DISABLED-SYSTEM---'
launchctl print-disabled system 2>/dev/null
echo '---SCOUT-DISABLED-GUI---'
launchctl print-disabled "gui/$(id -u)" 2>/dev/null
`;
