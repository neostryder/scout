import type { Db } from "./db.ts";
import type { FleetIncident } from "./fleet-incidents.ts";
import type { FleetCommandHook } from "./fleet-ports.ts";
import { FAILURE_CLASSES, type FailureClass } from "./fleet-packet.ts";

export interface FleetDiagnosticConfig {
  id: string;
  machine: string;
  host?: string;
  argv: string[];
  params: Record<string, string>;
  components?: string[];
  failureClasses?: FailureClass[];
  timeoutSeconds: number;
  description?: string;
}

export interface FleetInvestigationConfig {
  enabled: boolean;
  analyst: FleetCommandHook;
  maxPerDay: number;
  maxRounds: number;
  maxCostUsdPerDay: number | null;
  timeoutSeconds: number;
  diagnostics: FleetDiagnosticConfig[];
}

export interface FleetInvestigationRow {
  id: number;
  incidentId: number;
  fingerprint: string;
  openedAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "incomplete" | "failed";
  actor: string | null;
  cause: string | null;
  evidence: string | null;
  proposedFix: string | null;
  needsHuman: boolean;
  heal: string | null;
  proposedActions: string[];
  rounds: number;
  costUsd: number;
  error: string | null;
}

interface InvestigationResult {
  status: "done" | "incomplete" | "failed";
  cause?: string | null;
  evidence?: string | null;
  proposedFix?: string | null;
  needsHuman?: boolean;
  heal?: string | null;
  proposedActions?: string[];
  rounds: number;
  costUsd: number;
  error?: string | null;
}

interface StoredInvestigation {
  id: number;
  incidentId: number;
  fingerprint: string;
  openedAt: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "incomplete" | "failed";
  actor: string | null;
  cause: string | null;
  evidence: string | null;
  proposedFix: string | null;
  needsHuman: number;
  heal: string | null;
  proposedActionsJson: string;
  rounds: number;
  costUsd: number;
  error: string | null;
}

const SECTION = "investigation";
const PLACEHOLDER = /^\{([^{}]+)\}$/;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const DIAGNOSTIC_ID = /^[a-z0-9-]{1,64}$/;
const MACHINE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const SELECT = `SELECT id, incident_id AS incidentId, fingerprint, opened_at AS openedAt, started_at AS startedAt,
  finished_at AS finishedAt, status, actor, cause, evidence, proposed_fix AS proposedFix, needs_human AS needsHuman,
  heal, proposed_actions_json AS proposedActionsJson, rounds, cost_usd AS costUsd, error FROM fleet_investigations`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The same rules the investigator and triage hooks accept. */
function commandList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  if (value.some((part) => typeof part !== "string" || part.length === 0 || part.length > 500 || part.includes("\n") || part.includes("\0"))) return null;
  return value as string[];
}

