import { createHash } from "node:crypto";

export const FAILURE_CLASSES = ["dead", "wedged", "never-ran", "ran-failed", "degraded-output", "slow-or-timeout", "resources", "credentials-quota", "network-path", "ai-agent", "watcher-failure", "alert-quality"] as const;
export const SEVERITIES = ["critical", "warning", "info"] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
export type Severity = typeof SEVERITIES[number];

export interface IncidentEvidence {
  exitCode?: number;
  stderrTail?: string;
  journalTail?: string;
  recentChanges?: string[];
  snapshot?: Record<string, string | number | boolean | null>;
}

export interface IncidentPacket {
  version: 1;
  host: string;
  component: string;
  severity: Severity;
  failureClass: FailureClass;
  firstSeen: string;
  lastSeen: string;
  count: number;
  fingerprint: string;
  summary: string;
  evidence: IncidentEvidence;
  redaction: { applied: boolean; rules: string[] };
  ownerChat: string | null;
  runbook: string | null;
  recovered?: boolean;
}

export type PacketParse = { ok: true; packet: IncidentPacket } | { ok: false; error: string };

export const SEVERITY_FOR_CLASS: Record<FailureClass, Severity> = {
  dead: "critical",
  wedged: "critical",
  "never-ran": "warning",
  "ran-failed": "warning",
  "degraded-output": "warning",
  "slow-or-timeout": "warning",
  resources: "critical",
  "credentials-quota": "warning",
  "network-path": "warning",
  "ai-agent": "warning",
  "watcher-failure": "warning",
  "alert-quality": "info",
};

export interface SeverityHints { dataAtRisk?: boolean; severity?: Severity }

const CLASS_SET = new Set<string>(FAILURE_CLASSES);
const SEVERITY_SET = new Set<string>(SEVERITIES);
const TOP_KEYS = new Set(["version", "host", "component", "severity", "failureClass", "firstSeen", "lastSeen", "count", "fingerprint", "summary", "evidence", "redaction", "ownerChat", "runbook", "recovered"]);
const EVIDENCE_KEYS = new Set(["exitCode", "stderrTail", "journalTail", "recentChanges", "snapshot"]);

export function defaultSeverity(failureClass: FailureClass, hints: SeverityHints = {}): Severity {
  if (hints.dataAtRisk) return "critical";
  if (hints.severity && SEVERITY_SET.has(hints.severity)) return hints.severity;
  return SEVERITY_FOR_CLASS[failureClass];
}

/** Digit runs and hex ids in the key collapse so a pid or timestamp does not split one incident. */
export function fingerprint(host: string, component: string, failureClass: string, key?: string): string {
  const parts = [host.toLowerCase(), component.toLowerCase(), failureClass.toLowerCase()];
  if (key !== undefined) parts.push(key.toLowerCase().replace(/[0-9a-f]{8,}/g, "#").replace(/\d{2,}/g, "#"));
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function fail(error: string): PacketParse {
  return { ok: false, error };
}

function unknownKey(record: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(record)) if (!allowed.has(key)) return key;
  return null;
}

