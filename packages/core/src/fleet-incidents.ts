import type { Db } from "./db.ts";
import { heartbeatMetaKey } from "./fleet-expected.ts";
import { isFalseAlarm, type FailureClass, type IncidentPacket, type Severity } from "./fleet-packet.ts";
import { redactPacket } from "./fleet-redact.ts";

export interface QuietHours { start: string; end: string; timezone: string }

export interface FleetPolicy {
  quietHours: QuietHours;
  escalateAfterMinutes: number;
  escalateEveryMinutes: number;
  flapReopens: number;
  flapWindowMinutes: number;
  flapQuietMinutes: number;
}

export const DEFAULT_FLEET_POLICY: FleetPolicy = {
  quietHours: { start: "22:00", end: "07:00", timezone: "-07:00" },
  escalateAfterMinutes: 30,
  escalateEveryMinutes: 120,
  flapReopens: 3,
  flapWindowMinutes: 60,
  flapQuietMinutes: 60,
};

export interface FleetIncident {
  id: number;
  fingerprint: string;
  host: string;
  component: string;
  severity: Severity;
  failureClass: FailureClass;
  state: "open" | "acknowledged" | "resolved";
  firstSeen: string;
  lastSeen: string;
  count: number;
  summary: string;
  packet: IncidentPacket;
  ownerChat: string | null;
  runbook: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  snoozedUntil: string | null;
  muted: boolean;
  lastNotifiedAt: string | null;
  notifyCount: number;
  flapCount: number;
}

export interface FleetDecision {
  kind: "notify-now" | "digest" | "recovered" | "escalate" | "suppressed";
  incident: FleetIncident;
  reason: string;
}

export interface FleetDigest {
  at: string;
  groups: { host: string; count: number; incidents: FleetIncident[] }[];
}

export interface IncidentFilter {
  state?: FleetIncident["state"];
  host?: string;
  failureClass?: string;
  limit?: number;
}

interface Stored extends Omit<FleetIncident, "muted" | "packet"> { packetJson: string; muted: number }

const SELECT = `SELECT id, fingerprint, host, component, severity, failure_class AS failureClass, state,
  first_seen AS firstSeen, last_seen AS lastSeen, count, summary, packet_json AS packetJson,
  owner_chat AS ownerChat, runbook, opened_at AS openedAt, acknowledged_at AS acknowledgedAt,
  resolved_at AS resolvedAt, snoozed_until AS snoozedUntil, muted, last_notified_at AS lastNotifiedAt,
  notify_count AS notifyCount, flap_count AS flapCount FROM fleet_incidents`;

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

export function resolvePolicy(partial?: Partial<FleetPolicy> | null): FleetPolicy {
  const quiet = partial?.quietHours;
  return {
    quietHours: {
      start: quiet?.start ?? DEFAULT_FLEET_POLICY.quietHours.start,
      end: quiet?.end ?? DEFAULT_FLEET_POLICY.quietHours.end,
      timezone: quiet?.timezone ?? DEFAULT_FLEET_POLICY.quietHours.timezone,
    },
    escalateAfterMinutes: partial?.escalateAfterMinutes ?? DEFAULT_FLEET_POLICY.escalateAfterMinutes,
    escalateEveryMinutes: partial?.escalateEveryMinutes ?? DEFAULT_FLEET_POLICY.escalateEveryMinutes,
    flapReopens: partial?.flapReopens ?? DEFAULT_FLEET_POLICY.flapReopens,
    flapWindowMinutes: partial?.flapWindowMinutes ?? DEFAULT_FLEET_POLICY.flapWindowMinutes,
    flapQuietMinutes: partial?.flapQuietMinutes ?? DEFAULT_FLEET_POLICY.flapQuietMinutes,
  };
}

export function quietMinutes(now: Date, timezone: string): number {
  let offset = 0;
  if (timezone === "local") offset = -now.getTimezoneOffset();
  else {
    const match = OFFSET.exec(timezone);
    if (match) offset = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  }
  const zoned = new Date(now.getTime() + offset * 60_000);
  return zoned.getUTCHours() * 60 + zoned.getUTCMinutes();
}

