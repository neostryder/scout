import { hubMachineId, hubMachineName } from "./hub.ts";
import type { Db } from "./db.ts";
import { listListeners, type Listener } from "./listeners.ts";
import { listServices, type Service } from "./services.ts";
import { listRoutes, type RouteRow } from "./cloudflare.ts";
import { loadDescriptionResolver } from "./descriptions.ts";
import { buildHealthTargets, healthAlertCandidates, healthTarget } from "./health.ts";
import { portClashes, portsFileReader, type PortRegistry, type RegistryFile } from "./ports.ts";
import { recipesResponse } from "./recipes.ts";

export const ALERT_KINDS = ["new-listener", "new-daemon", "service-down", "domain-origin-down", "exposure-change", "unhealthy", "cert-expiring", "crash-loop", "port-clash"] as const;
export const ALERT_STATES = ["open", "acknowledged", "resolved"] as const;
export type AlertKind = typeof ALERT_KINDS[number];
export type AlertState = typeof ALERT_STATES[number];
export interface Alert {
  id: number;
  at: string;
  kind: AlertKind;
  severity: "info" | "warn" | "high";
  machineId: string | null;
  machineName: string | null;
  key: string;
  title: string;
  detail: string;
  target: { type: "service" | "listener" | "route" | null; id: number | null };
  state: AlertState;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  muted: boolean;
}
export interface AlertChange { alert: Alert; change: "created" | "resolved" | "acknowledged" | "muted" }
export interface AlertMute { key: string; match: string; reason: string; source: "file" | "page"; at: string }
export interface AlertFile { ungatedHosts: string[]; mute: { match: string; reason: string }[]; at: string | null; fileError: string | null }
export interface AlertOptions { loadMutes?: () => AlertFile; loadPorts?: () => RegistryFile<PortRegistry>; tunnelHosts?: Record<string, string>; machineId?: string }
interface Condition { hostname?: string; path?: string | null; fromBind?: "loopback" | "lan" | "all"; hostnames?: string[]; healthKey?: string }
interface RouteSnapshot { state: string; machineId: string | null; listenerId: number | null; serviceId: number | null; port: number | null }
interface EventDetail { port?: number; process?: string | null; container?: string | null; oldBind?: string; newBind?: string; name?: string; kind?: string; domain?: string; old?: { state?: string } | null }
interface StoredAlert extends Omit<Alert, "target" | "muted"> { targetType: Alert["target"]["type"]; targetId: number | null; muted: number; condition: string }
type Candidate = Omit<Alert, "id" | "state" | "acknowledgedAt" | "resolvedAt" | "muted"> & { condition: Condition };
const EMPTY: AlertFile = { ungatedHosts: [], mute: [], at: null, fileError: null };
const WIDTH = { loopback: 0, lan: 1, all: 2 };
const readPorts = portsFileReader();
const SELECT = `SELECT id, at, kind, severity, machine_id AS machineId, machine_name AS machineName, key, title, detail,
  target_type AS targetType, target_id AS targetId, state, acknowledged_at AS acknowledgedAt, resolved_at AS resolvedAt,
  muted, condition_json AS condition FROM alerts`;

function alertObject({ targetType, targetId, muted, condition, ...row }: StoredAlert): Alert {
  return { ...row, target: { type: targetType, id: targetId }, muted: muted !== 0 };
}

