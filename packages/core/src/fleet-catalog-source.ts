import { defaultSeverity, fingerprint, isFalseAlarm, type FailureClass, type IncidentEvidence, type IncidentPacket } from "./fleet-packet.ts";

export interface CatalogServiceRow {
  machine: string;
  kind: string;
  name: string;
  state: string;
  startMode: string | null;
  enabled: boolean;
  lastRun: string | null;
  lastResult: string | null;
  keepAlive: boolean | null;
  lastSeenAt: string;
}

export interface CatalogSourceScope {
  tasks: { include: RegExp[]; exclude: RegExp[] };
  launchd: { include: RegExp[]; exclude: RegExp[] };
  systemd: { include: RegExp[]; exclude: RegExp[] };
  windowsServices: { include: RegExp[] };
  neverRan: RegExp[];
  staleScanMinutes: number;
}

export const DEFAULT_CATALOG_SCOPE: CatalogSourceScope = {
  tasks: { include: [/^[^\\]+$/i], exclude: [/^(Brave|Google|Adobe|CCleaner|Driver Easy|OneDrive|MicrosoftEdge)/i] },
  launchd: { include: [/.*/i], exclude: [/^com\.apple\./i, /^application\./i, /^gui\//i, /^user\//i] },
  systemd: { include: [], exclude: [] },
  windowsServices: { include: [] },
  neverRan: [],
  staleScanMinutes: 30,
};

function matches(patterns: readonly RegExp[], name: string): boolean {
  return patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(name));
}

function inScope(scope: { include: RegExp[]; exclude: RegExp[] }, name: string): boolean {
  return matches(scope.include, name) && !matches(scope.exclude, name);
}

function resultCode(value: string | null): bigint | null {
  if (value === null || !/^(?:[+-]?\d+|0x[0-9a-f]+)$/i.test(value.trim())) return null;
  return BigInt(value.trim());
}

function packet(row: CatalogServiceRow, component: string, failureClass: FailureClass, summary: string, evidence: IncidentEvidence, now: string): IncidentPacket {
  return {
    version: 1,
    host: row.machine,
    component,
    severity: defaultSeverity(failureClass),
    failureClass,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    fingerprint: fingerprint(row.machine, component, failureClass),
    summary: summary.slice(0, 299),
    evidence,
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
}

export function catalogPackets(rows: readonly CatalogServiceRow[], scope: CatalogSourceScope, now: string): IncidentPacket[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return [];
  const packets: IncidentPacket[] = [];
  for (const row of rows) {
    const seenMs = Date.parse(row.lastSeenAt);
    if (!row.enabled || !Number.isFinite(seenMs) || nowMs - seenMs > scope.staleScanMinutes * 60_000) continue;
    const running = row.state === "running";
    let next: IncidentPacket | undefined;
    if (row.kind === "scheduled-task") {
      const component = row.name.replace(/^\\/, "");
      if (!inScope(scope.tasks, component)) continue;
      const code = resultCode(row.lastResult);
      if (code === null || [0n, 267009n, 267010n, 267014n].includes(code)) continue;
      const evidence: IncidentEvidence = { snapshot: { taskResult: row.lastResult, lastRun: row.lastRun, state: row.state, running, kind: row.kind } };
      if (code === 267011n) {
        if (!matches(scope.neverRan, component)) continue;
        next = packet(row, component, "never-ran", "task has never run", evidence, now);
      } else {
        if (Number.isSafeInteger(Number(code))) evidence.exitCode = Number(code);
        next = packet(row, component, "ran-failed", `task result ${row.lastResult}`, evidence, now);
      }
    } else if (row.kind === "launchd") {
      if (!inScope(scope.launchd, row.name)) continue;
      const evidence: IncidentEvidence = { snapshot: { launchdStatus: row.lastResult, state: row.state, running, kind: row.kind } };
      if (row.keepAlive === true && row.state === "stopped") {
        next = packet(row, row.name, "dead", "keep-alive job is not running", evidence, now);
      } else if (row.keepAlive !== true && !running) {
        const code = resultCode(row.lastResult);
        if (code !== null && code !== 0n && code !== -9n && code !== -15n) next = packet(row, row.name, "ran-failed", `launchd exit ${row.lastResult}`, evidence, now);
      }
    } else if (row.kind === "systemd") {
      if (!inScope(scope.systemd, row.name) || row.startMode === "disabled") continue;
      if (row.state === "other" || row.state === "stopped") next = packet(row, row.name, "dead", "enabled unit is not running", { snapshot: { state: row.state, kind: row.kind } }, now);
    } else if (row.kind === "windows-service") {
      if (matches(scope.windowsServices.include, row.name) && row.startMode === "auto" && row.state === "stopped") {
        next = packet(row, row.name, "dead", "automatic service is not running", { snapshot: { state: row.state, kind: row.kind } }, now);
      }
    }
    if (next && !isFalseAlarm(next)) packets.push(next);
  }
  return packets;
}

export function reconcileCatalog(previous: ReadonlyMap<string, IncidentPacket>, current: readonly IncidentPacket[], now: string): { send: IncidentPacket[]; next: Map<string, IncidentPacket> } {
  const next = new Map(current.map((item) => [item.fingerprint, item]));
  const send = [...current];
  for (const [key, item] of previous) {
    if (!next.has(key)) send.push({ ...item, recovered: true, lastSeen: now, summary: "recovered" });
  }
  return { send, next };
}