export function inQuietHours(now: Date, quiet: QuietHours): boolean {
  const startMatch = HM.exec(quiet.start);
  const endMatch = HM.exec(quiet.end);
  if (!startMatch || !endMatch) return false;
  const start = Number(startMatch[1]) * 60 + Number(startMatch[2]);
  const end = Number(endMatch[1]) * 60 + Number(endMatch[2]);
  if (start === end) return false;
  const minutes = quietMinutes(now, quiet.timezone);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function ruleKey(host: string, component: string, failureClass: string): string {
  return `${host}/${component}/${failureClass}`;
}

function glob(match: string, key: string): boolean {
  const pattern = match.split("*").map((part) => part.split("?").map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*");
  return new RegExp(`^${pattern}$`, "s").test(key);
}

function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction is already closed */ }
    throw error;
  }
}

function toIncident(row: Stored): FleetIncident {
  const { packetJson, muted, ...rest } = row;
  return { ...rest, muted: muted !== 0, packet: JSON.parse(packetJson) as IncidentPacket };
}

function load(db: Db, id: number): FleetIncident | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Stored | undefined;
  return row ? toIncident(row) : null;
}

export function incidentById(db: Db, id: number): FleetIncident | null {
  return load(db, id);
}

export function incidentByFingerprint(db: Db, fp: string): FleetIncident | null {
  const row = db.prepare(`${SELECT} WHERE fingerprint = ?`).get(fp) as Stored | undefined;
  return row ? toIncident(row) : null;
}

export function listIncidents(db: Db, filter: IncidentFilter = {}): FleetIncident[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.state) { where.push("state = ?"); params.push(filter.state); }
  if (filter.host) { where.push("host = ?"); params.push(filter.host); }
  if (filter.failureClass) { where.push("failure_class = ?"); params.push(filter.failureClass); }
  const limit = filter.limit ?? 50;
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_seen DESC, id DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, limit) as unknown as Stored[]).map(toIncident);
}

function event(db: Db, incidentId: number | null, at: string, kind: string, detail = ""): void {
  db.prepare("INSERT INTO fleet_events (incident_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(incidentId, at, kind, detail);
}

function mutedRule(db: Db, host: string, component: string, failureClass: string): boolean {
  const key = ruleKey(host, component, failureClass);
  const rules = db.prepare("SELECT rule_key FROM fleet_rules").all() as { rule_key: string }[];
  return rules.some((rule) => glob(rule.rule_key, key));
}

function refreshMuted(db: Db): void {
  const rows = db.prepare("SELECT id, host, component, failure_class AS failureClass FROM fleet_incidents").all() as { id: number; host: string; component: string; failureClass: string }[];
  const update = db.prepare("UPDATE fleet_incidents SET muted = ? WHERE id = ?");
  for (const row of rows) update.run(mutedRule(db, row.host, row.component, row.failureClass) ? 1 : 0, row.id);
}

function inFuture(until: string | null, now: string): boolean {
  if (!until) return false;
  const left = Date.parse(until);
  const right = Date.parse(now);
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}

function later(a: string, b: string): string {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left)) return b;
  if (!Number.isFinite(right)) return a;
  return left >= right ? a : b;
}

function dataAtRisk(packet: IncidentPacket): boolean {
  return packet.failureClass === "resources" || packet.evidence.snapshot?.dataAtRisk === true;
}

function interrupts(packet: IncidentPacket, quiet: boolean): boolean {
  if (packet.failureClass === "dead" || packet.failureClass === "wedged") return true;
  if (packet.severity !== "critical") return false;
  if (!quiet) return true;
  return dataAtRisk(packet);
}

function route(packet: IncidentPacket, now: string, policy: FleetPolicy): { kind: "notify-now" | "digest"; reason: string } {
  const quiet = inQuietHours(new Date(now), policy.quietHours);
  if (interrupts(packet, quiet)) return { kind: "notify-now", reason: "critical" };
  if (packet.severity === "critical") return { kind: "digest", reason: "quiet-hours" };
  return { kind: "digest", reason: packet.severity };
}

