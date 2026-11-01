import { readFileSync } from "node:fs";
import type { ExpectedRun } from "./fleet-expected.ts";
import type { FleetIncident, FleetPolicy } from "./fleet-incidents.ts";
import type { FailureClass, IncidentPacket, Severity } from "./fleet-packet.ts";

export interface FleetNotice {
  title: string;
  body: string;
  severity: Severity;
  incidentId: number | null;
  kind: "incident" | "recovered" | "escalation" | "digest" | "flapping";
  actions: { id: "investigate" | "snooze" | "mute"; label: string }[];
}

export interface FleetNotifier {
  id: string;
  send(notice: FleetNotice): Promise<{ ok: boolean; error: string | null }>;
}

export interface FleetActionHandler {
  handleAction(incidentId: number, action: "investigate" | "snooze" | "mute", actor: string): Promise<{ ok: boolean; error: string | null }>;
}

export interface FleetInvestigator {
  investigate(incident: FleetIncident, packet: IncidentPacket): Promise<{ ok: boolean; reference: string | null; error: string | null }>;
}

export interface FleetTriageResult {
  noise: boolean;
  failureClass?: FailureClass;
  severity?: Severity;
  groupWith?: string;
  ownerChat?: string;
  healSafe?: boolean;
  cause?: string;
}

export interface FleetTriage {
  classify(packet: IncidentPacket): Promise<FleetTriageResult>;
}

export interface FleetHealResult { ok: boolean; error: string | null }

export interface FleetHealer {
  id: string;
  canHeal(incident: FleetIncident): boolean;
  heal(incident: FleetIncident): Promise<FleetHealResult>;
}

export interface FleetNotifierConfig {
  type: "webhook" | "command" | "desktop";
  id: string;
  urlEnv: string | null;
  tokenEnv: string | null;
  command: string[] | null;
  url(): string | undefined;
  token(): string | undefined;
}

export interface FleetCommandHook { command: string[] }

export interface FleetHealerConfig { id: string; command: string[] | null }

export interface FleetFile {
  policy: Partial<FleetPolicy> | null;
  notifiers: FleetNotifierConfig[];
  investigator: FleetCommandHook | null;
  triage: FleetCommandHook | null;
  healers: FleetHealerConfig[];
  expected: ExpectedRun[];
  ingestTokenEnv: string | null;
  digestTimes: string[];
  fileError: string | null;
}

const EMPTY: FleetFile = {
  policy: null,
  notifiers: [],
  investigator: null,
  triage: null,
  healers: [],
  expected: [],
  ingestTokenEnv: null,
  digestTimes: ["08:00", "18:00"],
  fileError: null,
};

const FILE_ERROR = "The fleet file is malformed or unreadable; fleet settings were ignored.";
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ = /^([+-])\d{2}:\d{2}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_FIELDS = new Set(["url", "token", "webhook", "authorization", "secret", "password"]);

function broken(): FleetFile {
  return { ...EMPTY, notifiers: [], healers: [], expected: [], digestTimes: ["08:00", "18:00"], fileError: FILE_ERROR };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function commandList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  if (value.some((part) => typeof part !== "string" || part.length === 0 || part.length > 500 || part.includes("\n") || part.includes("\0"))) return null;
  return value as string[];
}

function hook(value: unknown): FleetCommandHook | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return null;
  const command = commandList(value.command);
  return command ? { command } : null;
}

function policy(value: unknown): Partial<FleetPolicy> | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return null;
  const allowed = new Set(["quietHours", "escalateAfterMinutes", "escalateEveryMinutes", "flapReopens", "flapWindowMinutes", "flapQuietMinutes"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return null;
  const result: Partial<FleetPolicy> = {};
  if (value.quietHours !== undefined) {
    if (!isRecord(value.quietHours)) return null;
    const { start, end, timezone } = value.quietHours;
    if (typeof start !== "string" || !HM.test(start) || typeof end !== "string" || !HM.test(end)) return null;
    if (typeof timezone !== "string" || (timezone !== "local" && !TZ.test(timezone))) return null;
    result.quietHours = { start, end, timezone };
  }
  for (const key of ["escalateAfterMinutes", "escalateEveryMinutes", "flapReopens", "flapWindowMinutes", "flapQuietMinutes"] as const) {
    if (value[key] === undefined) continue;
    const number = value[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 100_000) return null;
    result[key] = number;
  }
  return result;
}

function notifier(value: unknown, index: number, env: (name: string) => string | undefined): FleetNotifierConfig | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => SECRET_FIELDS.has(key))) return null;
  const type = value.type;
  if (type !== "webhook" && type !== "command" && type !== "desktop") return null;
  if (value.id !== undefined && (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 80)) return null;
  const id = typeof value.id === "string" ? value.id : `${type}-${index + 1}`;
  const urlEnv = value.urlEnv === undefined ? null : value.urlEnv;
  const tokenEnv = value.tokenEnv === undefined ? null : value.tokenEnv;
  if (urlEnv !== null && (typeof urlEnv !== "string" || !ENV_NAME.test(urlEnv))) return null;
  if (tokenEnv !== null && (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv))) return null;
  if (type === "webhook" && urlEnv === null) return null;
  const command = value.command === undefined ? null : commandList(value.command);
  if (type === "command" && command === null) return null;
  if (type !== "command" && value.command !== undefined) return null;
  return {
    type,
    id,
    urlEnv,
    tokenEnv,
    command,
    url: () => (urlEnv ? env(urlEnv) : undefined),
    token: () => (tokenEnv ? env(tokenEnv) : undefined),
  };
}

