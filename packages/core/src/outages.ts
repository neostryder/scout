import type { Db } from "./db.ts";
import { loadDescriptionResolver } from "./descriptions.ts";
import { listListeners, type Listener } from "./listeners.ts";
import { listServices, type Service } from "./services.ts";
import type { WatchConfig } from "./watch-file.ts";
import { isWatched } from "./watch-file.ts";
import { formatLocal, sinceLastCheck } from "./time.ts";

// An outage is a check that failed twice in a row. The recorded start is the first failed check, the end is the first check that passed,
// and a restart that is over before the second check never becomes an outage.

export const WATCH_KINDS = ["machine", "url", "service"] as const;
export const OUTAGE_KINDS = ["machine", "url", "service", "flapping", "monitor-gap"] as const;
export type WatchKind = typeof WATCH_KINDS[number];
export type OutageKind = typeof OUTAGE_KINDS[number];
/** Failed checks in a row that make an outage. */
export const CONFIRM_AFTER = 2;
/** This many separate failures inside the window make a flapping outage. */
export const FLAP_EPISODES = 3;
export const FLAP_WINDOW_MS = 30 * 60_000;

export interface Observation {
  key: string;
  kind: WatchKind;
  machineId: string | null;
  label: string;
  ok: boolean;
  /** `up`, or why it failed: `hung`, `down`, `not-running`, `unhealthy`. */
  state: string;
  detail: string;
  at: string;
  /** Where a listener can be reached, so a caller can confirm by connecting when the machine's own table is unreliable. */
  endpoint?: { host: string; port: number };
}

export interface Outage {
  id: number;
  key: string;
  kind: OutageKind;
  machineId: string | null;
  label: string;
  state: string;
  startedAt: string;
  confirmedAt: string;
  endedAt: string | null;
  detail: string;
  /** The last check that passed before an open outage began; null once it has ended or when none is on record. */
  lastOkAt: string | null;
  durationMs: number;
}

export interface OutageChange { outage: Outage; change: "confirmed" | "updated" | "recovered" }
export interface OutageNotice { title: string; body: string; severity: "high" | "info" }

interface OutageRow extends Omit<Outage, "durationMs"> { id: number }
interface WatchRow { key: string; failures: number; firstFailedAt: string | null; lastState: string; lastCheckedAt: string | null; lastOkAt: string | null; episodes: string }

const OUTAGE_SELECT = `SELECT id, key, kind, machine_id AS machineId, label, state, started_at AS startedAt, confirmed_at AS confirmedAt, ended_at AS endedAt, detail,
  CASE WHEN ended_at IS NULL THEN (SELECT last_ok_at FROM watch_state WHERE watch_state.key = outages.key) END AS lastOkAt FROM outages`;

