systemctl show '*.service' --no-pager --property=Id,Description,LoadState,ActiveState,SubState,MainPID,UnitFileState,FragmentPath,ExecStart,User,Type,RemainAfterExit 2>/dev/null
echo '---SCOUT-FILES---'
systemctl list-unit-files --type=service --no-legend --no-pager --plain 2>/dev/null
