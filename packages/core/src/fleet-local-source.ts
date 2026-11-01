import { defaultSeverity, fingerprint, type FailureClass, type IncidentEvidence, type IncidentPacket, type Severity } from "./fleet-packet.ts";
import type { FleetLocalConfig, FleetLocalEventConfig } from "./fleet-ports.ts";

export interface LocalCommandResult { code: number | null; stdout: string; error: string | null }

export type LocalObservation =
  | { kind: "disk"; path: string; bsize: number; blocks: number; bavail: number }
  | { kind: "disk-error"; path: string; error: string }
  | { kind: "windowsEvents"; index: number; result: LocalCommandResult }
  | { kind: "tasks"; result: LocalCommandResult }
  | { kind: "wsl"; result: LocalCommandResult }
  | { kind: "log"; index: number; text: string; mtimeMs: number }
  | { kind: "log-error"; index: number; error: string };

export interface LocalWindowsEvent { id: number; provider: string; time: string; text: string }

interface LocalTask { path: string; name: string; state: string; lastRun: string | null; lastResult: number; nextRun: string | null; enabled: boolean }

export function windowsEventQuery(config: FleetLocalEventConfig): string {
  const clauses: string[] = [];
  for (const [key, values] of [["EventID", config.ids], ["Level", config.levels]] as const) {
    if (values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) || values.length > 50) throw new Error("invalid event query integers");
    if (values.length > 0) clauses.push(`(${values.map((value) => `${key}=${value}`).join(" or ")})`);
  }
  if (!Number.isSafeInteger(config.maxAgeMinutes) || config.maxAgeMinutes < 1 || config.maxAgeMinutes > 10080) throw new Error("invalid event query age");
  clauses.push(`TimeCreated[timediff(@SystemTime) <= ${config.maxAgeMinutes * 60_000}]`);
  return `*[System[${clauses.join(" and ")}]]`;
}

function xmlText(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" })[entity]!).replace(/\s+/g, " ").trim();
}

export function parseLocalWindowsEvents(xml: string): LocalWindowsEvent[] {
  const events: LocalWindowsEvent[] = [];
  for (const match of xml.slice(0, 65_536).matchAll(/<Event\b[^>]*>([\s\S]*?)<\/Event>/gi)) {
    const body = match[1]!;
    const id = /<EventID\b[^>]*>(\d+)<\/EventID>/i.exec(body)?.[1];
    if (!id) continue;
    const provider = /<Provider\b[^>]*\bName=["']([^"']*)["']/i.exec(body)?.[1] ?? "";
    const time = /<TimeCreated\b[^>]*\bSystemTime=["']([^"']*)["']/i.exec(body)?.[1] ?? "";
    const message = /<Message\b[^>]*>([\s\S]*?)<\/Message>/i.exec(body)?.[1];
    const data = [...body.matchAll(/<Data\b[^>]*>([\s\S]*?)<\/Data>/gi)].map((item) => item[1]).join(" ");
    events.push({ id: Number(id), provider: xmlText(provider).slice(0, 100), time: time.slice(0, 40), text: xmlText(message ?? data).slice(0, 300) });
    if (events.length === 20) break;
  }
  return events;
}

