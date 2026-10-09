Import-Module Microsoft.WinGet.Client -ErrorAction Stop
$rows = Get-WinGetPackage | Select-Object Id, Name, InstalledVersion, Source, IsUpdateAvailable, @{ n = 'AvailableVersion'; e = { $_.AvailableVersions | Select-Object -First 1 } }
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
