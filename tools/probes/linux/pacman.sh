LC_ALL=C pacman -Qi 2>/dev/null
rc=$?
echo "---SCOUT-FOREIGN---"
LC_ALL=C pacman -Qmq 2>/dev/null
exit $rc