function markNotified(db: Db, id: number, now: string): void {
  db.prepare("UPDATE fleet_incidents SET last_notified_at = ?, notify_count = notify_count + 1 WHERE id = ?").run(now, id);
}

function finish(db: Db, id: number, now: string, kind: FleetDecision["kind"], reason: string): FleetDecision {
  if (kind === "notify-now" || kind === "recovered" || kind === "escalate" || reason === "flapping") markNotified(db, id, now);
  if (kind === "digest") event(db, id, now, "digest-pending");
  if (kind === "suppressed") event(db, id, now, "suppressed", reason);
  const incident = load(db, id);
  if (!incident) throw new Error("fleet incident disappeared");
  return { kind, incident, reason };
}

function insertIncident(db: Db, packet: IncidentPacket, now: string, flapCount: number): number {
  const muted = mutedRule(db, packet.host, packet.component, packet.failureClass);
  const inserted = db.prepare(`INSERT INTO fleet_incidents (
    fingerprint, host, component, severity, failure_class, state, first_seen, last_seen, count, summary, packet_json,
    owner_chat, runbook, opened_at, muted, notify_count, flap_count
  ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    packet.fingerprint, packet.host, packet.component, packet.severity, packet.failureClass,
    packet.firstSeen, packet.lastSeen, packet.count, packet.summary, JSON.stringify(packet),
    packet.ownerChat, packet.runbook, now, muted ? 1 : 0, flapCount,
  );
  return Number(inserted.lastInsertRowid);
}

function writeOpen(db: Db, incident: FleetIncident, packet: IncidentPacket, now: string, flapCount: number): void {
  const muted = mutedRule(db, packet.host, packet.component, packet.failureClass) ? 1 : 0;
  db.prepare(`UPDATE fleet_incidents SET state = 'open', resolved_at = NULL, acknowledged_at = NULL, opened_at = ?,
    last_seen = ?, count = ?, summary = ?, packet_json = ?, severity = ?, owner_chat = ?, runbook = ?, flap_count = ?, muted = ?
    WHERE id = ?`).run(
    now, later(incident.lastSeen, packet.lastSeen), incident.count + 1, packet.summary, JSON.stringify(packet),
    packet.severity, packet.ownerChat, packet.runbook, flapCount, muted, incident.id,
  );
}

function countReopens(db: Db, id: number, now: string, policy: FleetPolicy): number {
  const windowStart = new Date(Date.parse(now) - policy.flapWindowMinutes * 60_000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM fleet_events
    WHERE incident_id = ? AND kind = 'reopen' AND at >= ?
      AND id > COALESCE((SELECT MAX(id) FROM fleet_events WHERE incident_id = ? AND kind = 'flap-clear'), 0)`).get(id, windowStart, id) as { n: number };
  return row.n;
}

function dueEscalation(db: Db, incident: FleetIncident, now: string, policy: FleetPolicy): boolean {
  const opened = Date.parse(incident.openedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(opened) || !Number.isFinite(at)) return false;
  const last = db.prepare("SELECT at FROM fleet_events WHERE incident_id = ? AND kind = 'escalate' AND at >= ? ORDER BY at DESC LIMIT 1").get(incident.id, incident.openedAt) as { at: string } | undefined;
  if (!last) return at - opened >= policy.escalateAfterMinutes * 60_000;
  const previous = Date.parse(last.at);
  return Number.isFinite(previous) && at - previous >= policy.escalateEveryMinutes * 60_000;
}

function maybeEscalate(db: Db, incident: FleetIncident, now: string, policy: FleetPolicy): FleetDecision | null {
  if (incident.flapCount >= policy.flapReopens) return null;
  if (incident.state !== "open" || incident.severity !== "critical" || incident.acknowledgedAt) return null;
  if (inFuture(incident.snoozedUntil, now) || mutedRule(db, incident.host, incident.component, incident.failureClass)) return null;
  if (!dueEscalation(db, incident, now, policy)) return null;
  event(db, incident.id, now, "escalate");
  return finish(db, incident.id, now, "escalate", "unacknowledged");
}

