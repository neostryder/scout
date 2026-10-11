$ErrorActionPreference = 'SilentlyContinue'
$runtime = '^(node|nodejs|bun|deno|python[0-9.]*|pythonw|ruby|java|javaw|php|perl)$'
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_ }
$cmds = @{}
$parents = @{}
Get-CimInstance Win32_Process | ForEach-Object { $cmds[[int]$_.ProcessId] = $_.CommandLine; $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
# An elevated process hides its path and command line from this session. A wrapper service (shawl, for one) names the real command after a bare "--", and the service table is readable, so read it from the parent service.
$wrapped = @{}
Get-CimInstance Win32_Service | ForEach-Object { if ($_.ProcessId -and $_.PathName -match '\s--\s+(.+)$') { $wrapped[[int]$_.ProcessId] = $Matches[1] } }
$listen = @(Get-NetTCPConnection -State Listen)
if ($listen | Where-Object { $procs[[int]$_.OwningProcess].ProcessName -match $runtime }) {
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
$listen | ForEach-Object {
  $p = $procs[[int]$_.OwningProcess]
  $cmd = $null
  $cwd = $null
  $path = $p.Path
  if ($p.ProcessName -match $runtime) {
    $cmd = $cmds[[int]$_.OwningProcess]
    if ($cmd) { $cwd = [ScoutCwd]::Get([int]$_.OwningProcess) }
    if (-not $cmd -and -not $path) {
      $via = $wrapped[$parents[[int]$_.OwningProcess]]
      if ($via) { $cmd = $via; if ($via -match '^"([^"]+)"') { $path = $Matches[1] } elseif ($via -match '^(\S+)') { $path = $Matches[1] } }
    }
  }
  [pscustomobject]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; name = $p.ProcessName; path = $path; cmd = $cmd; cwd = $cwd }
} | ConvertTo-Json -Compress