function outage(row: OutageRow, now: string): Outage {
  const end = Date.parse(row.endedAt ?? now);
  return { ...row, durationMs: Math.max(0, end - Date.parse(row.startedAt)) };
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

function openOutage(db: Db, key: string, now: string): Outage | null {
  const row = db.prepare(`${OUTAGE_SELECT} WHERE key = ? AND ended_at IS NULL`).get(key) as OutageRow | undefined;
  return row ? outage(row, now) : null;
}

function closeOutage(db: Db, id: number, at: string, detail?: string): Outage {
  if (detail === undefined) db.prepare("UPDATE outages SET ended_at = ? WHERE id = ?").run(at, id);
  else db.prepare("UPDATE outages SET ended_at = ?, detail = ? WHERE id = ?").run(at, detail, id);
  return outage(db.prepare(`${OUTAGE_SELECT} WHERE id = ?`).get(id) as unknown as OutageRow, at);
}

function insertOutage(db: Db, fields: { key: string; kind: OutageKind; machineId: string | null; label: string; state: string; startedAt: string; confirmedAt: string; endedAt?: string | null; detail: string }): Outage {
  const result = db.prepare("INSERT INTO outages (key, kind, machine_id, label, state, started_at, confirmed_at, ended_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(fields.key, fields.kind, fields.machineId, fields.label, fields.state, fields.startedAt, fields.confirmedAt, fields.endedAt ?? null, fields.detail);
  return outage(db.prepare(`${OUTAGE_SELECT} WHERE id = ?`).get(result.lastInsertRowid) as unknown as OutageRow, fields.confirmedAt);
}

/** Feeds one round of checks into the outage record and returns what changed. Two failures in a row open an outage; the first pass closes it. */
export function recordObservations(db: Db, observations: Observation[], options: { confirmAfter?: number } = {}): OutageChange[] {
  const confirmAfter = options.confirmAfter ?? CONFIRM_AFTER;
  const changes: OutageChange[] = [];
  db.exec("BEGIN");
  try {
    for (const obs of observations) {
      const saved = db.prepare("SELECT key, failures, first_failed_at AS firstFailedAt, last_state AS lastState, last_checked_at AS lastCheckedAt, last_ok_at AS lastOkAt, episodes_json AS episodes FROM watch_state WHERE key = ?").get(obs.key) as WatchRow | undefined;
      // A late or repeated timestamp does not count as a new check.
      if (saved?.lastCheckedAt && Date.parse(obs.at) <= Date.parse(saved.lastCheckedAt)) continue;
      const cutoff = Date.parse(obs.at) - FLAP_WINDOW_MS;
      let episodes = (JSON.parse(saved?.episodes ?? "[]") as string[]).filter((at) => Date.parse(at) > cutoff);
      let failures = saved?.failures ?? 0;
      let firstFailedAt = saved?.firstFailedAt ?? null;
      if (obs.ok) {
        failures = 0;
        firstFailedAt = null;
        const open = openOutage(db, obs.key, obs.at);
        if (open) changes.push({ outage: closeOutage(db, open.id, obs.at), change: "recovered" });
      } else {
        if (failures === 0) {
          firstFailedAt = obs.at;
          episodes.push(obs.at);
        }
        failures += 1;
        if (failures >= confirmAfter) {
          const open = openOutage(db, obs.key, obs.at);
          if (!open) changes.push({ outage: insertOutage(db, { key: obs.key, kind: obs.kind, machineId: obs.machineId, label: obs.label, state: obs.state, startedAt: firstFailedAt ?? obs.at, confirmedAt: obs.at, detail: obs.detail }), change: "confirmed" });
          else if (open.state !== obs.state || open.detail !== obs.detail) {
            db.prepare("UPDATE outages SET state = ?, detail = ?, label = ? WHERE id = ?").run(obs.state, obs.detail, obs.label, open.id);
            if (open.state !== obs.state) changes.push({ outage: { ...open, state: obs.state, detail: obs.detail, label: obs.label, durationMs: Date.parse(obs.at) - Date.parse(open.startedAt) }, change: "updated" });
          }
        }
      }
      // Machines and web addresses that keep failing and recovering get one flapping outage instead of an alert for each episode.
      if (obs.kind !== "service") {
        const flapKey = `${obs.key}:flapping`;
        const open = openOutage(db, flapKey, obs.at);
        if (episodes.length >= FLAP_EPISODES && !open) changes.push({ outage: insertOutage(db, { key: flapKey, kind: "flapping", machineId: obs.machineId, label: obs.label, state: "flapping", startedAt: episodes[0]!, confirmedAt: obs.at, detail: `${episodes.length} failures in the last ${FLAP_WINDOW_MS / 60_000} minutes` }), change: "confirmed" });
        else if (open && episodes.length === 0) changes.push({ outage: closeOutage(db, open.id, obs.at), change: "recovered" });
      }
      db.prepare(`INSERT INTO watch_state (key, kind, machine_id, label, failures, first_failed_at, last_state, last_checked_at, last_ok_at, episodes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, machine_id = excluded.machine_id, label = excluded.label, failures = excluded.failures, first_failed_at = excluded.first_failed_at, last_state = excluded.last_state, last_checked_at = excluded.last_checked_at, last_ok_at = excluded.last_ok_at, episodes_json = excluded.episodes_json`)
        .run(obs.key, obs.kind, obs.machineId, obs.label, failures, firstFailedAt, obs.state, obs.at, obs.ok ? obs.at : saved?.lastOkAt ?? null, JSON.stringify(episodes));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return changes;
}

/** Forgets what is no longer watched (an item switched off or gone): closes its open outage and drops its counters. `keep` lists the keys still watched. */
export function settleUnwatched(db: Db, scope: { kind: WatchKind; machineId: string | null }, keep: ReadonlySet<string>, at: string): OutageChange[] {
  const changes: OutageChange[] = [];
  const where = scope.machineId === null ? "kind = ? AND machine_id IS NULL" : "kind = ? AND machine_id = ?";
  const args = scope.machineId === null ? [scope.kind] : [scope.kind, scope.machineId];
  for (const row of db.prepare(`SELECT key FROM watch_state WHERE ${where}`).all(...args) as { key: string }[]) {
    if (keep.has(row.key)) continue;
    for (const key of [row.key, `${row.key}:flapping`]) {
      const open = openOutage(db, key, at);
      if (open) changes.push({ outage: closeOutage(db, open.id, at, `${open.detail} (no longer watched)`.trim()), change: "recovered" });
    }
    db.prepare("DELETE FROM watch_state WHERE key = ?").run(row.key);
  }
  return changes;
}

/** A hub that came back after a long silence: the stretch it could not watch is logged with its real start and end. */
export function recordMonitorGap(db: Db, startedAt: string, endedAt: string, label: string): OutageChange {
  const key = `monitor-gap:${startedAt}`;
  const existing = db.prepare(`${OUTAGE_SELECT} WHERE key = ?`).get(key) as OutageRow | undefined;
  if (existing) return { outage: outage(existing, endedAt), change: "recovered" };
  return { outage: insertOutage(db, { key, kind: "monitor-gap", machineId: null, label, state: "monitor-gap", startedAt, confirmedAt: endedAt, endedAt, detail: "The hub did not run, so nothing was checked." }), change: "recovered" };
}

/** Each machine's failure counters start again when the hub starts, so a hub restart never counts as a machine failure. */
export function resetWatchCounters(db: Db): void {
  db.exec("UPDATE watch_state SET failures = 0, first_failed_at = NULL WHERE failures > 0");
}

export interface OutagesQuery { state?: "open" | "closed" | "all"; limit?: number; machineId?: string | null; now?: string }

export function listOutages(db: Db, query: OutagesQuery = {}): Outage[] {
  const now = query.now ?? new Date().toISOString();
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (query.state === "open") clauses.push("ended_at IS NULL");
  else if (query.state === "closed") clauses.push("ended_at IS NOT NULL");
  if (query.machineId) { clauses.push("machine_id = ?"); args.push(query.machineId); }
  const limit = query.limit ?? 100;
  const rows = db.prepare(`${OUTAGE_SELECT}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, limit) as unknown as OutageRow[];
  return rows.map((row) => outage(row, now));
}

export interface WatchedItem { key: string; kind: WatchKind; machineId: string | null; label: string; state: string; lastCheckedAt: string | null; failures: number }

/** Every item with checks on record, with whether the current config watches it. The page lists these as switches. */
export function watchedItems(db: Db, config: WatchConfig, now: string): (WatchedItem & { watched: boolean })[] {
  const rows = db.prepare("SELECT key, kind, machine_id AS machineId, label, last_state AS state, last_checked_at AS lastCheckedAt, failures FROM watch_state ORDER BY kind, machine_id, label").all() as unknown as WatchedItem[];
  return rows.map((row) => ({ ...row, watched: isWatched(config, row.kind, row.machineId, row.key, now) }));
}

export function outagesResponse(db: Db, config: WatchConfig, params = new URLSearchParams(), now = new Date().toISOString()) {
  const state = params.get("state") ?? "all";
  if (state !== "open" && state !== "closed" && state !== "all") throw new Error("invalid state");
  const limit = Number(params.get("limit") ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
  const machine = params.get("machine");
  return {
    outages: listOutages(db, { state, limit, machineId: machine, now }),
    open: listOutages(db, { state: "open", limit: 500, now }).length,
    items: watchedItems(db, config, now),
    config: { pausedUntil: config.pausedUntil, machines: config.machines, checks: config.checks, items: config.items, fileError: config.fileError },
    generatedAt: now,
  };
}

/** The text of a notice for one change, plain ASCII, for Discord and the toast. */
export function outageNotice(change: OutageChange): OutageNotice {
  const { outage: row } = change;
  if (row.kind === "monitor-gap") return { title: `Scout was not running: ${row.label}`, body: `Nothing was checked from ${formatLocal(row.startedAt)} to ${formatLocal(row.endedAt ?? row.confirmedAt)} (${formatDuration(row.durationMs)}).`, severity: "info" };
  const what = row.kind === "machine" ? `${row.label} is ${row.state}` : row.kind === "flapping" ? `${row.label} keeps failing and recovering` : row.kind === "url" ? `${row.label} is not answering` : `${row.label} is not running`;
  if (change.change === "recovered") return { title: `Recovered: ${row.label}`, body: `${what.replace(/ is (hung|down|not answering|not running)$/, "")} is back after ${formatDuration(row.durationMs)} (down since ${formatLocal(row.startedAt)}).`, severity: "info" };
  return { title: `Outage: ${what}`, body: `${row.detail || "The check failed twice in a row."} Down since ${formatLocal(row.startedAt)} ${sinceLastCheck(row.lastOkAt, row.confirmedAt)}.`, severity: "high" };
}

// ---- service and listener checks -------------------------------------------------------------------------------------

export function serviceWatchKey(row: Service): string { return `service:${row.machineId}:${row.kind}:${row.domain}:${row.name}`; }
/** The address to connect to for a listener: loopback for a wildcard bind, otherwise the address it is bound to. */
export function listenerEndpoint(row: Pick<Listener, "address" | "bind" | "port">): { host: string; port: number } {
  const address = row.address.replace(/^[(.*)]$/, "$1");
  if (address === "::" ) return { host: "::1", port: row.port };
  if (row.bind === "all" || address === "*" || address === "0.0.0.0") return { host: "127.0.0.1", port: row.port };
  return { host: address, port: row.port };
}

export function listenerWatchKey(row: Listener): string { return `listener:${row.machineId}:${row.port}:${row.processName ?? row.containerName ?? "unknown"}`; }

// Per-connection and per-app launchd jobs and loopback ports in the dynamic range come and go all the time and carry no signal.
function ephemeral(row: Service | Listener): boolean {
  return "port" in row ? row.port >= 49152 && (row.bind === "loopback" || row.containerName === null) : row.kind === "launchd" && /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^application\.|\.\d{4,}\.\d{4,}$/i.test(row.name);
}

/** What the stays-up rule looks at besides the row itself: the services it may belong to and the ports that published routes land on. */
export interface WatchContext { services: Service[]; routeListeners: Set<number>; routePorts: Set<string> }

export function watchContext(db: Db, services: Service[]): WatchContext {
  const saved = db.prepare("SELECT value FROM meta WHERE key = 'alert_routes'").get() as { value: string } | undefined;
  let routes: { listenerId?: number | null; machineId?: string | null; port?: number | null }[] = [];
  try { if (saved) routes = Object.values(JSON.parse(saved.value)); } catch { /* A damaged snapshot means no route evidence until the next evaluation. */ }
  const routeListeners = new Set<number>();
  const routePorts = new Set<string>();
  for (const route of routes) {
    if (typeof route.listenerId === "number") routeListeners.add(route.listenerId);
    if (route.machineId && typeof route.port === "number") routePorts.add(`${route.machineId}:${route.port}`);
  }
  return { services, routeListeners, routePorts };
}

/** A service meant to run all the time: a Windows service that starts automatically or a launchd job that launchd keeps alive. Scheduled tasks and on-demand services run and stop by design. */
function staysUpService(row: Service): boolean {
  if (row.kind === "windows-service") return row.startMode === "auto" || row.startMode === "boot";
  if (row.kind === "launchd") return row.keepAlive === true;
  return false;
}

export function serviceOwnsListener(service: Service, listener: Listener): boolean {
  if (service.machineId !== listener.machineId) return false;
  if (service.pid !== null) return service.pid === listener.pid;
  const same = (path: string): string => path.replaceAll("\\", "/").toLowerCase();
  return service.program !== null && listener.processPath !== null && same(service.program) === same(listener.processPath);
}

/** A listener is meant to stay up when a container serves it, a published route lands on it, or a service that stays up owns it. A browser debug port or a dev server does not qualify. */
function staysUp(row: Service | Listener, context: WatchContext): boolean {
  if (!("port" in row)) return staysUpService(row);
  return row.containerName !== null || context.routeListeners.has(row.id) || context.routePorts.has(`${row.machineId}:${row.port}`) || context.services.some((service) => staysUpService(service) && serviceOwnsListener(service, row));
}

/** Whether an item is one Scout watches for outages: visible, not plumbing, not marked as expected to be down, and (given a context) meant to run at all times. */
export function serviceWatchable(db: Db, row: Service | Listener, context?: WatchContext): boolean {
  if (row.classification.hidden || row.classification.class === "essential" || ephemeral(row)) return false;
  if ("startMode" in row && row.startMode === "manual") return false;
  if (context && !staysUp(row, context)) return false;
  const table = "port" in row ? "listeners" : "services";
  return (db.prepare(`SELECT expected_down AS value FROM ${table} WHERE id = ?`).get(row.id) as { value: number } | undefined)?.value !== 1;
}

/**
 * One check for each watchable service and listener on a machine, from the catalog as the latest fresh read left it. An item that has never been
 * seen running is not checked at all, so a service that was never started does not become an outage.
 */
export function serviceObservations(db: Db, machineId: string, config: WatchConfig, at: string): Observation[] {
  const descriptions = loadDescriptionResolver(db, { hints: [] });
  const proven = new Set((db.prepare("SELECT key FROM watch_state WHERE machine_id = ? AND kind = 'service' AND last_state = 'up'").all(machineId) as { key: string }[]).map((row) => row.key));
  const failing = new Set((db.prepare("SELECT key FROM watch_state WHERE machine_id = ? AND kind = 'service' AND failures > 0").all(machineId) as { key: string }[]).map((row) => row.key));
  const out: Observation[] = [];
  const add = (key: string, label: string, running: boolean, detail: string, endpoint?: { host: string; port: number }): void => {
    if (!isWatched(config, "service", machineId, key, at)) return;
    if (!running && !proven.has(key) && !failing.has(key)) return;
    out.push({ key, kind: "service", machineId, label, ok: running, state: running ? "up" : "not-running", detail, at, ...(endpoint ? { endpoint } : {}) });
  };
  const services = listServices(db, { machine: machineId }, descriptions);
  const context = watchContext(db, services);
  // A watch switch set to true in the watch file names an item that stays up even though the rule would skip it.
  const forced = (key: string): boolean => config.items[key] === true;
  for (const row of services) {
    if (!forced(serviceWatchKey(row)) && !serviceWatchable(db, row, context)) continue;
    add(serviceWatchKey(row), `${row.displayName ?? row.name} on ${row.machineName}`, row.goneAt === null && row.state === "running", row.goneAt ? "The service is gone." : `The service state is ${row.state}.`);
  }
  for (const row of listListeners(db, { machine: machineId }, descriptions)) {
    if (!forced(listenerWatchKey(row)) && !serviceWatchable(db, row, context)) continue;
    add(listenerWatchKey(row), `Port ${row.port} (${row.processName ?? row.containerName ?? "unknown"}) on ${row.machineName}`, row.goneAt === null, "Nothing is listening on the port.", listenerEndpoint(row));
  }
  return out;
}

/** The keys of every item the current config watches, for a machine, so `settleUnwatched` can close what was switched off. */
export function watchedKeys(observations: readonly Observation[]): Set<string> {
  return new Set(observations.map((obs) => obs.key));
}

// ---- web addresses ---------------------------------------------------------------------------------------------------

/**
 * One check for each public hostname the health probes cover, taken from the latest probe. The health cycle already counts failures, so the
 * probe's own time is the check time: a probe read twice is one check. Unproven hostnames (`not-http`, `unknown`) are left out like they are for alerts, and so is a hostname that has never answered a probe: like a service never seen running, it cannot have gone down.
 */
export function urlObservations(db: Db, config: WatchConfig, at: string): Observation[] {
  const rows = db.prepare("SELECT label, state, last_probe_at AS probedAt, last_error AS error FROM health_targets WHERE kind = 'domain' AND gone_at IS NULL AND last_probe_at IS NOT NULL AND last_ok_at IS NOT NULL").all() as { label: string; state: string; probedAt: string; error: string | null }[];
  const out: Observation[] = [];
  for (const row of rows) {
    if (row.state === "not-http" || row.state === "unknown") continue;
    const key = `url:${row.label}`;
    if (!isWatched(config, "url", null, key, at)) continue;
    const ok = row.state === "up" || row.state === "slow";
    out.push({ key, kind: "url", machineId: null, label: row.label, ok, state: ok ? "up" : "unhealthy", detail: `${row.label} did not answer (${row.error ?? "connection error"}).`, at: row.probedAt });
  }
  return out;
}
