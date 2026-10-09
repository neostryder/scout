lsof -nP -iTCP -sTCP:LISTEN -F pcn 2>/dev/null
echo "---SCOUT-PS---"
ps -axo pid=,comm= 2>/dev/null
