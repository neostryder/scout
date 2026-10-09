$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist'
$rows = foreach ($g in Get-ChildItem $root) {
  $c = Join-Path $g.PSPath 'Count'
  if (-not (Test-Path $c)) { continue }
  $k = Get-Item $c
  foreach ($n in $k.GetValueNames()) {
    $v = $k.GetValue($n)
    if ($v -is [byte[]]) { [pscustomobject]@{ Guid = $g.PSChildName; Name = $n; Hex = ([BitConverter]::ToString($v) -replace '-', '') } }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
