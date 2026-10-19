import type { Db } from "./db.ts";
import type { Probe, ProbeContext, ProbeOutputs, ScanStatus } from "./adapter.ts";
import { classifyService, type Classification, type ServiceClass } from "./classify.ts";
import { listListeners, type Listener, type ListenerBind } from "./listeners.ts";
import { loadDescriptionResolver, type Description, type DescriptionResolver } from "./descriptions.ts";
import type { HealthRow } from "./health.ts";

export type ServiceKind = "windows-service" | "scheduled-task" | "launchd" | "systemd";
export type ServiceState = "running" | "stopped" | "disabled" | "other";
export type ServiceStartMode = "auto" | "manual" | "disabled" | "boot";
export type ServiceDomain = "system" | "gui";

export interface ServiceFact {
  kind: ServiceKind;
  name: string;
  displayName: string | null;
  domain: ServiceDomain;
  program: string | null;
  state: ServiceState;
  startMode: ServiceStartMode | null;
  enabled: boolean | null;
  pid: number | null;
  runAs: string | null;
  uid?: number | null;
  keepAlive?: boolean | null;
  plist?: string | null;
  triggers: string[] | null;
  lastRun: string | null;
  lastResult: string | null;
}

export interface ServiceResult {
  origin: string;
  status: ScanStatus;
  facts: ServiceFact[];
  message?: string;
}

export interface ServiceAdapter {
  origin: string;
  os: ReadonlyArray<"macos" | "windows" | "linux">;
  probes(ctx: ProbeContext): Probe[];
  parse(outputs: ProbeOutputs): ServiceResult;
}

export interface ServicePort {
  port: number;
  bind: ListenerBind;
  address: string;
  health: HealthRow | null;
}

export interface Service {
  id: number;
  machineId: string;
  machineName: string;
  kind: ServiceKind;
  domain: ServiceDomain;
  name: string;
  displayName: string | null;
  program: string | null;
  state: ServiceState;
  startMode: ServiceStartMode | null;
  enabled: boolean | null;
  pid: number | null;
  runAs: string | null;
  uid?: number | null;
  keepAlive?: boolean | null;
  plist?: string | null;
  triggers: string[] | null;
  lastRun: string | null;
  lastResult: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  goneAt: string | null;
  ports: ServicePort[];
  classification: Classification;
  description: Description | null;
}

interface ServiceRow extends Omit<Service, "ports" | "enabled" | "triggers" | "description" | "keepAlive"> {
  keepAlive: number | null;
  installPlist: string | null;
  installDetails: string | null;
  enabled: number | null;
  triggers: string | null;
}

const identity = (row: { kind: string; domain: string; name: string }): string => JSON.stringify([row.kind, row.domain, row.name]);

function watched(row: { state: ServiceState; enabled: boolean | null; program: string | null }): { state: ServiceState; enabled: boolean | null; program: string | null } {
  return { state: row.state, enabled: row.enabled, program: row.program };
}

/** A reader proves absence only for its own family, so a task scan cannot retire services. */
function owns(origin: string, kind: ServiceKind): boolean {
  if (origin === "services") return true;
  if (origin === "win-services") return kind === "windows-service";
  if (origin === "win-tasks") return kind === "scheduled-task";
  if (origin === "launchd-state") return kind === "launchd";
  if (origin === "systemd-state") return kind === "systemd";
  return false;
}

export function recordServices(db: Db, machineId: string, result: ServiceResult, now: string): { services: number; gone: number } {
  const summary = { services: 0, gone: 0 };
  if (result.status === "failed" || result.status === "skipped") return summary;
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = listServices(db, { machine: machineId });
    const baselineKey = `services_observed:${machineId}`;
    const firstScan = previous.length === 0 && !db.prepare("SELECT 1 FROM meta WHERE key = ?").get(baselineKey);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(baselineKey, now);
    const old = new Map(previous.map((row) => [identity(row), row]));
    const facts = new Map<string, ServiceFact>();
    for (const fact of result.facts) facts.set(identity(fact), fact);
    const put = db.prepare(
      `INSERT INTO services (machine_id, kind, domain, name, display_name, program, state, start_mode, enabled, pid, run_as, triggers, last_run, last_result, first_seen_at, last_seen_at, uid, keep_alive, plist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET display_name = excluded.display_name, program = excluded.program, state = excluded.state,
         start_mode = excluded.start_mode, enabled = excluded.enabled, pid = excluded.pid, run_as = excluded.run_as,
         triggers = excluded.triggers, last_run = excluded.last_run, last_result = excluded.last_result,
         last_seen_at = excluded.last_seen_at, gone_at = NULL,
         uid = COALESCE(excluded.uid, services.uid), keep_alive = COALESCE(excluded.keep_alive, services.keep_alive), plist = COALESCE(excluded.plist, services.plist)`,
    );
    const event = db.prepare("INSERT INTO events (at, machine_id, kind, detail_json) VALUES (?, ?, ?, ?)");
    const emit = (kind: string, fact: ServiceFact, before: ReturnType<typeof watched> | null, after: ReturnType<typeof watched> | null) => {
      if (!firstScan) event.run(now, machineId, kind, JSON.stringify({ machine: machineId, kind: fact.kind, domain: fact.domain, name: fact.name, old: before, new: after }));
    };
    for (const fact of facts.values()) {
      const before = old.get(identity(fact));
      put.run(
        machineId, fact.kind, fact.domain, fact.name, fact.displayName, fact.program, fact.state, fact.startMode,
        fact.enabled === null ? null : fact.enabled ? 1 : 0, fact.pid, fact.runAs, fact.triggers === null ? null : JSON.stringify(fact.triggers),
        fact.lastRun, fact.lastResult, now, now,
        fact.uid ?? null, fact.keepAlive == null ? null : fact.keepAlive ? 1 : 0, fact.plist ?? null,
      );
      summary.services++;
      const after = watched(fact);
      if (!before) emit("service_new", fact, null, after);
      else if (before.state !== fact.state || before.enabled !== fact.enabled || before.program !== fact.program) emit("service_changed", fact, watched(before), after);
    }
    if (result.status === "ok") {
      for (const row of previous) {
        if (!owns(result.origin, row.kind) || row.goneAt !== null || facts.has(identity(row))) continue;
        db.prepare("UPDATE services SET gone_at = ? WHERE id = ?").run(now, row.id);
        summary.gone++;
        emit("service_gone", row, watched(row), null);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}

export interface ServiceFilter {
  machine?: string;
  kind?: ServiceKind;
  state?: ServiceState;
  q?: string;
  hasPort?: boolean;
  gone?: "present" | "gone";
  class?: ServiceClass;
  official?: boolean;
  includeHidden?: boolean;
}

function flag(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function triggerList(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed as string[] : null;
  } catch {
    return null;
  }
}

/** A live pid is the process that owns the socket. Without one, the executable is the only link, and it is not added on top of a pid match. */
function portsFor(row: { kind: ServiceKind; pid: number | null; program: string | null }, listeners: Listener[]): ServicePort[] {
  const windows = row.kind === "windows-service" || row.kind === "scheduled-task";
  const samePath = (path: string | null): boolean => {
    if (row.program === null || path === null) return false;
    return windows ? path.toLowerCase() === row.program.toLowerCase() : path === row.program;
  };
  const matched = listeners.filter((listener) => (row.pid !== null ? listener.pid === row.pid : samePath(listener.processPath)));
  const seen = new Set<string>();
  const ports: ServicePort[] = [];
  for (const listener of matched) {
    const key = JSON.stringify([listener.port, listener.bind, listener.address]);
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ port: listener.port, bind: listener.bind, address: listener.address, health: listener.health });
  }
  ports.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address) || a.bind.localeCompare(b.bind));
  return ports;
}

