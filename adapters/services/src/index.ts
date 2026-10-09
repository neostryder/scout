import type { ProbeOutput, ProbeOutputs, ServiceAdapter, ServiceDomain, ServiceFact, ServiceResult, ServiceStartMode, ServiceState } from "@scout/core";
import { MAC_LAUNCHD_STATE_SCRIPT, WINDOWS_SERVICE_STATE_SCRIPT, WINDOWS_TASKS_SCRIPT } from "./probes.ts";

const result = (origin: string, status: ServiceResult["status"], facts: ServiceFact[] = [], message?: string): ServiceResult => ({ origin, status, facts, ...(message === undefined ? {} : { message }) });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const EXECUTABLE = /\.(?:exe|com|sys|dll)\b/i;

function unavailable(outputs: ProbeOutputs, id: string, origin: string): ServiceResult | null {
  const probe = outputs[id];
  if (!probe) return result(origin, "failed", [], "probe output missing");
  if (probe.exitCode === 127 || probe.exitCode === 9009) return result(origin, "skipped", [], "service tool did not run");
  if (probe.exitCode !== 0 && !probe.stdout.trim()) return result(origin, "failed", [], "service probe did not run");
  return null;
}

function finish(origin: string, probe: ProbeOutput, facts: ServiceFact[], malformed: boolean): ServiceResult {
  const partial = malformed || probe.exitCode !== 0;
  return result(origin, partial ? facts.length ? "partial" : "failed" : "ok", facts, partial ? "some service records could not be read" : undefined);
}

function optionalText(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function pidOf(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value === 0 ? null : value;
}

// PathName carries arguments after the executable. The catalog stores the executable only.
function windowsProgram(raw: string | null, source: "service" | "task"): string | null {
  if (raw == null) return null;
  let text = raw.trim();
  if (text === "") return null;
  if (text.startsWith("\"")) {
    const end = text.indexOf("\"", 1);
    text = (end === -1 ? text.slice(1) : text.slice(1, end)).trim();
  } else if (source === "service") {
    const match = EXECUTABLE.exec(text);
    if (match) text = text.slice(0, match.index + match[0].length);
    else if (/\s/.test(text)) text = text.split(/\s+/)[0] ?? text;
  }
  text = text.trim();
  if (text === "") return null;
  return text.replaceAll("\\", "/").replace(/((?:[A-Za-z]:)?\/Users\/)[^/]+/gi, "$1USER");
}

function mapStartMode(value: string | null): ServiceStartMode | null {
  switch (value?.toLowerCase()) {
    case "auto": return "auto";
    case "manual": return "manual";
    case "disabled": return "disabled";
    case "boot": return "boot";
    default: return null;
  }
}

function serviceState(state: string, startMode: ServiceStartMode | null): ServiceState {
  const key = state.toLowerCase();
  if (key === "running") return "running";
  if (startMode === "disabled" || key === "disabled") return "disabled";
  if (key === "stopped") return "stopped";
  return "other";
}

function jsonRows(stdout: string): { rows: unknown[] } | { error: string } {
  let doc: unknown;
  try { doc = stdout.trim() ? JSON.parse(stdout) : []; }
  catch { return { error: "service output is not valid JSON" }; }
  if (Array.isArray(doc)) return { rows: doc };
  if (object(doc)) return { rows: [doc] };
  return { error: "service records could not be read" };
}

function collect(origin: string, probe: ProbeOutput, read: (row: unknown) => ServiceFact | null): ServiceResult {
  const parsed = jsonRows(probe.stdout);
  if ("error" in parsed) return result(origin, "failed", [], parsed.error);
  const facts = new Map<string, ServiceFact>();
  let malformed = false;
  for (const row of parsed.rows) {
    const fact = read(row);
    if (!fact) { malformed = true; continue; }
    const key = JSON.stringify([fact.kind, fact.domain, fact.name]);
    const previous = facts.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) malformed = true;
    facts.set(key, fact);
  }
  return finish(origin, probe, [...facts.values()], malformed);
}