export function investigationConfig(value: unknown, onInvalid?: (detail: string) => void): FleetInvestigationConfig | null {
  const invalid = (where: string, reason: string): null => { onInvalid?.(`${where}: ${reason}`); return null; };
  const keys = (row: Record<string, unknown>, allowed: string[]): boolean => Object.keys(row).every((key) => allowed.includes(key));
  const text = (item: unknown, max: number): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(item);
  const integer = (item: unknown, min: number, max: number): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= min && item <= max;
  const regex = (item: unknown): item is string => {
    if (typeof item !== "string" || item.length > 200) return false;
    try { new RegExp(item, "i"); return true; } catch { return false; }
  };
  if (!isRecord(value)) return invalid(SECTION, "investigation must be an object");
  if (!keys(value, ["enabled", "analyst", "maxPerDay", "maxRounds", "maxCostUsdPerDay", "timeoutSeconds", "diagnostics"])) return invalid(SECTION, "investigation holds an unknown field");
  if (JSON.stringify(value).length > 65_536) return invalid(SECTION, "investigation exceeds 65536 characters");
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") return invalid(`${SECTION}.enabled`, "enabled must be a boolean");
  if (!isRecord(value.analyst)) return invalid(`${SECTION}.analyst`, "analyst must be an object holding a command");
  const command = commandList(value.analyst.command);
  if (!command) return invalid(`${SECTION}.analyst.command`, "command must be a list of 1 through 32 strings of at most 500 characters");
  const maxPerDay = value.maxPerDay === undefined ? 10 : value.maxPerDay;
  if (!integer(maxPerDay, 1, 100)) return invalid(`${SECTION}.maxPerDay`, "maxPerDay must be an integer from 1 through 100");
  const maxRounds = value.maxRounds === undefined ? 3 : value.maxRounds;
  if (!integer(maxRounds, 1, 4)) return invalid(`${SECTION}.maxRounds`, "maxRounds must be an integer from 1 through 4");
  let maxCostUsdPerDay: number | null = null;
  if (value.maxCostUsdPerDay !== undefined && value.maxCostUsdPerDay !== null) {
    const cost = value.maxCostUsdPerDay;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0 || cost > 1000) return invalid(`${SECTION}.maxCostUsdPerDay`, "maxCostUsdPerDay must be a number greater than 0 and at most 1000");
    maxCostUsdPerDay = cost;
  }
  const timeoutSeconds = value.timeoutSeconds === undefined ? 240 : value.timeoutSeconds;
  if (!integer(timeoutSeconds, 10, 900)) return invalid(`${SECTION}.timeoutSeconds`, "timeoutSeconds must be an integer from 10 through 900");
  const diagnostics: FleetDiagnosticConfig[] = [];
  if (value.diagnostics !== undefined) {
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 40) return invalid(`${SECTION}.diagnostics`, "diagnostics must be a list of at most 40 diagnostics");
    const seen = new Set<string>();
    for (const [index, row] of value.diagnostics.entries()) {
      const where = `${SECTION}.diagnostics[${index}]`;
      if (!isRecord(row)) return invalid(where, "diagnostic must be an object");
      if (!keys(row, ["id", "machine", "host", "argv", "params", "components", "failureClasses", "timeoutSeconds", "description"])) return invalid(where, "diagnostic holds an unknown field");
      const id = row.id;
      if (typeof id !== "string" || !DIAGNOSTIC_ID.test(id)) return invalid(`${where}.id`, "id must use 1 through 64 lowercase letters, digits or hyphens");
      if (seen.has(id)) return invalid(`${where}.id`, "duplicate diagnostic id");
      seen.add(id);
      const machine = row.machine;
      if (!text(machine, 64) || !MACHINE.test(machine)) return invalid(`${where}.machine`, "machine must use 1 through 64 lowercase letters, digits, underscores or hyphens and start with a letter or digit");
      let host: string | undefined;
      if (row.host !== undefined) {
        const candidate = row.host;
        if (!text(candidate, 64)) return invalid(`${where}.host`, "host must be a non-empty string of at most 64 characters without control characters");
        host = candidate;
      }
      const argv = row.argv;
      if (!Array.isArray(argv) || argv.length < 1 || argv.length > 20) return invalid(`${where}.argv`, "argv must be a list of 1 through 20 strings");
      for (const [partIndex, part] of argv.entries()) {
        if (typeof part !== "string" || part.length < 1 || part.length > 500) return invalid(`${where}.argv`, `argv part ${partIndex + 1} must be a string of 1 through 500 characters`);
        if (/[\x00-\x1f\x7f-\x9f]/.test(part)) return invalid(`${where}.argv`, `argv part ${partIndex + 1} holds a control character such as a newline`);
      }
      const params: Record<string, string> = {};
      if (row.params !== undefined) {
        if (!isRecord(row.params)) return invalid(`${where}.params`, "params must be an object of names and regular expressions");
        const names = Object.keys(row.params);
        if (names.length > 4) return invalid(`${where}.params`, "params holds at most 4 entries");
        for (const name of names) {
          if (!PARAM_NAME.test(name)) return invalid(`${where}.params`, "param names must use 1 through 32 lowercase letters, digits or underscores and start with a letter");
          const source = row.params[name];
          if (typeof source !== "string" || source.length > 200) return invalid(`${where}.params.${name}`, "value must be a regular expression of at most 200 characters");
          if (!regex(source)) return invalid(`${where}.params.${name}`, "value holds an invalid regular expression");
          params[name] = source;
        }
      }
      const used = new Set<string>();
      for (const part of argv) {
        const match = PLACEHOLDER.exec(part);
        if (!match) continue;
        const name = match[1] ?? "";
        if (!Object.prototype.hasOwnProperty.call(params, name)) return invalid(`${where}.argv`, `placeholder {${name}} has no declared param`);
        used.add(name);
      }
      for (const name of Object.keys(params)) {
        if (!used.has(name)) return invalid(`${where}.params`, `param ${name} is not used as a placeholder`);
      }
      let components: string[] | undefined;
      if (row.components !== undefined) {
        const list = row.components;
        if (!Array.isArray(list) || list.length > 20 || !list.every((item) => text(item, 180))) return invalid(`${where}.components`, "components must be a list of at most 20 strings of at most 180 characters");
        components = list as string[];
      }
      let failureClasses: FailureClass[] | undefined;
      if (row.failureClasses !== undefined) {
        const list = row.failureClasses;
        if (!Array.isArray(list) || list.some((item) => !FAILURE_CLASSES.includes(item as FailureClass))) return invalid(`${where}.failureClasses`, "failureClasses must be a list of known failure classes");
        failureClasses = list as FailureClass[];
      }
      const diagnosticTimeout = row.timeoutSeconds === undefined ? 20 : row.timeoutSeconds;
      if (!integer(diagnosticTimeout, 1, 120)) return invalid(`${where}.timeoutSeconds`, "timeoutSeconds must be an integer from 1 through 120");
      let description: string | undefined;
      if (row.description !== undefined) {
        const candidate = row.description;
        if (typeof candidate !== "string" || candidate.length > 200) return invalid(`${where}.description`, "description must be a string of at most 200 characters");
        if (/[\x00-\x1f\x7f-\x9f]/.test(candidate)) return invalid(`${where}.description`, "description holds a control character such as a newline");
        description = candidate;
      }
      const diagnostic: FleetDiagnosticConfig = { id, machine, argv: argv as string[], params, timeoutSeconds: diagnosticTimeout };
      if (host !== undefined) diagnostic.host = host;
      if (components !== undefined) diagnostic.components = components;
      if (failureClasses !== undefined) diagnostic.failureClasses = failureClasses;
      if (description !== undefined) diagnostic.description = description;
      diagnostics.push(diagnostic);
    }
  }
  return { enabled, analyst: { command }, maxPerDay, maxRounds, maxCostUsdPerDay, timeoutSeconds, diagnostics };
}

