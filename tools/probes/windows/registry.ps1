$paths = @(
  @{ Hive = 'HKLM'; Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' },
  @{ Hive = 'HKLM-WOW6432'; Path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' },
  @{ Hive = 'HKCU'; Path = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' }
)
$rows = foreach ($p in $paths) {
  Get-ItemProperty $p.Path -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
    [pscustomobject]@{ Hive = $p.Hive; Key = $_.PSChildName; DisplayName = $_.DisplayName; DisplayVersion = $_.DisplayVersion; Publisher = $_.Publisher; InstallLocation = $_.InstallLocation; DisplayIcon = $_.DisplayIcon; UninstallString = $_.UninstallString; SystemComponent = $_.SystemComponent }
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
