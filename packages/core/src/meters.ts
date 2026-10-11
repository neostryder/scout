import type { Db } from "./db.ts";

export interface MeterDisk { mount: string; usedBytes: number; totalBytes: number }
export interface MeterGpu { name: string; utilPct: number | null; vramUsedBytes: number | null; vramTotalBytes: number | null }
export interface MeterProcess { pid: number; name: string; cpuPct: number | null; memBytes: number | null }
export interface MeterReading {
  cpuPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  disks: MeterDisk[];
  gpus: MeterGpu[];
  /** Cumulative bytes since boot, summed over physical interfaces. The rate comes from two samples. */
  netRxBytes: number | null;
  netTxBytes: number | null;
  processes: MeterProcess[];
}
export interface MeterSample extends MeterReading {
  machineId: string;
  at: string;
  netRxBps: number | null;
  netTxBps: number | null;
}

const DAY_MS = 86_400_000;
const KEPT_PER_MACHINE = 2_000;
const TOP_PER_KIND = 8;

const num = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
};
const round1 = (value: number): number => Math.round(value * 10) / 10;
const clampPct = (value: number): number => Math.min(100, Math.max(0, round1(value)));

/** Split `---SCOUT-NAME---` sections. Text before the first marker is dropped. */
function sections(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of stdout.replaceAll("\r\n", "\n").split("\n")) {
    const marker = /^---SCOUT-([A-Z]+)---$/.exec(line.trim());
    if (marker) { current = []; out.set(marker[1]!, current); continue; }
    current?.push(line);
  }
  return out;
}

function finish(reading: MeterReading): MeterReading {
  if (reading.cpuPct === null && reading.memTotalBytes === null && reading.disks.length === 0) throw new Error("The meter output could not be read.");
  return reading;
}

function topProcesses(rows: MeterProcess[]): MeterProcess[] {
  const byCpu = rows.filter((row) => row.cpuPct !== null).sort((a, b) => b.cpuPct! - a.cpuPct!).slice(0, TOP_PER_KIND);
  const byMem = rows.filter((row) => row.memBytes !== null).sort((a, b) => b.memBytes! - a.memBytes!).slice(0, TOP_PER_KIND);
  const seen = new Set<number>();
  return [...byCpu, ...byMem].filter((row) => !seen.has(row.pid) && seen.add(row.pid));
}

function parseGpuCsv(lines: string[]): MeterGpu[] {
  const mib = (value: string | undefined): number | null => { const n = num(value?.trim()); return n === null ? null : n * 1_048_576; };
  return lines.map((line) => line.split(",")).filter((cells) => cells.length >= 4).map((cells) => {
    const util = num(cells[1]?.trim());
    return { name: cells[0]!.trim(), utilPct: util === null ? null : clampPct(util), vramUsedBytes: mib(cells[2]), vramTotalBytes: mib(cells[3]) };
  });
}

/** One df -Pk table. `total` is used plus available, which matches what df and the Finder show for shared-container volumes. */
function parseDf(lines: string[], os: "macos" | "linux"): MeterDisk[] {
  const seenDevices = new Set<string>();
  const disks: MeterDisk[] = [];
  for (const line of lines) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 6 || !cells[0]!.startsWith("/dev/")) continue;
    const device = cells[0]!;
    const used = num(cells[2]);
    const avail = num(cells[3]);
    const mount = cells.slice(5).join(" ");
    if (used === null || avail === null || seenDevices.has(device)) continue;
    if (os === "macos") {
      if (mount === "/") continue;
      if (mount.startsWith("/System/Volumes/") && mount !== "/System/Volumes/Data") continue;
      if (mount.startsWith("/private/") || mount.startsWith("/Library/") || mount === "/Volumes/Recovery") continue;
    } else if (device.startsWith("/dev/loop") || /^\/(snap|boot\/efi)(\/|$)/.test(mount) || mount.startsWith("/var/lib/docker")) continue;
    seenDevices.add(device);
    disks.push({ mount: mount === "/System/Volumes/Data" ? "/" : mount, usedBytes: used * 1024, totalBytes: (used + avail) * 1024 });
  }
  return disks;
}

