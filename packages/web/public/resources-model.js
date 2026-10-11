// Pure helpers for the Resources view: text for numbers, the tone of a meter, the rows of one machine, and the line of a sparkline.

export const WARN_PCT = 70;
export const DANGER_PCT = 85;
/** A reading older than this many seconds is shown as stale, not as current. */
export const STALE_SECONDS = 150;

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytesText(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "None";
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function rateText(bytesPerSecond) {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return "None";
  return `${bytesText(bytesPerSecond)}/s`;
}

export function pctText(pct) { return pct === null || pct === undefined || !Number.isFinite(pct) ? "None" : `${Math.round(pct)}%`; }

export function meterTone(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "quiet";
  return pct >= DANGER_PCT ? "danger" : pct >= WARN_PCT ? "warn" : "ok";
}

/** Tone words for readers who cannot rely on color: the number is always shown, and this is the second cue. */
export function toneWord(tone) { return tone === "danger" ? "Very high" : tone === "warn" ? "High" : tone === "ok" ? "Normal" : "No reading"; }

export function ageText(seconds) {
  if (!Number.isFinite(seconds)) return "No reading yet";
  if (seconds < 5) return "Updated just now";
  if (seconds < 90) return `Updated ${Math.round(seconds)} s ago`;
  if (seconds < 5400) return `Updated ${Math.round(seconds / 60)} min ago`;
  return `Updated ${Math.round(seconds / 3600)} h ago`;
}

export function isStale(machine) { return !Number.isFinite(machine?.ageSeconds) || machine.ageSeconds > STALE_SECONDS; }

/** The points of one polyline, oldest first, scaled to the box. A gap in the readings breaks the line into separate segments. */
export function sparkSegments(values, width = 96, height = 28, max = 100) {
  const segments = [];
  let current = [];
  values.forEach((value, index) => {
    if (value === null || value === undefined || !Number.isFinite(value)) { if (current.length) segments.push(current.join(" ")); current = []; return; }
    const x = values.length < 2 ? width : index * width / (values.length - 1);
    const y = height - Math.min(1, Math.max(0, value / max)) * (height - 2) - 1;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  return segments;
}

/** A network sparkline scales to its own busiest moment, since a rate has no natural ceiling. */
export function netMax(series) {
  return Math.max(1, ...series.flatMap((point) => [point.rxBps ?? 0, point.txBps ?? 0]));
}

/**
 * The meter rows of one machine, in the order the rail shows them: processor, memory, each disk, each graphics card, network.
 * A row has a stable key, a label, a detail line, a percentage (null for network), a tone, the text of the number, and a series for its sparkline.
 */
export function meterRows(machine) {
  const rows = [];
  const series = machine.series ?? [];
  rows.push({ key: "cpu", label: "Processor", detail: "All cores", pct: machine.cpuPct, tone: meterTone(machine.cpuPct), value: pctText(machine.cpuPct), spark: series.map((p) => p.cpuPct), sparkMax: 100, top: "cpu" });
  if (machine.mem) rows.push({ key: "mem", label: "Memory", detail: `${bytesText(machine.mem.usedBytes)} of ${bytesText(machine.mem.totalBytes)}`, pct: machine.mem.pct, tone: meterTone(machine.mem.pct), value: pctText(machine.mem.pct), spark: series.map((p) => p.memPct), sparkMax: 100, top: "mem" });
  for (const disk of machine.disks ?? []) rows.push({ key: `disk:${disk.mount}`, label: `Disk ${disk.mount}`, detail: `${bytesText(disk.usedBytes)} of ${bytesText(disk.totalBytes)}`, pct: disk.pct, tone: meterTone(disk.pct), value: pctText(disk.pct), spark: [], sparkMax: 100, top: null });
  (machine.gpus ?? []).forEach((gpu, index) => {
    const suffix = (machine.gpus.length > 1 ? ` ${index + 1}` : "");
    rows.push({ key: `vram:${index}`, label: `Video memory${suffix}`, detail: gpu.vramUsedBytes === null ? gpu.name : `${bytesText(gpu.vramUsedBytes)} of ${bytesText(gpu.vramTotalBytes)}, ${gpu.name}`, pct: gpu.vramPct, tone: meterTone(gpu.vramPct), value: pctText(gpu.vramPct), spark: [], sparkMax: 100, top: null });
    if (gpu.utilPct !== null) rows.push({ key: `gpu:${index}`, label: `Graphics${suffix}`, detail: gpu.name, pct: gpu.utilPct, tone: meterTone(gpu.utilPct), value: pctText(gpu.utilPct), spark: [], sparkMax: 100, top: null });
  });
  const { rxBps, txBps } = machine.net ?? { rxBps: null, txBps: null };
  rows.push({ key: "net", label: "Network", detail: `Down ${rateText(rxBps)}, up ${rateText(txBps)}`, pct: null, tone: "quiet", value: rxBps === null && txBps === null ? "None" : rateText((rxBps ?? 0) + (txBps ?? 0)), spark: series.map((p) => p.rxBps === null && p.txBps === null ? null : (p.rxBps ?? 0) + (p.txBps ?? 0)), sparkMax: netMax(series.map((p) => ({ rxBps: (p.rxBps ?? 0) + (p.txBps ?? 0), txBps: 0 }))), top: null });
  return rows;
}

/** The biggest users for a row that has a list, as display rows. Processes without a catalog name show the process name, with the kind blank. */
export function topRows(machine, kind) {
  const list = kind === "mem" ? machine.top?.mem : kind === "cpu" ? machine.top?.cpu : null;
  return (list ?? []).map((process) => ({
    name: process.label || process.name,
    kind: process.kind || "",
    value: kind === "mem" ? bytesText(process.memBytes) : pctText(process.cpuPct),
    pid: process.pid,
  }));
}

/** One summary line for a machine island or the tray: the numbers that matter at a glance. */
export function summaryText(machine) {
  const parts = [];
  if (machine.cpuPct !== null && machine.cpuPct !== undefined) parts.push(`Processor ${pctText(machine.cpuPct)}`);
  if (machine.mem) parts.push(`Memory ${pctText(machine.mem.pct)}`);
  const vram = (machine.gpus ?? []).find((gpu) => gpu.vramPct !== null);
  if (vram) parts.push(`Video memory ${pctText(vram.vramPct)}`);
  return parts.join(", ") || "No reading yet";
}

/** The tone of a whole machine is its worst meter, so one glance finds the machine that needs a look. */
export function machineTone(machine) {
  const order = ["quiet", "ok", "warn", "danger"];
  return meterRows(machine).filter((row) => row.pct !== null).reduce((worst, row) => order.indexOf(row.tone) > order.indexOf(worst) ? row.tone : worst, "quiet");
}

/** Polling interval for the view: the hub's stated cadence, never faster than 5 s. */
export function pollMs(intervalSeconds) { return Math.max(5, Number.isFinite(intervalSeconds) ? intervalSeconds : 10) * 1000; }
