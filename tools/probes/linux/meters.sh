echo "---SCOUT-MEMINFO---"
cat /proc/meminfo
echo "---SCOUT-STAT---"
head -n 1 /proc/stat
sleep 1
head -n 1 /proc/stat
echo "---SCOUT-DF---"
df -Pk
echo "---SCOUT-NET---"
cat /proc/net/dev
echo "---SCOUT-GPU---"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
echo "---SCOUT-PS---"
ps -Ao pid=,rss=,comm=
