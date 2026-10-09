$ErrorActionPreference = 'SilentlyContinue'
# Windows Installer keeps, for every machine-wide component, the product codes that use it and the path of its key file.
# Product codes are stored packed: each GUID segment reversed, the last two groups swapped pairwise.
function Unpack([string]$p) {
  $rev = { param($s) -join ($s.ToCharArray()[($s.Length - 1)..0]) }
  $swap = { param($s) -join (0..($s.Length / 2 - 1) | ForEach-Object { $s[2 * $_ + 1]; $s[2 * $_] }) }
  $a = & $rev $p.Substring(0, 8); $b = & $rev $p.Substring(8, 4); $c = & $rev $p.Substring(12, 4)
  $d = & $swap $p.Substring(16, 4); $e = & $swap $p.Substring(20, 12)
  ('{' + "$a-$b-$c-$d-$e" + '}').ToUpper()
}
$paths = @{}
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData\S-1-5-18\Components'
foreach ($comp in Get-ChildItem $base) {
  $props = Get-ItemProperty $comp.PSPath
  foreach ($name in $comp.Property) {
    if ($name.Length -ne 32) { continue }
    $value = [string]$props.$name
    if ($value.StartsWith('?')) { $value = $value.Substring(1) }
    if ($value -notmatch '^[A-Za-z]:\\') { continue }
    $code = Unpack $name
    if (-not $paths.ContainsKey($code)) { $paths[$code] = [System.Collections.Generic.List[string]]::new() }
    $paths[$code].Add([IO.Path]::GetDirectoryName($value))
  }
}
foreach ($code in $paths.Keys) {
  $dirs = @($paths[$code] | Where-Object { $_ -notmatch '^[A-Za-z]:\\Windows(\\|$)' -and $_ -notmatch '\\Common Files(\\|$)' })
  if ($dirs.Count -eq 0) { continue }
  $parts = @($dirs | ForEach-Object { , ($_ -split '\\') })
  $common = $parts[0]
  foreach ($p in $parts) {
    $n = 0
    while ($n -lt $common.Count -and $n -lt $p.Count -and $common[$n] -ieq $p[$n]) { $n++ }
    $common = $common[0..($n - 1)]
  }
  [Console]::WriteLine($code + [char]9 + ($common -join '/') + [char]9 + $dirs.Count)
}