function glob(match: string, key: string): boolean {
  const pattern = match.split("*").map((part) => part.split("?").map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*");
  return new RegExp(`^${pattern}$`, "s").test(key);
}

export function alertMutes(db: Db, file: AlertFile = EMPTY): AlertMute[] {
  const page = db.prepare("SELECT key, reason, at FROM alert_mutes ORDER BY at DESC, key").all() as { key: string; reason: string; at: string }[];
  return [...file.mute.map((row) => ({ key: row.match, ...row, source: "file" as const, at: file.at! })), ...page.map((row) => ({ ...row, match: row.key, source: "page" as const }))];
}

function muted(candidate: { key: string; kind: AlertKind; target: Alert["target"]; machineId: string | null }, condition: Condition, file: AlertFile, mutes: AlertMute[], routes: RouteRow[]): boolean {
  if (mutes.some((mute) => mute.source === "page" ? mute.key === candidate.key : glob(mute.match, candidate.key))) return true;
  if (candidate.kind === "domain-origin-down") {
    const route = routes.find((row) => row.hostname === condition.hostname && row.path === condition.path);
    return route?.access == null && file.ungatedHosts.includes(condition.hostname?.toLowerCase() ?? "");
  }
  return candidate.kind === "exposure-change" && ([...(condition.hostnames ?? []), ...routes.filter((route) => route.listener?.id === candidate.target.id).map((route) => route.hostname)]).some((hostname) => file.ungatedHosts.includes(hostname.toLowerCase()));
}

export function refreshAlertMutes(db: Db, options: AlertOptions = {}): AlertChange[] {
  const file = options.loadMutes?.() ?? EMPTY;
  const mutes = alertMutes(db, file);
  const routes = listRoutes(db, { tunnelHosts: options.tunnelHosts }, loadDescriptionResolver(db, { hints: [] }));
  const changes: AlertChange[] = [];
  for (const row of db.prepare(SELECT).all() as unknown as StoredAlert[]) {
    const alert = alertObject(row);
    const value = muted(alert, JSON.parse(row.condition), file, mutes, routes);
    if (alert.muted === value) continue;
    db.prepare("UPDATE alerts SET muted = ? WHERE id = ?").run(value ? 1 : 0, alert.id);
    changes.push({ alert: { ...alert, muted: value }, change: "muted" });
  }
  return changes;
}

export function alertsResponse(db: Db, params = new URLSearchParams(), now = new Date().toISOString(), options: AlertOptions = {}) {
  const state = params.get("state") ?? "open";
  const kind = params.get("kind");
  const limit = Number(params.get("limit") ?? 50);
  if (state !== "all" && !(ALERT_STATES as readonly string[]).includes(state)) throw new Error("invalid state");
  if (kind !== null && !(ALERT_KINDS as readonly string[]).includes(kind)) throw new Error("invalid kind");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
  const include = params.get("include");
  if (include !== null && include !== "muted") throw new Error("invalid include");
  const rows = (db.prepare(`${SELECT} ORDER BY at DESC, id DESC`).all() as unknown as StoredAlert[]).map(alertObject);
  const visible = rows.filter((row) => !row.muted);
  const matched = rows.filter((row) => (include === "muted" || !row.muted) && (state === "all" || row.state === state) && (kind === null || row.kind === kind) && (!params.has("machine") || row.machineId === params.get("machine")));
  const file = options.loadMutes?.() ?? EMPTY;
  return { alerts: matched.slice(0, limit), total: matched.length, counts: { open: visible.filter((row) => row.state === "open").length, acknowledged: visible.filter((row) => row.state === "acknowledged").length, resolved: visible.filter((row) => row.state === "resolved").length }, mutes: alertMutes(db, file), generatedAt: now, fileError: file.fileError };
}

export function alertsSummary(db: Db): { open: number; high: number; latestAt: string | null } {
  const row = db.prepare("SELECT COUNT(*) AS open, COALESCE(SUM(severity = 'high'), 0) AS high, MAX(at) AS latestAt FROM alerts WHERE state = 'open' AND muted = 0").get();
  return row as unknown as { open: number; high: number; latestAt: string | null };
}

export function acknowledgeAlerts(db: Db, body: Record<string, unknown>, now = new Date().toISOString()): AlertChange[] | null {
  if (body.all !== undefined && body.all !== true || body.all === true && body.id !== undefined || body.kind !== undefined && (body.all !== true || !(ALERT_KINDS as readonly unknown[]).includes(body.kind))) throw new Error("invalid acknowledgement");
  if (body.all !== true && (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0)) throw new Error("id must be a positive integer or all must be true");
  const rows = db.prepare(`${SELECT} WHERE ${body.all === true ? "state = 'open'" : "id = ?"}`).all(...(body.all === true ? [] : [body.id as number])) as unknown as StoredAlert[];
  if (body.all !== true && rows.length === 0) return null;
  const changes: AlertChange[] = [];
  for (const row of rows) {
    if (row.state !== "open" || body.kind !== undefined && row.kind !== body.kind) continue;
    db.prepare("UPDATE alerts SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?").run(now, row.id);
    changes.push({ alert: { ...alertObject(row), state: "acknowledged", acknowledgedAt: now }, change: "acknowledged" });
  }
  return changes;
}

export function setAlertMute(db: Db, body: Record<string, unknown>, now = new Date().toISOString()): void {
  if (typeof body.key !== "string" || !body.key.length || body.key.length > 500 || body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500) || body.remove !== undefined && typeof body.remove !== "boolean") throw new Error("invalid mute");
  if (body.remove === true) db.prepare("DELETE FROM alert_mutes WHERE key = ?").run(body.key);
  else db.prepare("INSERT INTO alert_mutes (key, reason, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET reason = excluded.reason, at = excluded.at").run(body.key, body.reason as string ?? "", now);
}