function packet(config: FleetLocalConfig, component: string, failureClass: FailureClass, summary: string, evidence: IncidentEvidence, now: string, severity?: Severity): IncidentPacket {
  return {
    version: 1,
    host: config.host,
    component,
    failureClass,
    severity: defaultSeverity(failureClass, severity ? { severity } : {}),
    firstSeen: now,
    lastSeen: now,
    count: 1,
    fingerprint: fingerprint(config.host, component, failureClass),
    summary: summary.slice(0, 299),
    evidence,
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
}

function journal(lines: string[]): string {
  return lines.slice(-5).map((line) => line.slice(0, 300)).join("\n").slice(0, 1500);
}

export function localPackets(config: FleetLocalConfig, observations: readonly LocalObservation[], now: string): IncidentPacket[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const packets: IncidentPacket[] = [];
  const failure = (component: string, error: string): void => {
    packets.push(packet(config, component, "watcher-failure", "local probe failed", { stderrTail: error.slice(0, 1500) }, now));
  };
  for (const observation of observations) {
    if (observation.kind === "disk-error") {
      failure(`disk:${observation.path}`, observation.error);
    } else if (observation.kind === "disk") {
      const { bsize, blocks, bavail } = observation;
      if (![bsize, blocks, bavail].every(Number.isFinite) || bsize <= 0 || blocks <= 0 || bavail < 0 || bavail > blocks) {
        failure(`disk:${observation.path}`, "invalid disk statistics");
        continue;
      }
      const freePercent = bavail / blocks * 100;
      if (freePercent >= config.disk.warnFreePercent) continue;
      packets.push(packet(config, `disk:${observation.path}`, "resources", `disk free space ${freePercent.toFixed(1)}%`, {
        snapshot: { freePercent, freeGiB: bavail * bsize / 1024 ** 3, totalGiB: blocks * bsize / 1024 ** 3 },
      }, now, freePercent < config.disk.criticalFreePercent ? undefined : "warning"));
    } else if (observation.kind === "windowsEvents") {
      const entry = config.windowsEvents[observation.index];
      if (!entry) continue;
      const { result } = observation;
      if (result.error || result.code !== 0) {
        failure(`windowsEvents:${entry.component}`, result.error ?? `exit ${result.code ?? "null"}`);
        continue;
      }
      const events = parseLocalWindowsEvents(result.stdout).filter((event) => (entry.providers.length === 0 || entry.providers.some((provider) => provider.toLowerCase() === event.provider.toLowerCase())) && (!Number.isFinite(Date.parse(event.time)) || nowMs - Date.parse(event.time) <= entry.maxAgeMinutes * 60_000));
      events.sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
      if (events.length === 0) continue;
      packets.push(packet(config, entry.component, entry.failureClass, `newest event ${events[0]!.id}; ${events.length} events`, {
        journalTail: journal(events.slice(0, 5).map((event) => `${event.time} ${event.provider} EventID=${event.id} ${event.text}`)),
      }, now));
    } else if (observation.kind === "tasks") {
      if (!config.tasks.enabled) continue;
      const { result } = observation;
      if (result.error || result.code !== 0) {
        failure("tasks", result.error ?? `exit ${result.code ?? "null"}`);
        continue;
      }
      let tasks: LocalTask[];
      try {
        tasks = JSON.parse(result.stdout);
        if (!Array.isArray(tasks) || tasks.some((task) => !task || typeof task.path !== "string" || typeof task.name !== "string" || typeof task.state !== "string" || typeof task.enabled !== "boolean" || !Number.isSafeInteger(task.lastResult) || (task.lastRun !== null && (typeof task.lastRun !== "string" || !Number.isFinite(Date.parse(task.lastRun)))) || (task.nextRun !== null && (typeof task.nextRun !== "string" || !Number.isFinite(Date.parse(task.nextRun)))))) throw new Error("invalid task output");
      } catch {
        failure("tasks", "invalid task output");
        continue;
      }
      const ignore = config.tasks.ignore.map((pattern) => new RegExp(pattern, "i"));
      const skipped = (task: LocalTask): boolean => !task.enabled || task.state.toLowerCase() === "disabled" || ignore.some((pattern) => pattern.test(task.path));
      const normalResults = new Set([0, 267008, 267009, 267010, 267011, 267012, 267014, 267015, 2147946720]);
      for (const task of tasks) {
        if (skipped(task) || task.lastRun === null) continue;
        const age = nowMs - Date.parse(task.lastRun);
        // Task Scheduler returns the same HRESULT as signed or unsigned integers.
        const lastResult = task.lastResult >>> 0;
        if (age < 0 || age > 7 * 24 * 60 * 60_000 || normalResults.has(lastResult)) continue;
        const lastResultHex = `0x${lastResult.toString(16).toUpperCase().padStart(8, "0")}`;
        packets.push(packet(config, `task:${task.path}`, config.tasks.failureClass, `task exited ${lastResultHex}`, {
          snapshot: { path: task.path, state: task.state, lastRun: task.lastRun, nextRun: task.nextRun, lastResultHex },
        }, now));
      }
      for (const entry of config.tasks.expected) {
        const name = entry.name.toLowerCase();
        const task = tasks.find((task) => task.name.toLowerCase() === name || task.path.toLowerCase() === name);
        if (!task) {
          if (!ignore.some((pattern) => pattern.test(entry.name))) packets.push(packet(config, `task:${entry.name}`, "never-ran", "expected task is missing", { snapshot: { path: entry.name } }, now));
          continue;
        }
        if (skipped(task) || (task.lastRun !== null && nowMs - Date.parse(task.lastRun) <= entry.maxAgeHours * 60 * 60_000)) continue;
        packets.push(packet(config, `task:${task.path}`, "never-ran", task.lastRun === null ? "task has never run" : `task has not run in ${entry.maxAgeHours} hours`, {
          snapshot: { path: task.path, state: task.state, lastRun: task.lastRun, nextRun: task.nextRun },
        }, now));
      }
    } else if (observation.kind === "wsl") {
      const { result } = observation;
      if (/\bENOENT\b/.test(result.error ?? "")) continue;
      if (result.error || result.code !== 0) packets.push(packet(config, "wsl", "dead", "WSL status failed", { snapshot: { exitCode: result.code, timedOut: result.error === "timeout" } }, now));
    } else if (observation.kind === "log-error") {
      const entry = config.logs[observation.index];
      if (entry) failure(`log:${entry.component}`, observation.error);
    } else {
      const entry = config.logs[observation.index];
      if (!entry) continue;
      const pattern = new RegExp(entry.pattern, "i");
      const ignore = entry.ignore === undefined ? null : new RegExp(entry.ignore, "i");
      const lines = observation.text.slice(-entry.tailKilobytes * 1024).split(/\r?\n/).filter((line) => {
        const timestamp = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.exec(line)?.[1];
        const time = timestamp ? Date.parse(timestamp) : NaN;
        return (!Number.isFinite(time) || nowMs - time <= entry.maxAgeMinutes * 60_000) && pattern.test(line) && !ignore?.test(line);
      });
      if (lines.length > 0) packets.push(packet(config, entry.component, entry.failureClass, `${lines.length} matching log lines`, { journalTail: journal(lines) }, now));
      if (entry.staleAfterMinutes !== null && nowMs - observation.mtimeMs > entry.staleAfterMinutes * 60_000) {
        packets.push(packet(config, entry.component, "wedged", "log file is stale", { snapshot: { mtime: new Date(observation.mtimeMs).toISOString(), staleAfterMinutes: entry.staleAfterMinutes } }, now));
      }
    }
  }
  return [...new Map(packets.map((item) => [item.fingerprint, item])).values()];
}
