$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ mount = $_.DeviceID; total = [double]$_.Size; free = [double]$_.FreeSpace } })
$nics = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Get-NetAdapterStatistics)
$rx = ($nics | Measure-Object -Property ReceivedBytes -Sum).Sum
$tx = ($nics | Measure-Object -Property SentBytes -Sum).Sum
$gpu = @()
if (Get-Command nvidia-smi) { $gpu = @(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits) }
$procs = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { [pscustomobject]@{ id = [int]$_.IDProcess; name = $_.Name; cpu = [double]$_.PercentProcessorTime; mem = [double]$_.WorkingSetPrivate } })
$top = @(($procs | Sort-Object cpu -Descending | Select-Object -First 8) + ($procs | Sort-Object mem -Descending | Select-Object -First 8))
[pscustomobject]@{ cpu = [double]$cpu; cores = [int]$env:NUMBER_OF_PROCESSORS; memTotal = [double]$os.TotalVisibleMemorySize * 1024; memFree = [double]$os.FreePhysicalMemory * 1024; disks = $disks; rx = [double]$rx; tx = [double]$tx; gpu = $gpu; procs = $top } | ConvertTo-Json -Compress -Depth 4
