$paths = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique
ConvertTo-Json -InputObject @($paths) -Compress
