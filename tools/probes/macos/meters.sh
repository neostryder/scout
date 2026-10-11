echo "---SCOUT-MEM---"
sysctl -n hw.memsize
sysctl -n hw.logicalcpu
echo "---SCOUT-VM---"
vm_stat
echo "---SCOUT-CPU---"
top -l 2 -n 0 -s 1 | grep "CPU usage" | tail -1
echo "---SCOUT-DF---"
df -Pk
echo "---SCOUT-NET---"
netstat -ib
echo "---SCOUT-PS---"
ps -Ao pid=,pcpu=,rss=,comm=