export function matchDiagnostics(config: FleetInvestigationConfig, incident: { host: string; component: string; failureClass: string }): FleetDiagnosticConfig[] {
  const host = incident.host.toLowerCase();
  return config.diagnostics.filter((diagnostic) => {
    if ((diagnostic.host ?? diagnostic.machine).toLowerCase() !== host) return false;
    if (diagnostic.components && !diagnostic.components.includes(incident.component)) return false;
    if (diagnostic.failureClasses && !diagnostic.failureClasses.includes(incident.failureClass as FailureClass)) return false;
    return true;
  });
}

export function buildDiagnosticArgv(diagnostic: FleetDiagnosticConfig, args: Record<string, unknown>): string[] | null {
  const names = Object.keys(diagnostic.params);
  if (Object.keys(args).length !== names.length) return null;
  const values: Record<string, string> = {};
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) return null;
    const value = args[name];
    if (typeof value !== "string" || value.length > 200) return null;
    let matched = false;
    try { matched = new RegExp(`^(?:${diagnostic.params[name]})$`, "i").test(value); } catch { return null; }
    if (!matched) return null;
    values[name] = value;
  }
  const argv: string[] = [];
  for (const part of diagnostic.argv) {
    const match = PLACEHOLDER.exec(part);
    if (!match) {
      argv.push(part);
      continue;
    }
    const name = match[1] ?? "";
    const value = values[name];
    if (value === undefined) return null;
    argv.push(value);
  }
  return argv;
}

function toRow(row: StoredInvestigation): FleetInvestigationRow {
  return {
    id: row.id,
    incidentId: row.incidentId,
    fingerprint: row.fingerprint,
    openedAt: row.openedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: row.status,
    actor: row.actor,
    cause: row.cause,
    evidence: row.evidence,
    proposedFix: row.proposedFix,
    needsHuman: row.needsHuman !== 0,
    heal: row.heal,
    proposedActions: JSON.parse(row.proposedActionsJson) as string[],
    rounds: row.rounds,
    costUsd: row.costUsd,
    error: row.error,
  };
}

export function investigationForIncident(db: Db, incident: { id: number; fingerprint: string; openedAt: string }): FleetInvestigationRow | null {
  const row = db.prepare(`${SELECT} WHERE fingerprint = ? AND opened_at = ?`).get(incident.fingerprint, incident.openedAt) as StoredInvestigation | undefined;
  return row ? toRow(row) : null;
}

export function beginInvestigation(db: Db, incident: FleetIncident, actor: string | null, now: string): { id: number } {
  const inserted = db.prepare(`INSERT INTO fleet_investigations (incident_id, fingerprint, opened_at, started_at, status, actor)
    VALUES (?, ?, ?, ?, 'running', ?)`).run(incident.id, incident.fingerprint, incident.openedAt, now, actor);
  return { id: Number(inserted.lastInsertRowid) };
}

export function finishInvestigation(db: Db, id: number, result: InvestigationResult, now: string): void {
  db.prepare(`UPDATE fleet_investigations SET finished_at = ?, status = ?, cause = ?, evidence = ?, proposed_fix = ?,
    needs_human = ?, heal = ?, proposed_actions_json = ?, rounds = ?, cost_usd = ?, error = ? WHERE id = ?`).run(
    now, result.status, result.cause ?? null, result.evidence ?? null, result.proposedFix ?? null,
    result.needsHuman ? 1 : 0, result.heal ?? null, JSON.stringify(result.proposedActions ?? []),
    result.rounds, result.costUsd, result.error ?? null, id,
  );
}

export function discardInvestigation(db: Db, id: number): void {
  db.prepare("DELETE FROM fleet_investigations WHERE id = ?").run(id);
}

export function investigationUsage(db: Db, sinceIso: string): { started: number; running: number; costUsd: number } {
  const row = db.prepare(`SELECT COUNT(*) AS started,
    SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
    COALESCE(SUM(cost_usd), 0) AS costUsd FROM fleet_investigations WHERE started_at >= ?`).get(sinceIso) as { started: number; running: number; costUsd: number };
  return { started: Number(row.started ?? 0), running: Number(row.running ?? 0), costUsd: Number(row.costUsd ?? 0) };
}
