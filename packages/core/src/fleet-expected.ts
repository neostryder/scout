import { defaultSeverity, fingerprint, type FailureClass, type IncidentPacket } from "./fleet-packet.ts";

export interface ExpectedRun {
  host: string;
  component: string;
  everyMinutes: number;
  graceMinutes: number;
  since?: string;
}

export function heartbeatMetaKey(host: string, component: string): string {
  return `fleet_hb:${host}/${component}`;
}

export function expectedKey(host: string, component: string): string {
  return `${host}/${component}`;
}

function isLastSeenMap(value: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>): value is ReadonlyMap<string, string | null> {
  return value instanceof Map;
}

function lookup(lastSeen: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>, key: string): string | null {
  const value = isLastSeenMap(lastSeen) ? lastSeen.get(key) : lastSeen[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function packet(row: ExpectedRun, failureClass: FailureClass, now: string, lastSeen: string | null): IncidentPacket {
  const summary = failureClass === "never-ran"
    ? `no heartbeat for ${row.component} on ${row.host}`
    : `heartbeat for ${row.component} on ${row.host} is late`;
  return {
    version: 1,
    host: row.host,
    component: row.component,
    severity: defaultSeverity(failureClass),
    failureClass,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    fingerprint: fingerprint(row.host, row.component, failureClass),
    summary: summary.slice(0, 300),
    evidence: {
      snapshot: {
        everyMinutes: row.everyMinutes,
        graceMinutes: row.graceMinutes,
        lastSeen,
        since: row.since ?? null,
      },
    },
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
}

export function expectedPackets(table: readonly ExpectedRun[], lastSeen: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>, now: string): IncidentPacket[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const packets: IncidentPacket[] = [];
  for (const row of table) {
    if (!row.host || !row.component || !Number.isFinite(row.everyMinutes) || !Number.isFinite(row.graceMinutes)) continue;
    const seen = lookup(lastSeen, expectedKey(row.host, row.component));
    if (seen === null) {
      const sinceMs = row.since ? Date.parse(row.since) : NaN;
      if (Number.isFinite(sinceMs) && nowMs - sinceMs > row.graceMinutes * 60_000) packets.push(packet(row, "never-ran", now, null));
      continue;
    }
    const seenMs = Date.parse(seen);
    if (Number.isFinite(seenMs) && nowMs - seenMs > (row.everyMinutes + row.graceMinutes) * 60_000) packets.push(packet(row, "wedged", now, seen));
  }
  return packets;
}
