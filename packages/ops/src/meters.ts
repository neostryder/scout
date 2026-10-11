import { parseMeters, recordMeterReading, runArgv, type Db, type Exec, type MeterSample, type Transport } from "@scout/core";

/** The fixed meter scripts. Each prints one reading; none takes input. The same text lives in tools/probes/meters/ for running by hand. */
export const WINDOWS_METERS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ mount = $_.DeviceID; total = [double]$_.Size; free = [double]$_.FreeSpace } })
$nics = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Get-NetAdapterStatistics)
$rx = ($nics | Measure-Object -Property ReceivedBytes -Sum).Sum
$tx = ($nics | Measure-Object -Property SentBytes -Sum).Sum
$gpu = @()
if (Get-Command nvidia-smi) { $gpu = @(nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits) }
$procs = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { [pscustomobject]@{ id = [int]$_.IDProcess; name = $_.Name; cpu = [double]$_.PercentProcessorTime; mem = [double]$_.WorkingSetPrivate } })
$top = @(($procs | Sort-Object cpu -Descending | Select-Object -First 8) + ($procs | Sort-Object mem -Descending | Select-Object -First 8))
[pscustomobject]@{ cpu = [double]$cpu; cores = [int]$env:NUMBER_OF_PROCESSORS; memTotal = [double]$os.TotalVisibleMemorySize * 1024; memFree = [double]$os.FreePhysicalMemory * 1024; disks = $disks; rx = [double]$rx; tx = [double]$tx; gpu = $gpu; procs = $top } | ConvertTo-Json -Compress -Depth 4
`;

export const MAC_METERS_SCRIPT = `echo "---SCOUT-MEM---"
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
`;

export const LINUX_METERS_SCRIPT = `echo "---SCOUT-MEMINFO---"
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
`;

export interface MeterMachine {
  id: string;
  os: "windows" | "macos" | "linux";
  transport: Transport;
}

export function meterArgv(os: MeterMachine["os"]): string[] {
  return os === "windows" ? ["pwsh", "-NoProfile", "-Command", WINDOWS_METERS_SCRIPT] : ["/bin/sh", "-c", os === "macos" ? MAC_METERS_SCRIPT : LINUX_METERS_SCRIPT];
}

export interface MeterCycleOptions {
  run?: Exec;
  now?: () => string;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface MeterCycleResult {
  machineId: string;
  ok: boolean;
  sample: MeterSample | null;
  error: string | null;
}

/** Read every machine once, in parallel. A machine that cannot be read keeps its last sample; the failure is reported and logged, never thrown. */
export async function runMeterCycle(db: Db, machines: MeterMachine[], options: MeterCycleOptions = {}): Promise<MeterCycleResult[]> {
  const run = options.run ?? runArgv;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const reads = await Promise.all(machines.map(async (machine) => {
    try {
      const out = await run(machine.transport, meterArgv(machine.os), timeoutMs);
      // Windows OpenSSH often crashes while exiting (an NTSTATUS such as 0xC0000374) after the remote command finished and printed everything; the parser decides whether the output is whole.
      const crashedOnExit = out.exitCode >= 0xC0000000 && out.exitCode <= 0xCFFFFFFF && out.stdout.trim() !== "";
      if (out.exitCode !== 0 && !crashedOnExit) throw new Error(out.exitCode === 124 || out.exitCode === -1 ? "The meter read timed out." : `The meter read failed (exit ${out.exitCode}).`);
      return { machine, reading: parseMeters(machine.os, out.stdout), error: null };
    } catch (error) { return { machine, reading: null, error: error instanceof Error ? error.message : "The meter read failed." }; }
  }));
  const results: MeterCycleResult[] = [];
  // Rates compare against the previous stored sample, so the writes go in order after the parallel reads.
  for (const read of reads) {
    if (!read.reading) {
      options.log?.(`  meters ${read.machine.id.padEnd(12)}failed  (${read.error})`);
      results.push({ machineId: read.machine.id, ok: false, sample: null, error: read.error });
      continue;
    }
    const sample = recordMeterReading(db, read.machine.id, read.reading, options.now?.() ?? new Date().toISOString());
    results.push({ machineId: read.machine.id, ok: true, sample, error: null });
  }
  return results;
}