export function parsePacket(value: unknown): PacketParse {
  try {
    if (!isRecord(value)) return fail("packet must be an object");
    const extra = unknownKey(value, TOP_KEYS);
    if (extra) return fail(`unknown field ${extra}`);
    if (value.version !== 1) return fail("version must be 1");
    if (typeof value.host !== "string" || value.host.trim() === "" || value.host.length > 200) return fail("host must be a non-empty string");
    if (typeof value.component !== "string" || value.component.trim() === "" || value.component.length > 200) return fail("component must be a non-empty string");
    if (typeof value.severity !== "string" || !SEVERITY_SET.has(value.severity)) return fail("severity must be critical, warning, or info");
    if (typeof value.failureClass !== "string" || !CLASS_SET.has(value.failureClass)) return fail("unknown failure class");
    if (!isTime(value.firstSeen) || !isTime(value.lastSeen)) return fail("firstSeen and lastSeen must be timestamps");
    if (typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 1_000_000_000) return fail("count must be a positive integer");
    if (typeof value.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(value.fingerprint)) return fail("fingerprint must be 16 hex characters");
    if (typeof value.summary !== "string") return fail("summary must be a string");
    if (!isRecord(value.evidence)) return fail("evidence must be an object");
    const evidenceExtra = unknownKey(value.evidence, EVIDENCE_KEYS);
    if (evidenceExtra) return fail(`unknown evidence field ${evidenceExtra}`);
    if (!isRecord(value.redaction)) return fail("redaction must be an object");
    const redactionExtra = unknownKey(value.redaction, new Set(["applied", "rules"]));
    if (redactionExtra) return fail(`unknown redaction field ${redactionExtra}`);
    if (typeof value.redaction.applied !== "boolean") return fail("redaction.applied must be a boolean");
    if (!Array.isArray(value.redaction.rules) || value.redaction.rules.some((rule) => typeof rule !== "string")) return fail("redaction.rules must be an array of strings");
    if (value.ownerChat !== null && (typeof value.ownerChat !== "string" || value.ownerChat.length > 200)) return fail("ownerChat must be a string or null");
    if (value.runbook !== null && (typeof value.runbook !== "string" || value.runbook.length > 200)) return fail("runbook must be a string or null");
    if (value.recovered !== undefined && typeof value.recovered !== "boolean") return fail("recovered must be a boolean");
    const evidence: IncidentEvidence = {};
    if (value.evidence.exitCode !== undefined) {
      if (typeof value.evidence.exitCode !== "number" || !Number.isSafeInteger(value.evidence.exitCode)) return fail("exitCode must be an integer");
      evidence.exitCode = value.evidence.exitCode;
    }
    if (value.evidence.stderrTail !== undefined) {
      if (typeof value.evidence.stderrTail !== "string") return fail("stderrTail must be a string");
      evidence.stderrTail = clip(value.evidence.stderrTail, 4000);
    }
    if (value.evidence.journalTail !== undefined) {
      if (typeof value.evidence.journalTail !== "string") return fail("journalTail must be a string");
      evidence.journalTail = clip(value.evidence.journalTail, 4000);
    }
    if (value.evidence.recentChanges !== undefined) {
      if (!Array.isArray(value.evidence.recentChanges) || value.evidence.recentChanges.some((item) => typeof item !== "string")) return fail("recentChanges must be an array of strings");
      evidence.recentChanges = value.evidence.recentChanges.slice(0, 20).map((item) => clip(item, 300));
    }
    if (value.evidence.snapshot !== undefined) {
      if (!isRecord(value.evidence.snapshot)) return fail("snapshot must be an object");
      const entries = Object.entries(value.evidence.snapshot);
      if (entries.length > 40) return fail("snapshot has too many fields");
      const snapshot: Record<string, string | number | boolean | null> = {};
      for (const [key, item] of entries) {
        if (key.length === 0 || key.length > 80) return fail("snapshot field name is invalid");
        if (typeof item === "string") snapshot[key] = clip(item, 2000);
        else if (typeof item === "number") {
          if (!Number.isFinite(item)) return fail("snapshot numbers must be finite");
          snapshot[key] = item;
        } else if (typeof item === "boolean" || item === null) snapshot[key] = item;
        else return fail("snapshot values must be scalar");
      }
      evidence.snapshot = snapshot;
    }
    const packet: IncidentPacket = {
      version: 1,
      host: value.host.trim(),
      component: value.component.trim(),
      severity: value.severity as Severity,
      failureClass: value.failureClass as FailureClass,
      firstSeen: value.firstSeen,
      lastSeen: value.lastSeen,
      count: value.count,
      fingerprint: value.fingerprint,
      summary: clip(value.summary, 300),
      evidence,
      redaction: { applied: value.redaction.applied, rules: value.redaction.rules.slice(0, 32).map((rule) => clip(rule, 64)) },
      ownerChat: value.ownerChat,
      runbook: value.runbook,
    };
    if (value.recovered !== undefined) packet.recovered = value.recovered;
    return { ok: true, packet };
  } catch {
    return fail("invalid packet");
  }
}

function taskResult(packet: IncidentPacket): number | null {
  const value = packet.evidence.snapshot?.taskResult;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const parsed = text.startsWith("0x") ? Number.parseInt(text, 16) : Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function launchdStatus(packet: IncidentPacket): number | null {
  const value = packet.evidence.snapshot?.launchdStatus;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRunning(packet: IncidentPacket): boolean {
  const value = packet.evidence.snapshot?.running;
  return value === true || value === 1 || value === "true";
}

export const FALSE_ALARMS: { id: string; matches: (packet: IncidentPacket) => boolean; reason: string }[] = [
  {
    id: "task-already-running",
    reason: "Task Scheduler result 267009 (0x41301) means the task is already running.",
    matches: (packet) => taskResult(packet) === 267009,
  },
  {
    id: "watchdog-already-running",
    reason: "Result 2147946720 on a minute watchdog means the watchdog found its task already running.",
    matches: (packet) => taskResult(packet) === 2147946720 && /minute-watchdog/i.test(packet.component),
  },
  {
    id: "launchd-signal-while-running",
    reason: "A launchd exit of -9 or -15 while the job is running is a stop signal, not a failure.",
    matches: (packet) => {
      const status = launchdStatus(packet);
      return (status === -9 || status === -15) && isRunning(packet);
    },
  },
];

export function isFalseAlarm(packet: IncidentPacket): boolean {
  return FALSE_ALARMS.some((alarm) => alarm.matches(packet));
}