export function parseMacMeters(stdout: string): MeterReading {
  const parts = sections(stdout);
  const mem = parts.get("MEM") ?? [];
  const total = num(mem[0]);
  const cores = num(mem[1]) ?? 1;
  const vm = parts.get("VM") ?? [];
  const pageSize = num(/page size of (\d+) bytes/.exec(vm.join("\n"))?.[1]) ?? 16_384;
  const pages = (label: string): number => num(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m").exec(vm.join("\n"))?.[1]) ?? 0;
  const used = vm.length ? (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize : null;
  const idle = num(/([\d.]+)% idle/.exec((parts.get("CPU") ?? []).join("\n"))?.[1]);
  let rx = 0;
  let tx = 0;
  let nets = 0;
  for (const line of parts.get("NET") ?? []) {
    const cells = line.trim().split(/\s+/);
    if (!/^en\d+$/.test(cells[0] ?? "") || !(cells[2] ?? "").startsWith("<Link#")) continue;
    const received = num(cells.at(-5));
    const sent = num(cells.at(-2));
    if (received === null || sent === null) continue;
    rx += received; tx += sent; nets++;
  }
  const processes: MeterProcess[] = [];
  for (const line of parts.get("PS") ?? []) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const name = match[4]!.trim().split("/").at(-1)!;
    processes.push({ pid: Number(match[1]), name, cpuPct: clampPct(Number(match[2]) / Math.max(1, cores)), memBytes: Number(match[3]) * 1024 });
  }
  return finish({
    cpuPct: idle === null ? null : clampPct(100 - idle),
    memUsedBytes: used, memTotalBytes: total,
    disks: parseDf(parts.get("DF") ?? [], "macos"),
    gpus: parseGpuCsv(parts.get("GPU") ?? []),
    netRxBytes: nets ? rx : null, netTxBytes: nets ? tx : null,
    processes: topProcesses(processes),
  });
}

export function parseLinuxMeters(stdout: string): MeterReading {
  const parts = sections(stdout);
  const meminfo = (parts.get("MEMINFO") ?? []).join("\n");
  const kb = (label: string): number | null => num(new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1]);
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  const stat = (parts.get("STAT") ?? []).map((line) => line.trim().split(/\s+/).slice(1).map(Number)).filter((row) => row.length >= 4 && row.every(Number.isFinite));
  let cpu: number | null = null;
  if (stat.length >= 2) {
    const [a, b] = [stat[0]!, stat[1]!];
    const busy = (row: number[]): number => row.reduce((sum, value) => sum + value, 0) - (row[3] ?? 0) - (row[4] ?? 0);
    const all = (row: number[]): number => row.reduce((sum, value) => sum + value, 0);
    const span = all(b) - all(a);
    if (span > 0) cpu = clampPct(((busy(b) - busy(a)) / span) * 100);
  }
  let rx = 0;
  let tx = 0;
  let nets = 0;
  for (const line of parts.get("NET") ?? []) {
    const match = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!match || /^(lo|docker\d*|veth.*|br-.*|virbr\d*|tun\d*|tap\d*)$/.test(match[1]!)) continue;
    const cells = match[2]!.trim().split(/\s+/).map(Number);
    if (cells.length < 9 || !Number.isFinite(cells[0]) || !Number.isFinite(cells[8])) continue;
    rx += cells[0]!; tx += cells[8]!; nets++;
  }
  const processes: MeterProcess[] = [];
  for (const line of parts.get("PS") ?? []) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), name: match[3]!.trim(), cpuPct: null, memBytes: Number(match[2]) * 1024 });
  }
  return finish({
    cpuPct: cpu,
    memUsedBytes: total !== null && available !== null ? (total - available) * 1024 : null,
    memTotalBytes: total === null ? null : total * 1024,
    disks: parseDf(parts.get("DF") ?? [], "linux"),
    gpus: parseGpuCsv(parts.get("GPU") ?? []),
    netRxBytes: nets ? rx : null, netTxBytes: nets ? tx : null,
    processes: topProcesses(processes),
  });
}

interface WindowsPayload {
  cpu?: unknown; cores?: unknown; memTotal?: unknown; memFree?: unknown; rx?: unknown; tx?: unknown;
  disks?: { mount?: unknown; total?: unknown; free?: unknown }[] | { mount?: unknown; total?: unknown; free?: unknown };
  gpu?: string | string[];
  procs?: { id?: unknown; name?: unknown; cpu?: unknown; mem?: unknown }[] | { id?: unknown; name?: unknown; cpu?: unknown; mem?: unknown };
}

