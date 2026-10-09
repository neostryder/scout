$rows = Get-ScheduledTask | ForEach-Object {
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