export function listServices(db: Db, filter: ServiceFilter = {}, descriptions: DescriptionResolver = loadDescriptionResolver(db)): Service[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.machine !== undefined) { clauses.push("s.machine_id = ?"); params.push(filter.machine); }
  if (filter.kind !== undefined) { clauses.push("s.kind = ?"); params.push(filter.kind); }
  if (filter.state !== undefined) { clauses.push("s.state = ?"); params.push(filter.state); }
  if (filter.gone !== undefined) clauses.push(`s.gone_at IS ${filter.gone === "present" ? "NULL" : "NOT NULL"}`);
  const rows = db.prepare(
    `SELECT s.id, s.machine_id AS machineId, m.name AS machineName, s.kind, s.domain, s.name, s.display_name AS displayName,
       s.program, s.state, s.start_mode AS startMode, s.enabled, s.pid, s.run_as AS runAs, s.triggers, s.last_run AS lastRun,
       s.last_result AS lastResult, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.gone_at AS goneAt,
       s.uid, s.keep_alive AS keepAlive, s.plist, li.location AS installPlist, li.details_json AS installDetails
     FROM services s JOIN machines m ON m.id = s.machine_id
     LEFT JOIN installs li ON s.kind = 'launchd' AND li.id = (
       SELECT candidate.id FROM installs candidate JOIN packages package ON package.id = candidate.package_id
       WHERE candidate.machine_id = s.machine_id AND candidate.removed_at IS NULL AND package.ecosystem = 'launchd' AND package.key = s.name
         AND ((s.domain = 'system' AND candidate.location LIKE '/Library/LaunchDaemons/%')
           OR (s.domain = 'gui' AND candidate.location LIKE '%/Library/LaunchAgents/%'))
       ORDER BY candidate.id LIMIT 1
     )
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY m.name, s.kind, s.name, s.id`,
  ).all(...params) as unknown as ServiceRow[];
  const listeners = new Map<string, Listener[]>();
  for (const listener of listListeners(db, { ...(filter.machine !== undefined ? { machine: filter.machine } : {}), state: "present" }, descriptions)) {
    const list = listeners.get(listener.machineId);
    if (list) list.push(listener);
    else listeners.set(listener.machineId, [listener]);
  }
  const services = rows.map(({ installPlist, installDetails, ...row }) => {
    let details: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(installDetails ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
    } catch { /* A malformed install cannot supply control facts. */ }
    const facts = { ...row, program: row.program ?? (typeof details.program === "string" ? details.program : null), plist: row.plist ?? installPlist, keepAlive: flag(row.keepAlive) ?? (typeof details.keepAlive === "boolean" ? details.keepAlive : null) };
    const ports = portsFor(facts, listeners.get(row.machineId) ?? []);
    const enabled = flag(row.enabled);
    const triggers = triggerList(row.triggers);
    const classification = classifyService({ ...facts, enabled, triggers }, ports.some((port) => port.bind !== "loopback"));
    return { ...facts, enabled, triggers, ports, classification, description: descriptions.describe(facts) };
  });
  return services.filter((row) =>
    (filter.q === undefined || [row.name, row.displayName, row.program, row.description?.text].some((text) => text?.toLowerCase().includes(filter.q!.toLowerCase()))) &&
    (filter.hasPort === undefined || (filter.hasPort ? row.ports.length > 0 : row.ports.length === 0)) &&
    (filter.class === undefined || row.classification.class === filter.class) &&
    (filter.official === undefined || row.classification.official === filter.official) &&
    (filter.includeHidden !== false || !row.classification.hidden)
  );
}