function windowsServiceFact(row: unknown): ServiceFact | null {
  if (!object(row) || typeof row["Name"] !== "string" || row["Name"].trim() === "" || typeof row["State"] !== "string" || row["State"].trim() === "") return null;
  const displayName = optionalText(row["DisplayName"]);
  const startText = optionalText(row["StartMode"]);
  const runAs = optionalText(row["StartName"]);
  const pid = pidOf(row["ProcessId"]);
  const pathName = row["PathName"];
  if (displayName === undefined || startText === undefined || runAs === undefined || pid === undefined) return null;
  if (!(pathName == null || typeof pathName === "string")) return null;
  const startMode = mapStartMode(startText);
  const state = serviceState(row["State"], startMode);
  return {
    kind: "windows-service",
    name: row["Name"].trim(),
    displayName,
    domain: "system",
    program: windowsProgram(pathName ?? null, "service"),
    state,
    startMode,
    enabled: startMode === null ? null : startMode !== "disabled",
    pid,
    runAs,
    triggers: null,
    lastRun: null,
    lastResult: null,
  };
}

export const windowsServicesAdapter: ServiceAdapter = {
  origin: "win-services",
  os: ["windows"],
  probes() {
    return [{ id: "services", argv: ["pwsh", "-NoProfile", "-Command", WINDOWS_SERVICE_STATE_SCRIPT] }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "services", "win-services");
    if (missing) return missing;
    return collect("win-services", outputs["services"]!, windowsServiceFact);
  },
};

function taskState(state: string): { state: ServiceState; enabled: boolean | null } {
  // Ready is waiting, not running. The state enum has no idle value.
  switch (state.toLowerCase()) {
    case "running": return { state: "running", enabled: true };
    case "ready": return { state: "stopped", enabled: true };
    case "disabled": return { state: "disabled", enabled: false };
    case "queued": return { state: "other", enabled: true };
    default: return { state: "other", enabled: null };
  }
}

function taskFact(row: unknown): ServiceFact | null {
  if (!object(row) || typeof row["TaskName"] !== "string" || row["TaskName"].trim() === "" || typeof row["TaskPath"] !== "string" || typeof row["State"] !== "string" || row["State"].trim() === "") return null;
  if (!Array.isArray(row["Triggers"]) || row["Triggers"].some((item) => typeof item !== "string")) return null;
  const runAs = optionalText(row["RunAs"]);
  const execute = row["Execute"];
  if (runAs === undefined || !(execute == null || typeof execute === "string")) return null;
  if (!(row["LastRun"] == null || typeof row["LastRun"] === "string")) return null;
  if (!(row["LastResult"] == null || typeof row["LastResult"] === "string" || (typeof row["LastResult"] === "number" && Number.isFinite(row["LastResult"])))) return null;
  const taskName = row["TaskName"].trim();
  const taskPath = row["TaskPath"];
  const name = taskPath === "" || taskPath.endsWith("\\") || taskPath.endsWith("/") ? `${taskPath}${taskName}` : `${taskPath}\\${taskName}`;
  const mapped = taskState(row["State"]);
  const lastRun = typeof row["LastRun"] === "string" && row["LastRun"].trim() !== "" ? row["LastRun"] : null;
  return {
    kind: "scheduled-task",
    name,
    displayName: taskName,
    domain: "system",
    program: windowsProgram(execute ?? null, "task"),
    state: mapped.state,
    startMode: null,
    enabled: mapped.enabled,
    pid: null,
    runAs,
    triggers: row["Triggers"],
    lastRun,
    lastResult: row["LastResult"] == null ? null : String(row["LastResult"]),
  };
}

export const windowsTasksAdapter: ServiceAdapter = {
  origin: "win-tasks",
  os: ["windows"],
  probes() {
    return [{ id: "tasks", argv: ["pwsh", "-NoProfile", "-Command", WINDOWS_TASKS_SCRIPT] }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "tasks", "win-tasks");
    if (missing) return missing;
    return collect("win-tasks", outputs["tasks"]!, taskFact);
  },
};

const LAUNCHD_MARKERS = ["---SCOUT-SYSTEM---", "---SCOUT-GUI---", "---SCOUT-DISABLED-SYSTEM---", "---SCOUT-DISABLED-GUI---"] as const;

