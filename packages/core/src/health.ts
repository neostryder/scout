import { hubMachineId } from "./hub.ts";
import type { Db } from "./db.ts";
import { listListeners } from "./listeners.ts";
import { listRoutes, type RouteRow } from "./cloudflare.ts";
import { listServices, type Service } from "./services.ts";
import { loadDescriptionResolver } from "./descriptions.ts";
import type { Alert } from "./alerts.ts";
import { sinceLastCheck } from "./time.ts";

export const HEALTH_STATES = ["up", "slow", "down", "failing", "not-http", "unknown"] as const;
export type HealthState = typeof HEALTH_STATES[number];
export type HealthKind = "domain" | "listener";
export interface HealthIdentity {
  key: string;
  kind: HealthKind;
  label: string;
  machineId: string | null;
  port: number | null;
  url: string;
}
export interface HealthSample {
  at: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
  tlsNotAfter: string | null;
  notHttp?: boolean;
}
export interface HealthRow {
  key: string;
  state: HealthState;
  latencyMs: number | null;
  lastOkAt: string | null;
  failures: number;
  tlsDaysLeft: number | null;
}
export interface HealthTarget extends HealthIdentity, HealthRow {
  status: number | null;
  lastProbeAt: string | null;
  error: string | null;
  tlsNotAfter: string | null;
}
export interface HealthProbeStatus {
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  intervalSeconds: number;
}
export interface HealthChange { target: HealthTarget; change: "state" | "sample" | "tls" }
export interface HealthProgress { running: boolean; done: number; total: number }
export type HealthNotice = { kind: "health"; data: HealthChange } | { kind: "health-run"; data: HealthProgress };

const SELECT = `SELECT key, kind, label, machine_id AS machineId, port, url, state, failures,
  last_ok_at AS lastOkAt, last_probe_at AS lastProbeAt, last_status AS status,
  last_latency_ms AS latencyMs, last_error AS error, tls_not_after AS tlsNotAfter FROM health_targets`;
const ORDER: Record<HealthState, number> = { down: 0, failing: 1, slow: 2, unknown: 3, up: 4, "not-http": 5 };
const DAY_MS = 86_400_000;

export function tlsDaysLeft(notAfter: string | null, now: string): number | null {
  if (notAfter === null || !Number.isFinite(Date.parse(notAfter))) return null;
  return Math.ceil((Date.parse(notAfter) - Date.parse(now)) / DAY_MS);
}

