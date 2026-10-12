(sudo -n ss -H -ltnpe 2>/dev/null || ss -H -ltnpe 2>/dev/null)
echo "---SCOUT-PS---"
ps -eo pid=,ppid=,comm= 2>/dev/null
echo "---SCOUT-ARGS---"
ps -eo pid=,args= 2>/dev/null | awk '$2 ~ /(^|\/)(node|nodejs|bun|deno|python[0-9.]*|ruby|java|php|perl)$/'
