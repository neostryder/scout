$rows = Get-CimInstance Win32_Service | Select-Object Name, DisplayName, PathName, State, StartMode, ProcessId, StartName
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
