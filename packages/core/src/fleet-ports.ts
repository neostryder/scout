import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { ExpectedRun } from "./fleet-expected.ts";
import type { FleetIncident, FleetPolicy } from "./fleet-incidents.ts";
import { FAILURE_CLASSES, SEVERITIES, type FailureClass, type IncidentPacket, type Severity } from "./fleet-packet.ts";

export interface FleetNotice {
  title: string;
  body: string;
  severity: Severity;
  incidentId: number | null;
  kind: "incident" | "recovered" | "escalation" | "digest" | "flapping" | "healed" | "heal-failed";
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

export interface FleetHealerConfig {
  id: string;
  command: string[];
  host: string;
  component: string;
  failureClass: FailureClass;
  cooldownMinutes: number;
  maxPerDay: number;
  timeoutSeconds: number;
}

export interface FleetCatalogConfig {
  enabled?: boolean;
  staleScanMinutes?: number;
  tasks?: { include?: string[]; exclude?: string[] };
  launchd?: { include?: string[]; exclude?: string[] };
  systemd?: { include?: string[]; exclude?: string[] };
  windowsServices?: { include?: string[] };
  neverRan?: { tasks: string[]; graceDays?: number };
}

export interface FleetLocalEventConfig {
  component: string;
  log: string;
  ids: number[];
  levels: number[];
  providers: string[];
  maxAgeMinutes: number;
  failureClass: FailureClass;
}

export interface FleetLocalLogConfig {
  component: string;
  path: string;
  pattern: string;
  ignore?: string;
  tailKilobytes: number;
  maxAgeMinutes: number;
  staleAfterMinutes: number | null;
  failureClass: FailureClass;
}

export interface FleetLocalConfig {
  enabled?: boolean;
  host: string;
  disk: { paths: string[]; warnFreePercent: number; criticalFreePercent: number };
  windowsEvents: FleetLocalEventConfig[];
  wsl: { enabled: boolean };
  logs: FleetLocalLogConfig[];
}

export interface FleetRemoteCheckConfig {
  machine: string;
  component: string;
  argv: string[];
  timeoutSeconds: number;
  failureClass: FailureClass;
  severity?: Severity;
  pattern?: string;
  ignore?: string;
  mustMatch?: string;
  unreachable: "report" | "ignore";
}

export interface FleetRemoteConfig {
  enabled?: boolean;
  checks: FleetRemoteCheckConfig[];
}

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
  sources?: { catalog?: FleetCatalogConfig; local?: FleetLocalConfig; remote?: FleetRemoteConfig };
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

function catalogConfig(value: unknown): FleetCatalogConfig | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["enabled", "staleScanMinutes", "tasks", "launchd", "systemd", "windowsServices", "neverRan"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const result: FleetCatalogConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") return null;
    result.enabled = value.enabled;
  }
  if (value.staleScanMinutes !== undefined) {
    if (typeof value.staleScanMinutes !== "number" || !Number.isFinite(value.staleScanMinutes) || value.staleScanMinutes <= 0) return null;
    result.staleScanMinutes = value.staleScanMinutes;
  }
  for (const key of ["tasks", "launchd", "systemd", "windowsServices"] as const) {
    const group = value[key];
    if (group === undefined) continue;
    if (!isRecord(group)) return null;
    const keys = key === "windowsServices" ? ["include"] as const : ["include", "exclude"] as const;
    if (Object.keys(group).some((name) => !(keys as readonly string[]).includes(name))) return null;
    const patterns: { include?: string[]; exclude?: string[] } = {};
    for (const name of keys) {
      const list = group[name];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) return null;
      for (const item of list) new RegExp(item as string, "i");
      patterns[name] = list as string[];
    }
    result[key] = patterns;
  }
  if (value.neverRan !== undefined) {
    if (!isRecord(value.neverRan) || Object.keys(value.neverRan).some((key) => key !== "tasks" && key !== "graceDays")) return null;
    const list = value.neverRan.tasks;
    if (!Array.isArray(list) || list.length > 50 || list.some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) return null;
    for (const item of list) new RegExp(item as string, "i");
    const graceDays = value.neverRan.graceDays === undefined ? 8 : value.neverRan.graceDays;
    if (typeof graceDays !== "number" || !Number.isSafeInteger(graceDays) || graceDays < 0 || graceDays > 365) return null;
    result.neverRan = { tasks: list as string[], graceDays };
  }
  return result;
}