function openNew(db: Db, packet: IncidentPacket, now: string, policy: FleetPolicy): FleetDecision {
  const id = insertIncident(db, packet, now, 0);
  event(db, id, now, "opened");
  if (mutedRule(db, packet.host, packet.component, packet.failureClass)) return finish(db, id, now, "suppressed", "muted");
  const chosen = route(packet, now, policy);
  return finish(db, id, now, chosen.kind, chosen.reason);
}

function bumpOpen(db: Db, incident: FleetIncident, packet: IncidentPacket, now: string): FleetIncident {
  const muted = mutedRule(db, packet.host, packet.component, packet.failureClass) ? 1 : 0;
  db.prepare(`UPDATE fleet_incidents SET last_seen = ?, count = ?, summary = ?, packet_json = ?, severity = ?, owner_chat = ?, runbook = ?, muted = ? WHERE id = ?`).run(
    later(incident.lastSeen, packet.lastSeen), incident.count + 1, packet.summary, JSON.stringify(packet),
    packet.severity, packet.ownerChat, packet.runbook, muted, incident.id,
  );
  const loaded = load(db, incident.id);
  if (!loaded) throw new Error("fleet incident disappeared");
  return loaded;
}

function reopen(db: Db, incident: FleetIncident, packet: IncidentPacket, now: string, policy: FleetPolicy): FleetDecision[] {
  const resolvedFor = Date.parse(now) - Date.parse(incident.resolvedAt ?? "");
  const latched = incident.flapCount >= policy.flapReopens;
  if (latched && resolvedFor < policy.flapQuietMinutes * 60_000) {
    writeOpen(db, incident, packet, now, incident.flapCount);
    event(db, incident.id, now, "reopen");
    return [];
  }
  if (latched) event(db, incident.id, now, "flap-clear");
  writeOpen(db, incident, packet, now, 0);
  event(db, incident.id, now, "reopen");
  const flaps = countReopens(db, incident.id, now, policy);
  db.prepare("UPDATE fleet_incidents SET flap_count = ? WHERE id = ?").run(flaps, incident.id);
  if (flaps >= policy.flapReopens) return [finish(db, incident.id, now, "suppressed", "flapping")];
  if (mutedRule(db, packet.host, packet.component, packet.failureClass)) return [finish(db, incident.id, now, "suppressed", "muted")];
  if (inFuture(incident.snoozedUntil, now)) return [finish(db, incident.id, now, "suppressed", "snoozed")];
  const chosen = route(packet, now, policy);
  return [finish(db, incident.id, now, chosen.kind, chosen.reason)];
}

function resolveIncident(db: Db, incident: FleetIncident, packet: IncidentPacket, now: string): FleetDecision {
  db.prepare(`UPDATE fleet_incidents SET state = 'resolved', resolved_at = ?, last_seen = ?, count = ?, summary = ?, packet_json = ?, severity = ? WHERE id = ?`).run(
    now, later(incident.lastSeen, packet.lastSeen), incident.count + 1, packet.summary, JSON.stringify(packet), packet.severity, incident.id,
  );
  event(db, incident.id, now, "resolved");
  return finish(db, incident.id, now, "recovered", "recovered");
}

function ingestInner(db: Db, packet: IncidentPacket, now: string, policy: FleetPolicy): FleetDecision[] {
  if (isFalseAlarm(packet)) return [];
  if (packet.evidence.snapshot?.heartbeat === true) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(heartbeatMetaKey(packet.host, packet.component), packet.lastSeen);
    return [];
  }
  const existing = incidentByFingerprint(db, packet.fingerprint);
  if (packet.recovered) {
    if (!existing || existing.state === "resolved") return [];
    return [resolveIncident(db, existing, packet, now)];
  }
  if (!existing) return [openNew(db, packet, now, policy)];
  if (existing.state === "resolved") return reopen(db, existing, packet, now, policy);
  const bumped = bumpOpen(db, existing, packet, now);
  const escalated = maybeEscalate(db, bumped, now, policy);
  return escalated ? [escalated] : [];
}

