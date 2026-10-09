$rows = Get-AppxPackage | Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' } | Select-Object Name, PackageFullName, Version, Publisher, InstallLocation, SignatureKind
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
