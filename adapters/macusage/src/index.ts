import type { Probe, ProbeContext, ProbeOutputs, UsageAdapter, UsageResult, UsageSignalRecord } from "@scout/core";

// Read-only usage signals from macOS. Spotlight reports when an app was last used and how often; the process list
// reports which executables are running now. Both scripts are byte-identical to tools/probes/macos/*.sh.

const SPOTLIGHT_SH =
  "for a in /Applications/*.app /Applications/*/*.app \"$HOME\"/Applications/*.app; do\n  [ -d \"$a\" ] || continue\n  printf '%s\\t%s\\t%s\\n' \"$a\" \"$(mdls -raw -name kMDItemLastUsedDate \"$a\" 2>/dev/null)\" \"$(mdls -raw -name kMDItemUseCount \"$a\" 2>/dev/null)\"\ndone\n";

const PS_SH = "ps -axo comm=\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** Spotlight prints "2026-09-23 19:29:52 +0000"; turn it into the ISO form. Anything else, including "(null)", is null. */
function isoDate(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0000$/.test(raw)) {
    return `${raw.slice(0, 10)}T${raw.slice(11, 19)}Z`;
  }
  return null;
}

const spotlightAdapter: UsageAdapter = {
  origin: "spotlight",
  os: ["macos"],
  probes(_ctx: ProbeContext): Probe[] {
    return [{ id: "list", argv: ["/bin/sh", "-c", SPOTLIGHT_SH] }];
  },
  parse(outputs: ProbeOutputs): UsageResult {
    const probe = outputs["list"];
    if (!probe) return { origin: "spotlight", status: "failed", signals: [], message: "probe output missing" };
    if (probe.exitCode !== 0 && probe.stdout.trim() === "") {
      return { origin: "spotlight", status: "skipped", signals: [], message: firstLine(probe.stderr) };
    }
    const signals: UsageSignalRecord[] = [];
    let rows = 0;
    let malformed = 0;
    let allNull = true;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const fields = line.split("\t");
      if (fields.length !== 3) {
        malformed++;
        continue;
      }
      const path = fields[0] ?? "";
      const dateRaw = fields[1] ?? "";
      const countRaw = fields[2] ?? "";
      rows++;
      if (dateRaw !== "(null)" || countRaw !== "(null)") allNull = false;
      signals.push({ match: { path }, kind: "last_used", value: isoDate(dateRaw), available: true });
      signals.push({ match: { path }, kind: "use_count", value: countRaw === "(null)" ? null : countRaw, available: true });
    }
    // No row reports a date or a count: Spotlight is not tracking use on this machine, so absence proves nothing.
    const noUsage = rows > 0 && allNull;
    if (noUsage) {
      for (const signal of signals) {
        signal.value = null;
        signal.available = false;
      }
    }
    const messages: string[] = [];
    if (noUsage) messages.push("Spotlight reports no usage data");
    if (malformed > 0) messages.push(`skipped ${malformed} malformed line(s)`);
    if (messages.length > 0) {
      return { origin: "spotlight", status: "partial", signals, message: messages.join("; ") };
    }
    return { origin: "spotlight", status: "ok", signals };
  },
};

const processesAdapter: UsageAdapter = {
  origin: "processes",
  os: ["macos"],
  probes(_ctx: ProbeContext): Probe[] {
    return [{ id: "list", argv: ["/bin/sh", "-c", PS_SH] }];
  },
  parse(outputs: ProbeOutputs): UsageResult {
    const probe = outputs["list"];
    if (!probe) return { origin: "processes", status: "failed", signals: [], message: "probe output missing" };
    if (probe.exitCode !== 0) {
      return { origin: "processes", status: "skipped", signals: [], message: firstLine(probe.stderr) };
    }
    const seen = new Set<string>();
    const signals: UsageSignalRecord[] = [];
    for (const line of probe.stdout.split("\n")) {
      if (!line.startsWith("/")) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      signals.push({ match: { path: line }, kind: "running", value: "1", available: true });
    }
    return { origin: "processes", status: "ok", signals, completeFor: ["running"] };
  },
};

export { processesAdapter, spotlightAdapter };
