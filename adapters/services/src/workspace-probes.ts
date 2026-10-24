export const WINDOWS_WORKSPACE_SCRIPT = String.raw`$pattern = '(?i)[\\/](Repositories|_worktrees)([\\/]|$)'
$rows = @()
Get-CimInstance Win32_Service | Where-Object { $_.PathName -match $pattern } | ForEach-Object {
  $rows += [pscustomobject]@{ Kind = 'windows-service'; Name = $_.Name; Location = 'Services'; Command = $_.PathName }
}
Get-ScheduledTask | ForEach-Object {
  $command = (@($_.Actions) | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' '
  if ($command -match $pattern) { $rows += [pscustomobject]@{ Kind = 'scheduled-task'; Name = $_.TaskName; Location = $_.TaskPath; Command = $command } }
}
foreach ($key in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run') {
  $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if (-not $item) { continue }
  foreach ($property in $item.PSObject.Properties) {
    if ($property.Name -like 'PS*' -or "$($property.Value)" -notmatch $pattern) { continue }
    $rows += [pscustomobject]@{ Kind = 'run-key'; Name = $property.Name; Location = $key; Command = "$($property.Value)" }
  }
}
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup") {
  Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue | ForEach-Object {
    $command = if ($_.Extension -eq '.lnk') { $link = $shell.CreateShortcut($_.FullName); "$($link.TargetPath) $($link.Arguments) $($link.WorkingDirectory)" } else { $_.FullName }
    if ($command -match $pattern) { $rows += [pscustomobject]@{ Kind = 'startup-folder'; Name = $_.Name; Location = $folder; Command = $command } }
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`;

export const MAC_WORKSPACE_SCRIPT = String.raw`for f in "$HOME"/Library/LaunchAgents/*.plist /Library/LaunchAgents/*.plist /Library/LaunchDaemons/*.plist; do
  [ -f "$f" ] || continue
  t=$(plutil -convert xml1 -o - "$f" 2>/dev/null) || continue
  case "$t" in
    */Repositories/*|*/_worktrees/*) printf -- '---SCOUT-ITEM---launchd\t%s\n%s\n' "$f" "$t" ;;
  esac
done
`;

export const LINUX_WORKSPACE_SCRIPT = String.raw`for f in /etc/systemd/system/*.service "$HOME"/.config/systemd/user/*.service "$HOME"/.config/autostart/*.desktop; do
  [ -f "$f" ] || continue
  case "$f" in *.desktop) kind=autostart ;; *) kind=systemd ;; esac
  if grep -qE '/(Repositories|_worktrees)/' "$f" 2>/dev/null; then
    printf -- '---SCOUT-ITEM---%s\t%s\n' "$kind" "$f"
    head -c 8192 "$f"
    printf '\n'
  fi
done
`;