export function localConfig(value: unknown): FleetLocalConfig | null {
  const keys = (row: Record<string, unknown>, allowed: string[]): boolean => Object.keys(row).every((key) => allowed.includes(key));
  const text = (item: unknown, max: number): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= max && !/[\x00-\x1f]/.test(item);
  const integer = (item: unknown, max: number): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 1 && item <= max;
  const regex = (item: unknown): item is string => {
    if (typeof item !== "string" || item.length > 200) return false;
    try { new RegExp(item, "i"); return true; } catch { return false; }
  };
  if (!isRecord(value) || !keys(value, ["enabled", "host", "disk", "windowsEvents", "wsl", "logs"]) || JSON.stringify(value).length > 65_536) return null;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return null;
  if (value.host !== undefined && !text(value.host, 64)) return null;
  const result: FleetLocalConfig = {
    host: typeof value.host === "string" ? value.host : hostname(),
    disk: { paths: [`${process.env.SystemDrive ?? "C:"}/`], warnFreePercent: 10, criticalFreePercent: 5 },
    windowsEvents: [],
    wsl: { enabled: false },
    logs: [],
  };
  if (typeof value.enabled === "boolean") result.enabled = value.enabled;
  if (value.disk !== undefined) {
    const disk = value.disk;
    if (!isRecord(disk) || !keys(disk, ["paths", "warnFreePercent", "criticalFreePercent"])) return null;
    if (disk.paths !== undefined) {
      if (!Array.isArray(disk.paths) || disk.paths.length > 20 || !disk.paths.every((path) => text(path, 195))) return null;
      result.disk.paths = disk.paths;
    }
    for (const key of ["warnFreePercent", "criticalFreePercent"] as const) {
      if (disk[key] === undefined) continue;
      if (typeof disk[key] !== "number" || !Number.isFinite(disk[key]) || disk[key] < 1 || disk[key] > 90) return null;
      result.disk[key] = disk[key];
    }
    if (result.disk.warnFreePercent <= result.disk.criticalFreePercent) return null;
  }
  if (value.wsl !== undefined) {
    if (!isRecord(value.wsl) || !keys(value.wsl, ["enabled"]) || (value.wsl.enabled !== undefined && typeof value.wsl.enabled !== "boolean")) return null;
    result.wsl.enabled = value.wsl.enabled === true;
  }
  for (const key of ["windowsEvents", "logs"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > (key === "windowsEvents" ? 20 : 30)) return null;
    for (const row of list) {
      const allowed = key === "windowsEvents" ? ["component", "log", "ids", "levels", "providers", "maxAgeMinutes", "failureClass"] : ["component", "path", "pattern", "ignore", "tailKilobytes", "maxAgeMinutes", "staleAfterMinutes", "failureClass"];
      if (!isRecord(row) || !keys(row, allowed) || !text(row.component, 180)) return null;
      const maxAgeMinutes = row.maxAgeMinutes === undefined ? 30 : row.maxAgeMinutes;
      const failureClass = row.failureClass === undefined ? "ran-failed" : row.failureClass;
      if (!integer(maxAgeMinutes, 10080) || !FAILURE_CLASSES.includes(failureClass as FailureClass)) return null;
      if (key === "windowsEvents") {
        if (!text(row.log, 200) || !/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(row.log)) return null;
        const lists: { ids: number[]; levels: number[] } = { ids: [], levels: [] };
        for (const name of ["ids", "levels"] as const) {
          if (row[name] === undefined) continue;
          if (!Array.isArray(row[name]) || row[name].length > 50 || !row[name].every((item) => integer(item, 2_147_483_647))) return null;
          lists[name] = row[name];
        }
        const providers = row.providers === undefined ? [] : row.providers;
        if (!Array.isArray(providers) || providers.length > 20 || !providers.every((item) => typeof item === "string" && /^[A-Za-z0-9 ._-]{1,100}$/.test(item))) return null;
        result.windowsEvents.push({ component: row.component, log: row.log, ...lists, providers, maxAgeMinutes, failureClass: failureClass as FailureClass });
      } else {
        const tailKilobytes = row.tailKilobytes === undefined ? 64 : row.tailKilobytes;
        const staleAfterMinutes = row.staleAfterMinutes === undefined ? null : row.staleAfterMinutes;
        if (!text(row.path, 1024) || !regex(row.pattern) || (row.ignore !== undefined && !regex(row.ignore)) || !integer(tailKilobytes, 512)) return null;
        if (staleAfterMinutes !== null && !integer(staleAfterMinutes, 10080)) return null;
        result.logs.push({ component: row.component, path: row.path, pattern: row.pattern, ...(typeof row.ignore === "string" ? { ignore: row.ignore } : {}), tailKilobytes, maxAgeMinutes, staleAfterMinutes, failureClass: failureClass as FailureClass });
      }
    }
  }
  return result;
}

