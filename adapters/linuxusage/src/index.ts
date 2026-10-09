import type { Probe, ProbeContext, ProbeOutputs, UsageAdapter, UsageResult, UsageSignalRecord } from "@scout/core";

const PS_SH = "ps -eo comm= 2>/dev/null";
// stat -c needs literal tabs. The mtime column prevents install timestamps from counting as use.
const ATIME_SH =
  "command -v find >/dev/null 2>&1 || { printf '%s\\n' 'find is not installed' >&2; exit 127; }\n" +
  "command -v stat >/dev/null 2>&1 || { printf '%s\\n' 'stat is not installed' >&2; exit 127; }\n" +
  "status=0\nfor root in /usr/bin /usr/sbin /usr/local/bin /bin /sbin /opt/*/bin; do\n" +
  "  [ -d \"$root\" ] || continue\n" +
  "  find -H \"$root\" \\( -type f -o -type l \\) -exec stat -L -c '%n\t%X\t%Y' {} + || status=1\n" +
  "done\nexit \"$status\"\n";
const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
const result = (origin: string, status: UsageResult["status"], signals: UsageSignalRecord[] = [], message?: string): UsageResult => ({ origin, status, signals, ...(message === undefined ? {} : { message }) });

function stopped(outputs: ProbeOutputs): string | undefined {
  for (const output of Object.values(outputs)) {
    const message = `${output.stderr}\n${output.stdout}`.split("\n").find((line) => /\b(?:guest|distro|distribution|sandbox)\b.*\b(?:not running|stopped)\b/i.test(line));
    if (message) return message.trim();
  }
  return undefined;
}

export const processesAdapter: UsageAdapter = {
  origin: "linux-processes",
  os: ["linux"],
  probes(_ctx: ProbeContext): Probe[] {
    return [{ id: "list", argv: ["/bin/sh", "-c", PS_SH] }];
  },
  parse(outputs: ProbeOutputs): UsageResult {
    const stoppedMessage = stopped(outputs);
    if (stoppedMessage) return result("linux-processes", "skipped", [], stoppedMessage);
    const probe = outputs["list"];
    if (!probe) return result("linux-processes", "failed", [], "probe output missing: list");
    if (probe.exitCode !== 0) return result("linux-processes", "skipped", [], firstLine(probe.stderr) || `ps did not run (exit ${probe.exitCode})`);
    const seen = new Set<string>();
    const signals: UsageSignalRecord[] = [];
    let malformed = 0;
    for (const line of probe.stdout.split("\n")) {
      const name = line.trim();
      if (name === "" || /^\[.*\]$/.test(name) || name === "ps" || name === "sh") continue;
      if (/[\t\r\x00-\x1f/]/.test(name)) {
        malformed++;
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      // Core name matching is pending; a comm value is not an executable path.
      const match = { name } as unknown as UsageSignalRecord["match"];
      signals.push({ match, kind: "running", value: "1", available: true });
    }
    // Name-only output cannot prove that every located install is absent from the process list.
    return malformed > 0
      ? result("linux-processes", "partial", signals, `skipped ${malformed} malformed line(s)`)
      : result("linux-processes", "ok", signals);
  },
};

function epoch(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : undefined;
}

function mountAvailability(outputs: ProbeOutputs): string | undefined {
  const probe = outputs["mounts"];
  if (!probe || probe.exitCode !== 0) return "root mount options are unreadable";
  const roots = probe.stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((fields) => fields[1] === "/");
  const root = roots[0];
  if (roots.length !== 1 || !root || root.length !== 6 || !root[3] || !/^\d+$/.test(root[4]!) || !/^\d+$/.test(root[5]!)) return "root mount options are unreadable";
  return root[3].split(",").includes("noatime") ? "root filesystem uses noatime" : undefined;
}

export const atimeAdapter: UsageAdapter = {
  origin: "linux-atime",
  os: ["linux"],
  probes(_ctx: ProbeContext): Probe[] {
    return [{ id: "list", argv: ["/bin/sh", "-c", ATIME_SH] }, { id: "mounts", argv: ["/bin/sh", "-c", "cat /proc/mounts"] }];
  },
  parse(outputs: ProbeOutputs): UsageResult {
    const stoppedMessage = stopped(outputs);
    if (stoppedMessage) return result("linux-atime", "skipped", [], stoppedMessage);
    const probe = outputs["list"];
    if (!probe) return result("linux-atime", "failed", [], "probe output missing: list");
    if (probe.exitCode === 127 || (probe.exitCode !== 0 && probe.stdout.trim() === "")) return result("linux-atime", "skipped", [], firstLine(probe.stderr) || `atime probe did not run (exit ${probe.exitCode})`);
    const unavailable = mountAvailability(outputs);
    const signals: UsageSignalRecord[] = [];
    const seen = new Set<string>();
    let malformed = 0;
    let older = 0;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const fields = line.replace(/\r$/, "").split("\t");
      const path = fields[0] ?? "";
      const atime = epoch(fields[1] ?? "");
      const mtime = epoch(fields[2] ?? "");
      if (fields.length !== 3 || !path.startsWith("/") || /[\x00-\x1f]/.test(path) || atime === undefined || mtime === undefined) {
        malformed++;
        continue;
      }
      if (seen.has(path)) continue;
      seen.add(path);
      // noatime and unreadable options prove nothing. relatime can delay the reported access time.
      const available = unavailable === undefined && atime >= mtime;
      // Equality means no access since writing; an older atime cannot establish that absence.
      const value = available && atime > mtime ? new Date(atime * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
      if (unavailable === undefined && atime < mtime) older++;
      signals.push({ match: { path }, kind: "last_used", value, available });
    }
    const messages: string[] = [];
    if (unavailable) messages.push(unavailable);
    if (probe.exitCode !== 0) messages.push(firstLine(probe.stderr) || `atime probe exited ${probe.exitCode}`);
    if (malformed > 0) messages.push(`skipped ${malformed} malformed line(s)`);
    if (older > 0) messages.push(`${older} access time(s) precede modification time`);
    return messages.length > 0 ? result("linux-atime", "partial", signals, messages.join("; ")) : result("linux-atime", "ok", signals);
  },
};
