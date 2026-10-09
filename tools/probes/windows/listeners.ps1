$ErrorActionPreference = 'SilentlyContinue'
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_ }
Get-NetTCPConnection -State Listen | ForEach-Object {
  $p = $procs[[int]$_.OwningProcess]
  [pscustomobject]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; name = $p.ProcessName; path = $p.Path }
} | ConvertTo-Json -Compress