export function remoteConfig(value: unknown): FleetRemoteConfig | null {
  const keys = (row: Record<string, unknown>, allowed: string[]): boolean => Object.keys(row).every((key) => allowed.includes(key));
  const text = (item: unknown, max: number): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(item);
  const regex = (item: unknown): item is string => {
    if (typeof item !== "string" || item.length > 200) return false;
    try { new RegExp(item, "i"); return true; } catch { return false; }
  };
  if (!isRecord(value) || !keys(value, ["enabled", "checks"]) || JSON.stringify(value).length > 65_536) return null;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return null;
  const result: FleetRemoteConfig = { checks: [] };
  if (typeof value.enabled === "boolean") result.enabled = value.enabled;
  const checks = value.checks === undefined ? [] : value.checks;
  if (!Array.isArray(checks) || checks.length > 60) return null;
  const seen = new Set<string>();
  for (const row of checks) {
    if (!isRecord(row) || !keys(row, ["machine", "component", "argv", "timeoutSeconds", "failureClass", "severity", "pattern", "ignore", "mustMatch", "unreachable"])) return null;
    if (!text(row.machine, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.machine) || !text(row.component, 180)) return null;
    if (!Array.isArray(row.argv) || row.argv.length < 1 || row.argv.length > 20 || !row.argv.every((part) => typeof part === "string" && part.length >= 1 && part.length <= 500 && !/[\x00-\x1f\x7f-\x9f]/.test(part))) return null;
    const timeoutSeconds = row.timeoutSeconds === undefined ? 20 : row.timeoutSeconds;
    const failureClass = row.failureClass === undefined ? "ran-failed" : row.failureClass;
    const unreachable = row.unreachable === undefined ? "report" : row.unreachable;
    if (typeof timeoutSeconds !== "number" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return null;
    if (!FAILURE_CLASSES.includes(failureClass as FailureClass) || (row.severity !== undefined && !SEVERITIES.includes(row.severity as Severity))) return null;
    if (unreachable !== "report" && unreachable !== "ignore") return null;
    const entry: FleetRemoteCheckConfig = { machine: row.machine, component: row.component, argv: row.argv, timeoutSeconds, failureClass: failureClass as FailureClass, unreachable };
    if (row.severity !== undefined) entry.severity = row.severity as Severity;
    for (const key of ["pattern", "ignore", "mustMatch"] as const) {
      if (row[key] === undefined) continue;
      if (!regex(row[key])) return null;
      entry[key] = row[key];
    }
    const key = `${entry.machine}\n${entry.component}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.checks.push(entry);
  }
  return result;
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
    const allowed = new Set(["policy", "notifiers", "investigator", "triage", "healers", "expected", "ingestTokenEnv", "digestTimes", "sources"]);
    if (Object.keys(data).some((key) => !allowed.has(key))) return broken();
    let sources: FleetFile["sources"];
    if (data.sources !== undefined) {
      if (!isRecord(data.sources) || Object.keys(data.sources).some((key) => key !== "catalog" && key !== "local" && key !== "remote")) return broken();
      sources = {};
      if (data.sources.catalog !== undefined) {
        const catalog = catalogConfig(data.sources.catalog);
        if (!catalog) return broken();
        sources.catalog = catalog;
      }
      if (data.sources.local !== undefined) {
        const local = localConfig(data.sources.local);
        if (!local) return broken();
        sources.local = local;
      }
      if (data.sources.remote !== undefined) {
        const remote = remoteConfig(data.sources.remote);
        if (!remote) return broken();
        sources.remote = remote;
      }
    }
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
      const allowed = new Set(["id", "command", "host", "component", "failureClass", "cooldownMinutes", "maxPerDay", "timeoutSeconds"]);
      const exact = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f*?^$]/.test(value) && !/^\/.*\/[a-z]*$/.test(value);
      const integer = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
      for (const row of data.healers) {
        if (!isRecord(row) || typeof row.id !== "string" || row.id.length === 0 || row.id.length > 80) return broken();
        if (Object.keys(row).some((key) => !allowed.has(key)) || healers.some((healer) => healer.id === row.id)) return broken();
        const command = commandList(row.command);
        if (!command || !exact(row.host, 200) || !exact(row.component, 180) || !FAILURE_CLASSES.includes(row.failureClass as FailureClass)) return broken();
        const cooldownMinutes = row.cooldownMinutes === undefined ? 60 : row.cooldownMinutes;
        const maxPerDay = row.maxPerDay === undefined ? 3 : row.maxPerDay;
        const timeoutSeconds = row.timeoutSeconds === undefined ? 120 : row.timeoutSeconds;
        if (!integer(cooldownMinutes, 1440) || !integer(maxPerDay, 24) || !integer(timeoutSeconds, 300)) return broken();
        healers.push({ id: row.id, command, host: row.host, component: row.component, failureClass: row.failureClass as FailureClass, cooldownMinutes, maxPerDay, timeoutSeconds });
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
    return { policy: parsedPolicy, notifiers, investigator, triage, healers, expected, ingestTokenEnv, digestTimes, fileError: null, ...(sources ? { sources } : {}) };
  } catch {
    return broken();
  }
}