function expectedRow(value: unknown): ExpectedRun | null {
  if (!isRecord(value)) return null;
  const { host, component, everyMinutes, graceMinutes, since } = value;
  if (typeof host !== "string" || host.length === 0 || host.length > 200) return null;
  if (typeof component !== "string" || component.length === 0 || component.length > 200) return null;
  if (typeof everyMinutes !== "number" || !Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 100_000) return null;
  if (typeof graceMinutes !== "number" || !Number.isSafeInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 100_000) return null;
  if (since !== undefined && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) return null;
  const row: ExpectedRun = { host, component, everyMinutes, graceMinutes };
  if (typeof since === "string") row.since = since;
  return row;
}

export function loadFleetConfig(path: string, env: (name: string) => string | undefined = (name) => process.env[name]): FleetFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ...EMPTY, notifiers: [], healers: [], expected: [], digestTimes: ["08:00", "18:00"] } : broken();
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!isRecord(data)) return broken();
    if (Object.keys(data).some((key) => SECRET_FIELDS.has(key))) return broken();
    const allowed = new Set(["policy", "notifiers", "investigator", "triage", "healers", "expected", "ingestTokenEnv", "digestTimes"]);
    if (Object.keys(data).some((key) => !allowed.has(key))) return broken();
    const parsedPolicy = data.policy === undefined ? null : policy(data.policy);
    if (data.policy !== undefined && parsedPolicy === null) return broken();
    const notifiers: FleetNotifierConfig[] = [];
    if (data.notifiers !== undefined) {
      if (!Array.isArray(data.notifiers)) return broken();
      for (let index = 0; index < data.notifiers.length; index += 1) {
        const row = notifier(data.notifiers[index], index, env);
        if (!row) return broken();
        notifiers.push(row);
      }
    }
    let investigator: FleetCommandHook | null = null;
    if (data.investigator !== undefined) {
      investigator = hook(data.investigator);
      if (!investigator) return broken();
    }
    let triage: FleetCommandHook | null = null;
    if (data.triage !== undefined) {
      triage = hook(data.triage);
      if (!triage) return broken();
    }
    const healers: FleetHealerConfig[] = [];
    if (data.healers !== undefined) {
      if (!Array.isArray(data.healers)) return broken();
      for (const row of data.healers) {
        if (!isRecord(row) || typeof row.id !== "string" || row.id.length === 0 || row.id.length > 80) return broken();
        const command = row.command === undefined ? null : commandList(row.command);
        if (row.command !== undefined && command === null) return broken();
        healers.push({ id: row.id, command });
      }
    }
    const expected: ExpectedRun[] = [];
    if (data.expected !== undefined) {
      if (!Array.isArray(data.expected)) return broken();
      for (const row of data.expected) {
        const parsed = expectedRow(row);
        if (!parsed) return broken();
        expected.push(parsed);
      }
    }
    let ingestTokenEnv: string | null = null;
    if (data.ingestTokenEnv !== undefined) {
      if (typeof data.ingestTokenEnv !== "string" || !ENV_NAME.test(data.ingestTokenEnv)) return broken();
      ingestTokenEnv = data.ingestTokenEnv;
    }
    let digestTimes = ["08:00", "18:00"];
    if (data.digestTimes !== undefined) {
      if (!Array.isArray(data.digestTimes) || data.digestTimes.length === 0 || data.digestTimes.length > 24 || data.digestTimes.some((item) => typeof item !== "string" || !HM.test(item))) return broken();
      digestTimes = data.digestTimes as string[];
    }
    return { policy: parsedPolicy, notifiers, investigator, triage, healers, expected, ingestTokenEnv, digestTimes, fileError: null };
  } catch {
    return broken();
  }
}