export function healthDomain(hostname: string): boolean {
  return hostname.length <= 253 && hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/** Listings one alert evaluation already holds, so the health pass does not read and classify the same rows again. */
export interface SharedListings { descriptions?: ReturnType<typeof loadDescriptionResolver>; routes?: RouteRow[]; services?: Service[] }

export function buildHealthTargets(db: Db, tunnelHosts: Record<string, string> = {}, shared: SharedListings = {}): HealthIdentity[] {
  const targets = new Map<string, HealthIdentity>();
  const descriptions = shared.descriptions ?? loadDescriptionResolver(db, { hints: [] });
  for (const row of shared.routes ?? listRoutes(db, { tunnelHosts }, descriptions)) {
    if (!healthDomain(row.hostname)) continue;
    const key = `domain:${row.hostname}`;
    if (!targets.has(key)) targets.set(key, { key, kind: "domain", label: row.hostname, machineId: row.machineId, port: null, url: `https://${row.hostname}/` });
  }
  for (const row of listListeners(db, { machine: hubMachineId(), state: "present", includeHidden: false }, descriptions)) {
    if (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535) continue;
    const key = `listener:${hubMachineId()}:${row.port}`;
    targets.set(key, { key, kind: "listener", label: `${row.processName ?? row.containerName ?? "listener"}:${row.port}`, machineId: hubMachineId(), port: row.port, url: `http://127.0.0.1:${row.port}/` });
  }
  const paused = new Set((db.prepare("SELECT id FROM machines WHERE state = 'paused'").all() as { id: string }[]).map((row) => row.id));
  return [...targets.values()].filter((target) => target.machineId === null || !paused.has(target.machineId));
}

export function syncHealthTargets(db: Db, now: string, tunnelHosts: Record<string, string> = {}): HealthIdentity[] {
  const targets = buildHealthTargets(db, tunnelHosts);
  const gone = new Set((db.prepare("SELECT key FROM health_targets WHERE gone_at IS NOT NULL").all() as { key: string }[]).map((row) => row.key));
  db.exec("SAVEPOINT health_targets_sync");
  try {
    db.prepare("UPDATE health_targets SET gone_at = COALESCE(gone_at, ?)").run(now);
    const put = db.prepare(`INSERT INTO health_targets (key, kind, label, machine_id, port, url) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET label = excluded.label, machine_id = excluded.machine_id, url = excluded.url,
        failures = CASE WHEN ? THEN 0 ELSE failures END,
        state = CASE WHEN ? THEN 'unknown' ELSE state END, gone_at = NULL`);
    for (const target of targets) put.run(target.key, target.kind, target.label, target.machineId, target.port, target.url, gone.has(target.key) ? 1 : 0, gone.has(target.key) ? 1 : 0);
    db.exec("RELEASE health_targets_sync");
  } catch (error) { db.exec("ROLLBACK TO health_targets_sync"); db.exec("RELEASE health_targets_sync"); throw error; }
  return targets;
}

export function resetHealthFailures(db: Db): void {
  // A new process must observe its own consecutive failures before it raises an unhealthy alert.
  db.exec("UPDATE health_targets SET failures = 0, state = 'unknown' WHERE failures > 0");
}

export function healthTarget(db: Db, key: string, now = new Date().toISOString()): HealthTarget | null {
  const row = db.prepare(`${SELECT} WHERE key = ? AND gone_at IS NULL`).get(key) as unknown as Omit<HealthTarget, "tlsDaysLeft"> | undefined;
  return row ? { ...row, tlsDaysLeft: tlsDaysLeft(row.tlsNotAfter, now) } : null;
}

export function healthRow(db: Db, key: string, now = new Date().toISOString()): HealthRow {
  const target = healthTarget(db, key, now);
  return { key, state: target?.state ?? "unknown", latencyMs: target?.latencyMs ?? null, lastOkAt: target?.lastOkAt ?? null, failures: target?.failures ?? 0, tlsDaysLeft: target?.tlsDaysLeft ?? null };
}

/** Failed probes in a row that make a target down; the outage watch confirms an outage after the same number of checks. */
export const HEALTH_DOWN_AFTER = 2;

export function healthState(sample: HealthSample, previousFailures: number): { state: HealthState; failures: number } {
  if (sample.notHttp) return { state: "not-http", failures: 0 };
  if (sample.ok) return { state: (sample.latencyMs ?? 0) > 2000 ? "slow" : "up", failures: 0 };
  const failures = previousFailures + 1;
  return { state: failures >= HEALTH_DOWN_AFTER ? "down" : "failing", failures };
}

export function storeHealthSample(db: Db, key: string, sample: HealthSample): HealthChange | null {
  const before = healthTarget(db, key, sample.at);
  if (!before) return null;
  // A port, or a DNS-only record (mail, VPN, a registrar page), that never answered is not a web service, so its refusals and timeouts are not failures.
  const unproven = !sample.ok && !before.lastOkAt && (before.kind === "listener" || !db.prepare("SELECT 1 FROM cf_dns WHERE lower(name) = lower(?) AND proxied = 1 LIMIT 1").get(before.label));
  const next = unproven ? { state: "not-http" as const, failures: 0 } : healthState(sample, before.failures);
  db.exec("SAVEPOINT health_sample");
  try {
    db.prepare("INSERT INTO health_samples (target_key, kind, at, ok, status, latency_ms, error, tls_not_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(key, before.kind, sample.at, sample.ok ? 1 : 0, sample.status, sample.latencyMs, sample.error, sample.tlsNotAfter);
    db.prepare(`UPDATE health_targets SET state = ?, failures = ?, last_ok_at = ?, last_probe_at = ?, last_status = ?, last_latency_ms = ?, last_error = ?, tls_not_after = ? WHERE key = ?`).run(next.state, next.failures, sample.ok ? sample.at : before.lastOkAt, sample.at, sample.status, sample.latencyMs, sample.error, sample.tlsNotAfter ?? before.tlsNotAfter, key);
    db.exec("RELEASE health_sample");
  } catch (error) { db.exec("ROLLBACK TO health_sample"); db.exec("RELEASE health_sample"); throw error; }
  const target = healthTarget(db, key, sample.at)!;
  if (before.state !== target.state) return { target, change: "state" };
  if (before.tlsNotAfter !== target.tlsNotAfter) return { target, change: "tls" };
  return null;
}

export function retainHealthSamples(db: Db, now: string): void {
  db.prepare("DELETE FROM health_samples WHERE at < ?").run(new Date(Date.parse(now) - 7 * DAY_MS).toISOString());
  db.exec(`DELETE FROM health_samples WHERE id IN (SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY target_key ORDER BY at DESC, id DESC) AS position FROM health_samples
  ) WHERE position > 2016)`);
}

export function healthResponse(db: Db, params = new URLSearchParams(), now = new Date().toISOString(), probe?: HealthProbeStatus, tunnelHosts: Record<string, string> = {}) {
  const state = params.get("state") ?? "all";
  const kind = params.get("kind") ?? "all";
  if (state !== "all" && !(HEALTH_STATES as readonly string[]).includes(state)) throw new Error("invalid state");
  if (!["all", "domain", "listener"].includes(kind)) throw new Error("invalid kind");
  const counts: Record<HealthState, number> = { up: 0, slow: 0, failing: 0, down: 0, "not-http": 0, unknown: 0 };
  const rows = buildHealthTargets(db, tunnelHosts).map((identity): HealthTarget => ({ ...healthTarget(db, identity.key, now) ?? { state: "unknown", failures: 0, lastOkAt: null, lastProbeAt: null, status: null, latencyMs: null, error: null, tlsNotAfter: null, tlsDaysLeft: null }, ...identity }));
  for (const row of rows) counts[row.state]++;
  const history = db.prepare("SELECT at, ok, latency_ms AS latencyMs, status FROM health_samples WHERE target_key = ? ORDER BY at DESC, id DESC LIMIT 60");
  const targets = rows.filter((row) => (state === "all" || row.state === state) && (kind === "all" || row.kind === kind))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.label.localeCompare(b.label))
    .map((row) => ({ ...row, history: (history.all(row.key) as { at: string; ok: number; latencyMs: number | null; status: number | null }[]).reverse().map((sample) => ({ ...sample, ok: sample.ok !== 0 })) }));
  const lastRunAt = (db.prepare("SELECT value FROM meta WHERE key = 'health_last_run'").get() as { value: string } | undefined)?.value ?? null;
  return { targets, counts, probe: probe ?? { running: false, lastRunAt, nextRunAt: null, intervalSeconds: 300 }, generatedAt: now };
}

export function healthSummary(db: Db, now = new Date().toISOString(), tunnelHosts: Record<string, string> = {}) {
  const { targets, counts } = healthResponse(db, new URLSearchParams(), now, undefined, tunnelHosts);
  return { down: counts.down, failing: counts.failing, expiring: targets.filter((target) => target.kind === "domain" && target.tlsDaysLeft !== null && target.tlsDaysLeft <= 14).length };
}

export type HealthAlertCandidate = Omit<Alert, "id" | "state" | "acknowledgedAt" | "resolvedAt" | "muted"> & { condition: { healthKey?: string; hostname?: string } };

export function healthAlertCandidates(db: Db, now: string, tunnelHosts: Record<string, string> = {}, shared: SharedListings = {}): HealthAlertCandidate[] {
  const candidates: HealthAlertCandidate[] = [];
  const names = new Map((db.prepare("SELECT id, name FROM machines").all() as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  for (const identity of buildHealthTargets(db, tunnelHosts, shared)) {
    const target = healthTarget(db, identity.key, now);
    if (!target || target.state === "not-http") continue;
    const base = { at: now, machineId: identity.machineId, machineName: names.get(identity.machineId ?? "") ?? null, target: { type: identity.kind === "domain" ? "route" as const : "listener" as const, id: identity.kind === "listener" ? (db.prepare("SELECT id FROM listeners WHERE machine_id = ? AND port = ? AND gone_at IS NULL ORDER BY id LIMIT 1").get(hubMachineId(), identity.port!) as { id: number } | undefined)?.id ?? null : null }, condition: { healthKey: target.key, ...(identity.kind === "domain" ? { hostname: identity.label } : {}) } };
    if (target.state === "down") candidates.push({ ...base, kind: "unhealthy", key: `unhealthy:${target.key}`, severity: target.kind === "domain" ? "high" : "warn", title: `Unhealthy endpoint: ${target.label}`, detail: `${target.label} has not answered for ${target.failures} checks (${target.error ?? "connection error"}) ${sinceLastCheck(target.lastOkAt, now)}.` });
    if (target.kind === "domain" && target.tlsDaysLeft !== null && target.tlsDaysLeft <= 14) candidates.push({ ...base, kind: "cert-expiring", key: `cert-expiring:${target.label}`, severity: target.tlsDaysLeft <= 3 ? "high" : "warn", title: `Certificate expiring: ${target.label}`, detail: `The certificate for ${target.label} ends in ${target.tlsDaysLeft} days` });
  }
  const since = new Date(Date.parse(now) - 30 * 60_000).toISOString();
  const flips = new Map<string, number>();
  for (const event of db.prepare("SELECT machine_id AS machineId, detail_json AS detail FROM events WHERE kind IN ('service_changed','service_gone') AND at >= ? AND at <= ?").all(since, now) as { machineId: string; detail: string }[]) {
    let detail;
    try { detail = JSON.parse(event.detail); } catch { continue; }
    if (!detail || detail.old?.state !== "running" || detail.new?.state === "running" || typeof detail.name !== "string" || (detail.new !== null && typeof detail.new?.state !== "string")) continue;
    const key = JSON.stringify([event.machineId, detail.kind, detail.domain, detail.name]);
    flips.set(key, (flips.get(key) ?? 0) + 1);
  }
  for (const row of shared.services?.filter((service) => service.goneAt === null) ?? listServices(db, { gone: "present" }, shared.descriptions ?? loadDescriptionResolver(db, { hints: [] }))) {
    const count = flips.get(JSON.stringify([row.machineId, row.kind, row.domain, row.name])) ?? 0;
    // On-demand and system plumbing services start and stop by design, so only a service meant to stay up counts.
    if (count < 3 || row.startMode === "manual" || row.classification.hidden || row.classification.class === "essential") continue;
    const key = `crash-loop:${row.machineId}:${row.name}`;
    if (candidates.some((candidate) => candidate.key === key)) continue;
    candidates.push({ at: now, kind: "crash-loop", key, severity: "warn", machineId: row.machineId, machineName: row.machineName, target: { type: "service", id: row.id }, title: `Service crash loop: ${row.name}`, detail: `${row.name} restarted ${count} times in 30 minutes`, condition: {} });
  }
  return candidates;
}
