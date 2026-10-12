$ErrorActionPreference = 'SilentlyContinue'
$runtime = '^(node|nodejs|bun|deno|python[0-9.]*|pythonw|ruby|java|javaw|php|perl)$'
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_ }
$cmds = @{}
$parents = @{}
Get-CimInstance Win32_Process | ForEach-Object { $cmds[[int]$_.ProcessId] = $_.CommandLine; $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
# An elevated process hides its path and command line from this session. A wrapper service (shawl, for one) names the real command after a bare "--", and the service table is readable, so read it from the parent service.
$wrapped = @{}
# The service table is readable too. It gives a service's display name by service name, and by the process when that process runs only that one service (a shared host such as svchost would name the wrong thing).
$svcName = @{}
$svcPid = @{}
Get-CimInstance Win32_Service | ForEach-Object { $svcName[$_.Name] = $_.DisplayName; if ($_.ProcessId -and $_.ServiceType -match 'Own') { if (-not $svcPid.ContainsKey([int]$_.ProcessId)) { $svcPid[[int]$_.ProcessId] = @() }; $svcPid[[int]$_.ProcessId] += $_.DisplayName }; if ($_.ProcessId -and $_.PathName -match '\s--\s+(.+)$') { $wrapped[[int]$_.ProcessId] = $Matches[1] } }
$listen = @(Get-NetTCPConnection -State Listen)
# The socket owner table names the owner of each listening socket as a service name or an executable path, and it answers for elevated and system processes too.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ScoutTcp {
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sort, int af, int cls, int reserved);
  [DllImport("iphlpapi.dll")] static extern uint GetOwnerModuleFromTcpEntry(IntPtr row, int cls, IntPtr buf, ref int size);
  [DllImport("iphlpapi.dll")] static extern uint GetOwnerModuleFromTcp6Entry(IntPtr row, int cls, IntPtr buf, ref int size);
  static uint Module(int af, IntPtr row, IntPtr buf, ref int size) { return af == 2 ? GetOwnerModuleFromTcpEntry(row, 0, buf, ref size) : GetOwnerModuleFromTcp6Entry(row, 0, buf, ref size); }
  public static string[] Owners() {
    var rows = new List<string>();
    foreach (int af in new int[] { 2, 23 }) {
      int size = 0;
      GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 6, 0);
      if (size == 0) continue;
      size += 4096;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (GetExtendedTcpTable(buf, ref size, false, af, 6, 0) != 0) continue;
        int count = Marshal.ReadInt32(buf);
        int stride = af == 2 ? 160 : 192;
        int portAt = af == 2 ? 8 : 20;
        int pidAt = af == 2 ? 20 : 52;
        for (int i = 0; i < count; i++) {
          IntPtr row = IntPtr.Add(buf, 8 + i * stride);
          int raw = Marshal.ReadInt32(row, portAt);
          int port = ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);
          int pid = Marshal.ReadInt32(row, pidAt);
          string name = "";
          string path = "";
          int need = 0;
          Module(af, row, IntPtr.Zero, ref need);
          if (need > 0) {
            IntPtr info = Marshal.AllocHGlobal(need);
            try {
              if (Module(af, row, info, ref need) == 0) {
                IntPtr n = Marshal.ReadIntPtr(info, 0);
                IntPtr p = Marshal.ReadIntPtr(info, IntPtr.Size);
                if (n != IntPtr.Zero) name = Marshal.PtrToStringUni(n);
                if (p != IntPtr.Zero) path = Marshal.PtrToStringUni(p);
              }
            } finally { Marshal.FreeHGlobal(info); }
          }
          byte[] raw16 = new byte[af == 2 ? 4 : 16];
          for (int b = 0; b < raw16.Length; b++) raw16[b] = Marshal.ReadByte(row, (af == 2 ? 4 : 0) + b);
          string address = af == 2 ? new System.Net.IPAddress(raw16).ToString() : new System.Net.IPAddress(raw16, (uint)Marshal.ReadInt32(row, 16)).ToString();
          rows.Add(address + "|" + port + "|" + pid + "|" + name + "|" + path);
        }
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return rows.ToArray();
  }
}
'@
# This table is complete when Get-NetTCPConnection drops loopback listeners or reports their owner as process 0, so it supplies the rows and Get-NetTCPConnection fills in any it lacks.
$rows = @()
$seen = @{}
$owners = @{}
foreach ($line in [ScoutTcp]::Owners()) {
  $f = $line.Split('|')
  $rows += [pscustomobject]@{ LocalAddress = $f[0]; LocalPort = [int]$f[1]; OwningProcess = [int]$f[2]; Module = $f[3]; ModulePath = $f[4] }
  $seen["$($f[0])|$($f[1])"] = $true
  if (-not $owners.ContainsKey($f[1])) { $owners[$f[1]] = @() }
  $owners[$f[1]] += ,@([int]$f[2], $f[3], $f[4])
}
foreach ($c in $listen) { if (-not $seen.ContainsKey("$($c.LocalAddress)|$($c.LocalPort)")) { $rows += [pscustomobject]@{ LocalAddress = $c.LocalAddress; LocalPort = [int]$c.LocalPort; OwningProcess = [int]$c.OwningProcess; Module = ''; ModulePath = '' } } }
if (($rows | Where-Object { $procs[[int]$_.OwningProcess].ProcessName -match $runtime }) -or ($owners.Values | ForEach-Object { $_ } | Where-Object { $procs[[int]$_[0]].ProcessName -match $runtime })) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScoutCwd {
  [StructLayout(LayoutKind.Sequential)] struct Pbi { public IntPtr Exit, Peb, Affinity, Priority, Pid, Parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref Pbi pbi, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      Pbi pbi = new Pbi(); int ret; IntPtr rd;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
      byte[] b = new byte[8];
      if (!ReadProcessMemory(h, IntPtr.Add(pbi.Peb, 0x20), b, 8, out rd)) return null;
      IntPtr pp = (IntPtr)BitConverter.ToInt64(b, 0);
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, IntPtr.Add(pp, 0x38), us, 16, out rd)) return null;
      int len = BitConverter.ToUInt16(us, 0);
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)BitConverter.ToInt64(us, 8), s, len, out rd)) return null;
      return System.Text.Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