export function ingest(db: Db, packet: IncidentPacket, now: string, policy?: Partial<FleetPolicy> | null): FleetDecision[] {
  const redacted = redactPacket(packet);
  return transaction(db, () => ingestInner(db, redacted, now, resolvePolicy(policy)));
}

export function sweepEscalations(db: Db, now: string, policy?: Partial<FleetPolicy> | null): FleetDecision[] {
  const resolved = resolvePolicy(policy);
  return transaction(db, () => {
    const rows = db.prepare("SELECT id FROM fleet_incidents WHERE state = 'open' AND severity = 'critical' AND acknowledged_at IS NULL ORDER BY id").all() as { id: number }[];
    const decisions: FleetDecision[] = [];
    for (const row of rows) {
      const incident = load(db, row.id);
      if (!incident) continue;
      const decision = maybeEscalate(db, incident, now, resolved);
      if (decision) decisions.push(decision);
    }
    return decisions;
  });
}

export function digest(db: Db, now: string, _policy?: Partial<FleetPolicy> | null): FleetDigest {
  return transaction(db, () => {
    const rows = db.prepare(`SELECT id FROM fleet_incidents AS i WHERE EXISTS (
      SELECT 1 FROM fleet_events AS e WHERE e.incident_id = i.id AND e.kind = 'digest-pending'
        AND e.id > COALESCE((SELECT MAX(d.id) FROM fleet_events AS d WHERE d.incident_id = i.id AND d.kind = 'digest-included'), 0)
    ) ORDER BY host, opened_at, id`).all() as { id: number }[];
    const incidents: FleetIncident[] = [];
    for (const row of rows) {
      const incident = load(db, row.id);
      if (!incident) continue;
      event(db, incident.id, now, "digest-included");
      markNotified(db, incident.id, now);
      const updated = load(db, incident.id);
      if (updated) incidents.push(updated);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('fleet_digest_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now);
    const grouped = new Map<string, FleetIncident[]>();
    for (const incident of incidents) {
      const list = grouped.get(incident.host) ?? [];
      list.push(incident);
      grouped.set(incident.host, list);
    }
    const groups = [...grouped.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([host, items]) => ({ host, count: items.length, incidents: items }));
    return { at: now, groups };
  });
}

export function acknowledge(db: Db, id: number, now: string): FleetIncident | null {
  return transaction(db, () => {
    const incident = load(db, id);
    if (!incident) return null;
    if (incident.state !== "open") return incident;
    db.prepare("UPDATE fleet_incidents SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?").run(now, id);
    event(db, id, now, "acknowledged");
    return load(db, id);
  });
}

export function snooze(db: Db, id: number, until: string, now: string): FleetIncident | null {
  return transaction(db, () => {
    const incident = load(db, id);
    if (!incident) return null;
    db.prepare("UPDATE fleet_incidents SET snoozed_until = ? WHERE id = ?").run(until, id);
    event(db, id, now, "snoozed", until);
    return load(db, id);
  });
}

export function muteRule(db: Db, key: string, reason: string, now: string): void {
  transaction(db, () => {
    db.prepare("INSERT INTO fleet_rules (rule_key, muted_at, reason) VALUES (?, ?, ?) ON CONFLICT(rule_key) DO UPDATE SET muted_at = excluded.muted_at, reason = excluded.reason").run(key, now, reason);
    refreshMuted(db);
    event(db, null, now, "muted", key);
  });
}

export function unmuteRule(db: Db, key: string): boolean {
  return transaction(db, () => {
    const changed = db.prepare("DELETE FROM fleet_rules WHERE rule_key = ?").run(key).changes > 0;
    refreshMuted(db);
    return changed;
  });
}