function launchdSections(stdout: string): { sections: Record<string, string>; complete: boolean } {
  const lines = stdout.split(/\r?\n/);
  const at = new Map<string, number>();
  lines.forEach((line, index) => {
    const name = line.trim();
    if ((LAUNCHD_MARKERS as readonly string[]).includes(name) && !at.has(name)) at.set(name, index);
  });
  const sections: Record<string, string> = {};
  LAUNCHD_MARKERS.forEach((marker, index) => {
    const start = at.get(marker);
    if (start === undefined) return;
    let end = lines.length;
    for (let next = index + 1; next < LAUNCHD_MARKERS.length; next++) {
      const atNext = at.get(LAUNCHD_MARKERS[next]!);
      if (atNext !== undefined) { end = atNext; break; }
    }
    sections[marker] = lines.slice(start + 1, end).join("\n");
  });
  const complete = LAUNCHD_MARKERS.every((marker, index) => {
    const here = at.get(marker);
    const prev = index === 0 ? -1 : at.get(LAUNCHD_MARKERS[index - 1]!);
    return here !== undefined && prev !== undefined && here > prev;
  });
  return { sections, complete };
}

function launchdServiceLine(line: string): { pid: number; label: string } | null {
  const tab = line.lastIndexOf("\t");
  if (tab <= 0) return null;
  const label = line.slice(tab + 1).trim();
  const cols = line.slice(0, tab).trim().split(/\s+/);
  if (!label || cols.length !== 2 || !/^\d+$/.test(cols[0] ?? "")) return null;
  const pid = Number(cols[0]);
  return Number.isSafeInteger(pid) ? { pid, label } : null;
}

function blankFact(domain: ServiceDomain, label: string, state: ServiceState, enabled: boolean | null, pid: number | null): ServiceFact {
  return { kind: "launchd", name: label, displayName: null, domain, program: null, state, startMode: null, enabled, pid, runAs: null, triggers: null, lastRun: null, lastResult: null };
}

export const macLaunchdStateAdapter: ServiceAdapter = {
  origin: "launchd-state",
  os: ["macos"],
  probes() {
    return [{ id: "state", argv: ["/bin/sh", "-c", MAC_LAUNCHD_STATE_SCRIPT] }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "state", "launchd-state");
    if (missing) return missing;
    const probe = outputs["state"]!;
    const { sections, complete } = launchdSections(probe.stdout);
    let malformed = !complete;
    const facts: ServiceFact[] = [];
    const index = new Map<string, ServiceFact>();
    for (const [marker, domain] of [["---SCOUT-SYSTEM---", "system"], ["---SCOUT-GUI---", "gui"]] as const) {
      const body = sections[marker];
      if (body === undefined) continue;
      for (const line of body.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        const parsed = launchdServiceLine(line);
        if (!parsed) { malformed = true; continue; }
        const key = `${domain}\0${parsed.label}`;
        if (index.has(key)) { malformed = true; continue; }
        const running = parsed.pid > 0;
        const fact = blankFact(domain, parsed.label, running ? "running" : "stopped", null, running ? parsed.pid : null);
        facts.push(fact);
        index.set(key, fact);
      }
    }
    for (const [marker, domain] of [["---SCOUT-DISABLED-SYSTEM---", "system"], ["---SCOUT-DISABLED-GUI---", "gui"]] as const) {
      const body = sections[marker];
      if (body === undefined) continue;
      for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed === "disabled services = {" || trimmed === "}") continue;
        const match = /^\s*"([^"]+)"\s*=>\s*(enabled|disabled)\s*$/.exec(line);
        if (!match) { malformed = true; continue; }
        const label = match[1]!;
        const enabled = match[2] === "enabled";
        const key = `${domain}\0${label}`;
        const existing = index.get(key);
        if (!existing) {
          // A label that is not in the services block still gets a row.
          const fact = blankFact(domain, label, enabled ? "stopped" : "disabled", enabled, null);
          facts.push(fact);
          index.set(key, fact);
          continue;
        }
        // print-disabled decides enabled. A running pid still reports state running.
        existing.enabled = enabled;
        if (existing.pid === null) existing.state = enabled ? "stopped" : "disabled";
      }
    }
    if (!complete && facts.length === 0) return result("launchd-state", "failed", [], "launchd sections are missing");
    return finish("launchd-state", probe, facts, malformed);
  },
};