export function evaluateAlerts(db: Db, now: string, options: AlertOptions = {}): AlertChange[] {
  const descriptions = loadDescriptionResolver(db, { hints: [] });
  const services = listServices(db, {}, descriptions);
  const listeners = listListeners(db, {}, descriptions);
  const routes = listRoutes(db, { tunnelHosts: options.tunnelHosts }, descriptions);
  const file = options.loadMutes?.() ?? EMPTY;
  const mutes = alertMutes(db, file);
  const changes: AlertChange[] = [];
  const previous = db.prepare("SELECT value FROM meta WHERE key = 'alert_routes'").get() as { value: string } | undefined;
  const routeStates: Record<string, RouteSnapshot> = previous ? JSON.parse(previous.value) : {};
  // Per-connection and per-app launchd jobs (sshd instances, application.* sessions) and loopback listeners in the dynamic port range come and go constantly and carry no signal.
  const ephemeral = (row: Service | Listener): boolean => "port" in row ? row.bind === "loopback" && row.port >= 49152 : row.kind === "launchd" && /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^application\.|\.\d{4,}\.\d{4,}$/i.test(row.name);
  const visible = (row: Service | Listener): boolean => !row.classification.hidden && row.classification.class !== "essential" && !ephemeral(row);
  const noun = (kind: string | null): string => kind === "launchd" ? "launchd job" : kind === "windows-service" ? "Windows service" : kind === "scheduled-task" ? "scheduled task" : "service";
  const expected = (type: "service" | "listener", id: number): boolean => (db.prepare(`SELECT expected_down AS value FROM ${type === "service" ? "services" : "listeners"} WHERE id = ?`).get(id) as { value: number } | undefined)?.value === 1;
  const down = (row: Service | Listener): boolean => row.goneAt !== null || "state" in row && row.state !== "running";
  const routeTarget = (row: Service | Listener): boolean => Object.values(routeStates).some((route) => "port" in row ? route.listenerId === row.id || route.machineId === row.machineId && route.port === row.port : route.serviceId === row.id) || routes.some((route) => route.machineId === row.machineId && ("port" in row ? route.origin?.port === row.port : route.listener?.serviceName === row.name || row.ports.some((port) => port.port === route.origin?.port)));
  const candidates: Candidate[] = [];
  const clashes = portClashes((options.loadPorts ?? readPorts)().config, listeners, recipesResponse(db).recipes);
  for (const clash of clashes) candidates.push({ at: now, kind: "port-clash", severity: clash.kind === "recipe-port-shared" ? "warn" : "high", machineId: hubMachineId(), machineName: hubMachineName(), key: `port-clash:${clash.key}`, title: `Port clash: ${clash.port}`, detail: clash.detail, target: { type: null, id: null }, condition: {} });
  const healthCandidates = healthAlertCandidates(db, now, options.tunnelHosts);
  const healthKeys = new Set(buildHealthTargets(db, options.tunnelHosts).map((target) => target.key));
  candidates.push(...healthCandidates);
  const add = (kind: AlertKind, row: Service | Listener, severity: Alert["severity"], title: string, detail: string, condition: Condition = {}): void => {
    const type = "port" in row ? "listener" : "service";
    const identity = "port" in row ? `${row.port}:${row.processName ?? row.containerName ?? "unknown"}${row.containerName && row.processName ? `:${row.containerName}` : ""}` : `${row.kind}:${row.domain}:${row.name}`;
    candidates.push({ at: now, kind, severity, machineId: row.machineId, machineName: row.machineName, key: `${kind}:${row.machineId}:${kind === "service-down" ? `${type}:` : ""}${identity}`, title, detail, target: { type, id: row.id }, condition });
  };
  db.exec("SAVEPOINT evaluate_alerts");
  try {
    const initialized = new Set<string>();
    const machines = db.prepare("SELECT id FROM machines WHERE id = ? OR id IN (SELECT machine_id FROM services UNION SELECT machine_id FROM listeners UNION SELECT machine_id FROM events)").all(options.machineId ?? null) as { id: string }[];
    for (const machine of machines) {
      const latest = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE machine_id = ?").get(machine.id) as { id: number }).id;
      const baseline = db.prepare("SELECT event_id AS id FROM alert_baseline WHERE machine_id = ?").get(machine.id) as { id: number } | undefined;
      if (!baseline) initialized.add(machine.id);
      else {
        const events = db.prepare("SELECT kind, detail_json AS detail FROM events WHERE machine_id = ? AND id > ? AND id <= ? ORDER BY id").all(machine.id, baseline.id, latest) as { kind: string; detail: string }[];
        for (const event of events) {
          let detail: EventDetail;
          try { detail = JSON.parse(event.detail); } catch { continue; }
          if (!detail || typeof detail !== "object") continue;
          if (event.kind.startsWith("listener_")) {
            const row = listeners.find((row) => row.machineId === machine.id && row.port === detail.port && (row.processName ?? row.containerName) === detail.process && (detail.container === undefined || row.containerName === detail.container));
            if (!row || !visible(row)) continue;
            if (event.kind === "listener_new" && row.goneAt === null) add("new-listener", row, row.bind === "all" ? "warn" : "info", `New listener on ${row.machineName}: port ${row.port} (${row.processName ?? row.containerName ?? "unknown"})`, `Port ${row.port} listens on ${row.bind} interfaces.`);
            const oldBind = detail.oldBind as keyof typeof WIDTH;
            const newBind = detail.newBind as keyof typeof WIDTH;
            if (event.kind === "listener_changed" && Object.hasOwn(WIDTH, oldBind) && Object.hasOwn(WIDTH, newBind) && WIDTH[newBind] > WIDTH[oldBind] && row.goneAt === null && WIDTH[row.bind] > WIDTH[oldBind]) add("exposure-change", row, row.bind === "all" ? "high" : "warn", `Listener exposure widened on ${row.machineName}: port ${row.port}`, `Port ${row.port} changed from ${oldBind} to ${row.bind}.`, { fromBind: oldBind, hostnames: routes.filter((route) => route.listener?.id === row.id).map((route) => route.hostname) });
            if (event.kind === "listener_gone" && down(row) && !expected("listener", row.id)) add("service-down", row, routeTarget(row) ? "high" : "warn", `Listener stopped on ${row.machineName}: port ${row.port}`, `Port ${row.port} is no longer listening.`);
          } else if (event.kind.startsWith("service_")) {
            const row = services.find((row) => row.machineId === machine.id && row.name === detail.name && row.kind === detail.kind && row.domain === detail.domain);
            if (!row || !visible(row)) continue;
            if (event.kind === "service_new" && row.goneAt === null) add("new-daemon", row, "info", `New service on ${row.machineName}: ${row.displayName ?? row.name}`, `The ${noun(row.kind)} is ${row.state}${row.startMode ? ` with ${row.startMode} startup` : ""}.`);
            if ((event.kind === "service_changed" || event.kind === "service_gone") && detail.old?.state === "running" && down(row) && !expected("service", row.id)) add("service-down", row, routeTarget(row) ? "high" : "warn", `Service stopped on ${row.machineName}: ${row.displayName ?? row.name}`, `The ${noun(row.kind)} is ${row.goneAt ? "gone" : row.state}.`);
          }
        }
      }
      db.prepare("INSERT INTO alert_baseline (machine_id, event_id, at) VALUES (?, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET event_id = excluded.event_id").run(machine.id, latest, now);
    }
    const next: Record<string, RouteSnapshot> = {};
    for (const route of routes) {
      const key = `${route.hostname}:${route.path ?? ""}`;
      const listener = listeners.find((row) => row.id === route.listener?.id);
      const service = services.find((row) => row.machineId === listener?.machineId && row.name === route.listener?.serviceName);
      next[key] = { state: route.state, machineId: route.machineId, listenerId: route.listener?.id ?? null, serviceId: service?.id ?? null, port: route.origin?.port ?? null };
      if (previous && (!route.machineId || !initialized.has(route.machineId)) && routeStates[key]?.state !== route.state && (route.state === "origin-down" || route.state === "dns-dangling")) candidates.push({ at: now, kind: "domain-origin-down", severity: "high", machineId: route.machineId, machineName: route.machineName, key: `domain-origin-down:${key}`, title: `Domain origin is down${route.machineName ? ` on ${route.machineName}` : ""}: ${route.hostname}`, detail: `The route is ${route.state}.`, target: { type: "route", id: null }, condition: { hostname: route.hostname, path: route.path } });
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('alert_routes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    for (const row of db.prepare(`${SELECT} WHERE state <> 'resolved'`).all() as unknown as StoredAlert[]) {
      const condition: Condition = JSON.parse(row.condition);
      const target = row.targetType === "service" ? services.find((item) => item.id === row.targetId) : listeners.find((item) => item.id === row.targetId);
      const route = routes.find((item) => item.hostname === condition.hostname && item.path === condition.path);
      const health = condition.healthKey && healthKeys.has(condition.healthKey) ? healthTarget(db, condition.healthKey, now) : null;
      const clears = row.kind === "port-clash" ? !clashes.some((clash) => `port-clash:${clash.key}` === row.key) :
        row.kind === "unhealthy" ? !health || ["up", "slow", "not-http"].includes(health.state) :
        row.kind === "cert-expiring" ? !health || health.tlsDaysLeft !== null && health.tlsDaysLeft > 14 :
        row.kind === "crash-loop" ? !healthCandidates.some((candidate) => candidate.key === row.key) :
        row.kind === "domain-origin-down" ? !route || route.state === "ok" :
        !target || !visible(target) || (row.kind === "service-down" ? !down(target) || expected(row.targetType as "service" | "listener", target.id) : target.goneAt !== null || row.kind === "exposure-change" && "bind" in target && WIDTH[target.bind] <= WIDTH[condition.fromBind!]);
      if (!clears) continue;
      db.prepare("UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE id = ?").run(now, row.id);
      changes.push({ alert: { ...alertObject(row), state: "resolved", resolvedAt: now }, change: "resolved" });
    }
    for (const row of db.prepare(`${SELECT} WHERE state = 'resolved' AND kind IN ('new-listener','new-daemon') ORDER BY id DESC`).all() as unknown as StoredAlert[]) {
      const target = row.targetType === "service" ? services.find((item) => item.id === row.targetId) : listeners.find((item) => item.id === row.targetId);
      if (!target || target.goneAt !== null || !visible(target) || candidates.some((candidate) => candidate.key === row.key)) continue;
      candidates.push({ at: now, kind: row.kind, severity: "bind" in target ? target.bind === "all" ? "warn" : "info" : "info", machineId: row.machineId, machineName: row.machineName, key: row.key, title: row.title, detail: row.detail, target: { type: row.targetType, id: row.targetId }, condition: JSON.parse(row.condition) });
    }
    for (const candidate of candidates) {
      const existing = db.prepare(`${SELECT} WHERE key = ? AND state <> 'resolved'`).get(candidate.key) as unknown as StoredAlert | undefined;
      if (existing) {
        if ((candidate.kind === "cert-expiring" || candidate.kind === "unhealthy" || candidate.kind === "crash-loop" || candidate.kind === "port-clash") && (candidate.severity !== existing.severity || candidate.detail !== existing.detail)) {
          db.prepare("UPDATE alerts SET severity = ?, detail = ? WHERE id = ?").run(candidate.severity, candidate.detail, existing.id);
          changes.push({ alert: { ...alertObject(existing), severity: candidate.severity, detail: candidate.detail }, change: "created" });
        }
        if (candidate.kind === "exposure-change" && candidate.severity === "high" && existing.severity !== "high") {
          db.prepare("UPDATE alerts SET severity = 'high', at = ?, detail = ? WHERE id = ?").run(now, candidate.detail, existing.id);
          changes.push({ alert: { ...alertObject(existing), severity: "high", at: now, detail: candidate.detail }, change: "created" });
        }
        continue;
      }
      const isMuted = muted(candidate, candidate.condition, file, mutes, routes);
      const inserted = db.prepare(`INSERT INTO alerts (at, kind, severity, machine_id, machine_name, key, title, detail, target_type, target_id, state, muted, condition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(candidate.at, candidate.kind, candidate.severity, candidate.machineId, candidate.machineName, candidate.key, candidate.title, candidate.detail, candidate.target.type, candidate.target.id, isMuted ? 1 : 0, JSON.stringify(candidate.condition));
      changes.push({ alert: alertObject(db.prepare(`${SELECT} WHERE id = ?`).get(inserted.lastInsertRowid) as unknown as StoredAlert), change: "created" });
    }
    changes.push(...refreshAlertMutes(db, { ...options, loadMutes: () => file }));
    db.exec("RELEASE evaluate_alerts");
    return changes;
  } catch (err) {
    db.exec("ROLLBACK TO evaluate_alerts");
    db.exec("RELEASE evaluate_alerts");
    throw err;
  }
}
