LC_ALL=C pacman -Qi 2>/dev/null
rc=$?
echo "---SCOUT-FOREIGN---"
LC_ALL=C pacman -Qmq 2>/dev/null
echo "---SCOUT-PENDING---"
if command -v checkupdates >/dev/null 2>&1; then
  LC_ALL=C timeout 50 checkupdates 2>/dev/null
  echo "exit=$?"
fi
echo "---SCOUT-AUR---"
if command -v yay >/dev/null 2>&1; then
  LC_ALL=C timeout 50 yay -Qua 2>/dev/null
  echo "exit=$?"
fi
echo "---SCOUT-UPGRADED---"
grep 'starting full system upgrade' /var/log/pacman.log 2>/dev/null | tail -n 1
echo "---SCOUT-NOW---"
date +%Y-%m-%dT%H:%M:%S
exit $rc