/** PowerShell's ConvertTo-Json prints a one-item array as a bare object, so each list accepts either shape. */
const list = <T>(value: T[] | T | undefined): T[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

export function parseWindowsMeters(stdout: string): MeterReading {
  let payload: WindowsPayload;
  try { payload = JSON.parse(stdout.trim()) as WindowsPayload; } catch { throw new Error("The meter output could not be read."); }
  if (typeof payload !== "object" || payload === null) throw new Error("The meter output could not be read.");
  const cores = Math.max(1, num(payload.cores) ?? 1);
  const total = num(payload.memTotal);
  const free = num(payload.memFree);
  const cpu = num(payload.cpu);
  const disks: MeterDisk[] = [];
  for (const disk of list(payload.disks)) {
    const size = num(disk.total);
    const left = num(disk.free);
    if (typeof disk.mount !== "string" || size === null || left === null || size <= 0) continue;
    disks.push({ mount: disk.mount, usedBytes: Math.max(0, size - left), totalBytes: size });
  }
  const processes: MeterProcess[] = [];
  for (const proc of list(payload.procs)) {
    const pid = num(proc.id);
    if (pid === null || pid === 0 || typeof proc.name !== "string") continue;
    const share = num(proc.cpu);
    processes.push({ pid, name: proc.name.replace(/#\d+$/, ""), cpuPct: share === null ? null : clampPct(share / cores), memBytes: num(proc.mem) });
  }
  return finish({
    cpuPct: cpu === null ? null : clampPct(cpu),
    memUsedBytes: total !== null && free !== null ? Math.max(0, total - free) : null,
    memTotalBytes: total,
    disks,
    gpus: parseGpuCsv(list(payload.gpu).filter((line): line is string => typeof line === "string")),
    netRxBytes: num(payload.rx), netTxBytes: num(payload.tx),
    processes: topProcesses(processes),
  });
}

export function parseMeters(os: "windows" | "macos" | "linux", stdout: string): MeterReading {
  return os === "windows" ? parseWindowsMeters(stdout) : os === "macos" ? parseMacMeters(stdout) : parseLinuxMeters(stdout);
}

function rate(now: number | null, before: number | null, seconds: number): number | null {
  if (now === null || before === null || seconds <= 0 || now < before) return null;
  return Math.round((now - before) / seconds);
}

function decode(row: { machine_id: string; at: string; data: string }): MeterSample {
  return { machineId: row.machine_id, at: row.at, ...(JSON.parse(row.data) as Omit<MeterSample, "machineId" | "at">) };
}

/** Store a reading and turn the cumulative network counters into rates against the machine's previous sample. A reset counter (a reboot) gives no rate for that sample. */
export function recordMeterReading(db: Db, machineId: string, reading: MeterReading, at: string): MeterSample {
  const previous = db.prepare("SELECT machine_id, at, data FROM meter_samples WHERE machine_id = ? ORDER BY at DESC, id DESC LIMIT 1").get(machineId) as { machine_id: string; at: string; data: string } | undefined;
  const before = previous ? decode(previous) : null;
  const seconds = before ? (Date.parse(at) - Date.parse(before.at)) / 1000 : 0;
  const sample: MeterSample = { machineId, at, ...reading, netRxBps: rate(reading.netRxBytes, before?.netRxBytes ?? null, seconds), netTxBps: rate(reading.netTxBytes, before?.netTxBytes ?? null, seconds) };
  const { machineId: _machine, at: _at, ...data } = sample;
  db.prepare("INSERT INTO meter_samples (machine_id, at, data) VALUES (?, ?, ?)").run(machineId, at, JSON.stringify(data));
  db.prepare("DELETE FROM meter_samples WHERE machine_id = ? AND at < ?").run(machineId, new Date(Date.parse(at) - 7 * DAY_MS).toISOString());
  db.prepare("DELETE FROM meter_samples WHERE machine_id = ? AND id NOT IN (SELECT id FROM meter_samples WHERE machine_id = ? ORDER BY at DESC, id DESC LIMIT ?)").run(machineId, machineId, KEPT_PER_MACHINE);
  return sample;
}

/** The newest sample for every machine that has one. */
export function latestMeters(db: Db): MeterSample[] {
  const rows = db.prepare("SELECT machine_id, at, data FROM meter_samples WHERE id IN (SELECT MAX(id) FROM meter_samples GROUP BY machine_id) ORDER BY machine_id").all() as { machine_id: string; at: string; data: string }[];
  return rows.map(decode);
}

/** Oldest first, for a sparkline. */
export function meterHistory(db: Db, machineId: string, sinceIso: string, limit = 360): MeterSample[] {
  const rows = db.prepare("SELECT machine_id, at, data FROM (SELECT id, machine_id, at, data FROM meter_samples WHERE machine_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?) ORDER BY at ASC, id ASC").all(machineId, sinceIso, limit) as { machine_id: string; at: string; data: string }[];
  return rows.map(decode);
}

/** A process with the name and kind of the running service or open listener in the catalog that owns it, when there is one. */
export interface ResourceProcess extends MeterProcess { label?: string; kind?: "service" | "listener" }
export interface ResourceMachine {
  machineId: string;
  name: string;
  os: string;
  at: string;
  ageSeconds: number;
  cpuPct: number | null;
  mem: { usedBytes: number; totalBytes: number; pct: number } | null;
  disks: (MeterDisk & { pct: number })[];
  gpus: (MeterGpu & { vramPct: number | null })[];
  net: { rxBps: number | null; txBps: number | null };
  top: { cpu: ResourceProcess[]; mem: ResourceProcess[] };
  /** Oldest first, about the last half hour, thinned to at most 60 points. */
  series: { at: string; cpuPct: number | null; memPct: number | null; rxBps: number | null; txBps: number | null }[];
}

const pct = (used: number, total: number): number => total > 0 ? clampPct((used / total) * 100) : 0;
const SERIES_MINUTES = 30;
const SERIES_POINTS = 60;

function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.min(rows.length - 1, Math.floor((i + 1) * step) - 1)]!);
}

/** Names each process after the running service or open listener in the catalog that owns its pid; a process the catalog does not know keeps its own name. */
function named(db: Db, machineId: string, processes: MeterProcess[]): ResourceProcess[] {
  const service = db.prepare("SELECT COALESCE(display_name, name) AS label FROM services WHERE machine_id = ? AND pid = ? AND state = 'running' AND gone_at IS NULL ORDER BY id LIMIT 1");
  const listener = db.prepare("SELECT port, script_path, process_name FROM listeners WHERE machine_id = ? AND pid = ? AND gone_at IS NULL ORDER BY port LIMIT 1");
  return processes.map((process) => {
    const svc = service.get(machineId, process.pid) as { label: string } | undefined;
    if (svc) return { ...process, label: svc.label, kind: "service" };
    const open = listener.get(machineId, process.pid) as { port: number; script_path: string | null; process_name: string | null } | undefined;
    if (open) return { ...process, label: `${open.script_path?.split(/[\/]/).pop() || open.process_name || process.name} on port ${open.port}`, kind: "listener" };
    return process;
  });
}

export function resourcesResponse(db: Db, now = new Date().toISOString()): { machines: ResourceMachine[] } {
  const names = new Map((db.prepare("SELECT id, name, os FROM machines").all() as { id: string; name: string; os: string }[]).map((row) => [row.id, row]));
  const since = new Date(Date.parse(now) - SERIES_MINUTES * 60_000).toISOString();
  const machines = latestMeters(db).map((sample): ResourceMachine => {
    const info = names.get(sample.machineId);
    const processes = sample.processes;
    return {
      machineId: sample.machineId,
      name: info?.name ?? sample.machineId,
      os: info?.os ?? "unknown",
      at: sample.at,
      ageSeconds: Math.max(0, Math.round((Date.parse(now) - Date.parse(sample.at)) / 1000)),
      cpuPct: sample.cpuPct,
      mem: sample.memUsedBytes !== null && sample.memTotalBytes !== null ? { usedBytes: sample.memUsedBytes, totalBytes: sample.memTotalBytes, pct: pct(sample.memUsedBytes, sample.memTotalBytes) } : null,
      disks: sample.disks.map((disk) => ({ ...disk, pct: pct(disk.usedBytes, disk.totalBytes) })),
      gpus: sample.gpus.map((gpu) => ({ ...gpu, vramPct: gpu.vramUsedBytes !== null && gpu.vramTotalBytes !== null ? pct(gpu.vramUsedBytes, gpu.vramTotalBytes) : null })),
      net: { rxBps: sample.netRxBps, txBps: sample.netTxBps },
      top: {
        cpu: named(db, sample.machineId, processes.filter((p) => p.cpuPct !== null).sort((a, b) => b.cpuPct! - a.cpuPct!).slice(0, 5)),
        mem: named(db, sample.machineId, processes.filter((p) => p.memBytes !== null).sort((a, b) => b.memBytes! - a.memBytes!).slice(0, 5)),
      },
      series: thin(meterHistory(db, sample.machineId, since), SERIES_POINTS).map((row) => ({
        at: row.at, cpuPct: row.cpuPct, memPct: row.memUsedBytes !== null && row.memTotalBytes !== null ? pct(row.memUsedBytes, row.memTotalBytes) : null, rxBps: row.netRxBps, txBps: row.netTxBps,
      })),
    };
  });
  return { machines: machines.sort((a, b) => a.name.localeCompare(b.name)) };
}