'@
}
$rows | ForEach-Object {
  $id = [int]$_.OwningProcess
  $entry = $null
  if ($_.Module -or $_.ModulePath) { $entry = @($id, $_.Module, $_.ModulePath) }
  if ($id -eq 0) {
    # A socket still reported under process 0 takes the real owner when the port has exactly one.
    $real = @($owners["$($_.LocalPort)"] | ForEach-Object { $_ } | Where-Object { $_ -is [array] -and $_[0] -ne 0 } | ForEach-Object { $_[0] } | Select-Object -Unique)
    if ($real.Count -eq 1) { $id = $real[0]; $entry = @($owners["$($_.LocalPort)"] | Where-Object { $_[0] -eq $id })[0] }
  }
  $p = $procs[$id]
  $cmd = $null
  $cwd = $null
  $path = $p.Path
  $name = $p.ProcessName
  $owner = $null
  if ($entry) {
    if ($entry[2] -match '^[A-Za-z]:') { if (-not $path) { $path = $entry[2] }; if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($entry[2]) } }
    elseif ($entry[1] -and $svcName.ContainsKey($entry[1])) { $owner = $svcName[$entry[1]] }
  }
  if (-not $owner -and $svcPid.ContainsKey($id) -and $svcPid[$id].Count -eq 1) { $owner = $svcPid[$id][0] }
  if (-not $owner) {
    # A process started by a single-service host, such as a wrapper service, takes that service's name.
    $up = $parents[$id]
    for ($step = 0; $step -lt 6 -and $up -gt 4; $step++) {
      if ($svcPid.ContainsKey($up)) { if ($svcPid[$up].Count -eq 1) { $owner = $svcPid[$up][0] + ' service' }; break }
      $up = $parents[$up]
    }
  }
  if (-not $owner) {
    # Windows' own processes name no service, so the common ones are named here.
    if ($id -eq 4) { $owner = switch ([int]$_.LocalPort) { 139 { 'NetBIOS file sharing' } 445 { 'File sharing (SMB)' } 5357 { 'Web Services for Devices (HTTP.sys)' } default { 'Windows kernel (HTTP.sys or SMB)' } } }
    elseif ($name -eq 'lsass') { $owner = 'Local Security Authority (RPC)' }
    elseif ($name -eq 'wininit') { $owner = 'Windows start-up (RPC)' }
    elseif ($name -eq 'services') { $owner = 'Service Control Manager (RPC)' }
  }
  if ($name -match $runtime) {
    $cmd = $cmds[$id]
    if ($cmd) { $cwd = [ScoutCwd]::Get($id) }
    if (-not $cmd -and -not $path) {
      $via = $wrapped[$parents[$id]]
      if ($via) { $cmd = $via; if ($via -match '^"([^"]+)"') { $path = $Matches[1] } elseif ($via -match '^(\S+)') { $path = $Matches[1] } }
    }
  }
  [pscustomobject]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = $id; name = $name; path = $path; cmd = $cmd; cwd = $cwd; ppid = $parents[$id]; owner = $owner }
} | ConvertTo-Json -Compress
