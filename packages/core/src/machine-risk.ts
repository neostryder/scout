import type { Db } from "./db.ts";
import { updatesView } from "./assertions.ts";
import { cachedPriorityFlags, priorityScore } from "./priority.ts";

export const RISK_WEIGHTS = { pending: 0.45, dependencies: 0.25, health: 0.30 } as const;

export interface MachineRiskPart {
  name: "pending" | "dependencies" | "health";
  value: number;
  weight: number;
  detail: string;
}

export interface MachineRisk {
  machineId: string;
  score: number;
  level: "low" | "moderate" | "elevated" | "high";
  parts: MachineRiskPart[];
}

export interface RiskInputs {
  pending: { priority: number; hard: number; soft: number }[];
  health: { openHigh: number; openWarn: number; resolvedHigh: number; outage: boolean };
}

function bounded(value: number): number { return Math.max(0, Math.min(1, value)); }

export function riskLevel(score: number): MachineRisk["level"] {
  return score < 25 ? "low" : score < 50 ? "moderate" : score < 75 ? "elevated" : "high";
}

export function scoreRisk(inputs: RiskInputs): Omit<MachineRisk, "machineId"> {
  const priorities = inputs.pending.map((row) => bounded(row.priority / 100));
  const hard = inputs.pending.reduce((sum, row) => sum + row.hard, 0);
  const soft = inputs.pending.reduce((sum, row) => sum + row.soft, 0);
  const pendingValue = 1 - Math.exp(-priorities.reduce((sum, value) => sum + value, 0) / 4);
  const dependencyValue = bounded((hard + 0.25 * soft) / 5);
  const healthValue = bounded(inputs.health.openHigh * 0.5 + inputs.health.openWarn * 0.2 + inputs.health.resolvedHigh * 0.1 + (inputs.health.outage ? 0.3 : 0));
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts: MachineRiskPart[] = [
    { name: "pending", value: pendingValue, weight: RISK_WEIGHTS.pending, detail: priorities.length ? `${count(priorities.length, "update")} ${priorities.length === 1 ? "is" : "are"} waiting, the most urgent scoring ${Math.round(Math.max(...inputs.pending.map((row) => bounded(row.priority))))} of 100.` : "No updates are waiting." },
    { name: "dependencies", value: dependencyValue, weight: RISK_WEIGHTS.dependencies, detail: `${hard} update${hard === 1 ? " would" : "s would"} break a dependent program and ${soft} ${soft === 1 ? "update may" : "updates may"} affect dependent programs.` },
    { name: "health", value: healthValue, weight: RISK_WEIGHTS.health, detail: inputs.health.openHigh || inputs.health.openWarn || inputs.health.resolvedHigh ? `${count(inputs.health.openHigh, "high alert")} open, ${count(inputs.health.openWarn, "warning")} open, and ${count(inputs.health.resolvedHigh, "high alert")} resolved this week.${inputs.health.outage ? " A crash loop or machine outage alert is open." : ""}` : inputs.health.outage ? "A crash loop or machine outage alert is open." : "No recent health alerts are recorded." },
  ];
  const score = Math.round(100 * parts.reduce((sum, part) => sum + part.weight * part.value, 0));
  return { score, level: riskLevel(score), parts };
}

export function machineRisks(db: Db, now = new Date().toISOString()): MachineRisk[] {
  const machines = db.prepare("SELECT m.id FROM machines m WHERE EXISTS (SELECT 1 FROM installs i WHERE i.machine_id = m.id AND i.removed_at IS NULL) AND NOT EXISTS (SELECT 1 FROM machines r WHERE r.id = m.id AND r.state = 'removed') ORDER BY m.id").all() as { id: string }[];
  const ids = new Set(machines.map((machine) => machine.id));
  const pending = new Map<string, RiskInputs["pending"]>();
  const flags = cachedPriorityFlags(db);
  const freezes = db.prepare("SELECT install_id AS installId, package_id AS packageId FROM constraints WHERE hard = 1 AND type = 'freeze'").all() as { installId: number | null; packageId: number | null }[];
  const frozenInstalls = new Set(freezes.flatMap((row) => row.installId === null ? [] : [row.installId]));
  const frozenPackages = new Set(freezes.flatMap((row) => row.installId === null && row.packageId !== null ? [row.packageId] : []));
  for (const row of updatesView(db)) {
    if (!row.updatable || !ids.has(row.machineId)) continue;
    const target = row.available ?? row.upstream;
    const priority = priorityScore({ installed: row.installed, available: target, now, bump: target === row.available ? row.bump : undefined, lastUsed: row.lastUsed, running: row.usage.running, kind: row.kind, category: row.category, blocked: row.blockedBy !== null || row.advisoryOnly || frozenInstalls.has(row.installId) || frozenPackages.has(row.packageId), flags: target === null ? undefined : flags.get(row.packageId)?.get(target) }).score;
    pending.set(row.machineId, [...(pending.get(row.machineId) ?? []), { priority, hard: row.risk?.hard ?? 0, soft: row.risk?.soft ?? 0 }]);
  }
  const alerts = db.prepare("SELECT machine_id AS machineId, severity, state, kind, muted, at, resolved_at AS resolvedAt FROM alerts WHERE machine_id IS NOT NULL AND ((state = 'open' AND (muted = 0 OR kind IN ('crash-loop', 'machine-outage'))) OR (state = 'resolved' AND severity = 'high' AND resolved_at >= ?))").all(new Date(Date.parse(now) - 7 * 86_400_000).toISOString()) as { machineId: string; severity: string; state: string; kind: string; muted: number; at: string; resolvedAt: string | null }[];
  const health = new Map<string, RiskInputs["health"]>();
  for (const alert of alerts) {
    if (!ids.has(alert.machineId)) continue;
    const value = health.get(alert.machineId) ?? { openHigh: 0, openWarn: 0, resolvedHigh: 0, outage: false };
    if (alert.state === "open") {
      if (alert.muted === 0 && alert.severity === "high") value.openHigh++;
      if (alert.muted === 0 && alert.severity === "warn") value.openWarn++;
      if (alert.kind === "crash-loop" || alert.kind === "machine-outage") value.outage = true;
    } else if (alert.state === "resolved" && alert.severity === "high" && alert.resolvedAt !== null) value.resolvedHigh++;
    health.set(alert.machineId, value);
  }
  return machines.map(({ id }) => ({ machineId: id, ...scoreRisk({ pending: pending.get(id) ?? [], health: health.get(id) ?? { openHigh: 0, openWarn: 0, resolvedHigh: 0, outage: false } }) }));
}
