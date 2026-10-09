echo '---SCOUT-SYSTEM---'
launchctl print system 2>/dev/null | awk '/^\tservices = \{/{f=1;next} f&&/^\t\}/{exit} f'
echo '---SCOUT-GUI---'
launchctl print "gui/$(id -u)" 2>/dev/null | awk '/^\tservices = \{/{f=1;next} f&&/^\t\}/{exit} f'
echo '---SCOUT-DISABLED-SYSTEM---'
launchctl print-disabled system 2>/dev/null
echo '---SCOUT-DISABLED-GUI---'
launchctl print-disabled "gui/$(id -u)" 2>/dev/null
