export const WINDOWS_LISTENERS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_ }
Get-NetTCPConnection -State Listen | ForEach-Object {
  $p = $procs[[int]$_.OwningProcess]
  [pscustomobject]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; name = $p.ProcessName; path = $p.Path }
} | ConvertTo-Json -Compress
`;

export const MAC_LISTENERS_SCRIPT = `lsof -nP -iTCP -sTCP:LISTEN -F pcn 2>/dev/null
echo "---SCOUT-PS---"
ps -axo pid=,comm= 2>/dev/null
`;

export const DOCKER_PORTS_SCRIPT = `for sock in "$HOME/.colima/default/docker.sock" "$HOME/.orbstack/run/docker.sock" /var/run/docker.sock; do
  if [ -S "$sock" ]; then
    DOCKER_HOST="unix://$sock" docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}|{{.Status}}' 2>/dev/null
    exit 0
  fi
done
exit 0
`;
