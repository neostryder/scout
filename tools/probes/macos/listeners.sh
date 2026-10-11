lsof -nP -iTCP -sTCP:LISTEN -F pcn 2>/dev/null
echo "---SCOUT-PS---"
ps -axo pid=,comm= 2>/dev/null
echo "---SCOUT-ARGS---"
ps -axo pid=,args= 2>/dev/null | awk '$2 ~ /(^|\/)(node|nodejs|bun|deno|python[0-9.]*|ruby|java|php|perl)$/'
echo "---SCOUT-PPID---"
ps -axo pid=,ppid= 2>/dev/null
