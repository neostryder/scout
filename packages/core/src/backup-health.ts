import { readFileSync, statSync } from "node:fs";
import type { OutageNotice } from "./outages.ts";

// Galadriel, the disk-mirror backup on the hub machine, rewrites a health file every minute. Scout reads that file and raises one alert while the
// backup is critical or its daemon has stopped writing. `.scout-data/backup-health.json` can move the path or change the staleness limit.

export type BackupLevel = "ok" | "warn" | "critical";

export interface BackupReason { kind: string; level: BackupLevel; message: string }

export interface BackupHealth {
  level: BackupLevel;
  reasons: BackupReason[];
  lastSuccess: string | null;
  hoursSinceSuccess: number | null;
  destinationPresent: boolean | null;
  updated: string;
}

/**
 * What the health file says right now. `not-installed` is a missing file and never alerts. `unknown` is a file that cannot be read or understood while
 * it was written recently, which a rewrite in progress can cause, so it neither raises nor clears anything.
 */
export type BackupReading =
  | { state: "not-installed" }
  | { state: "unknown"; message: string }
  | { state: BackupLevel; health: BackupHealth }
  | { state: "daemon-down"; health: BackupHealth | null; staleMinutes: number };

export interface BackupHealthSettings {
  enabled: boolean;
  path: string;
  /** The file counts as stale, and the daemon as down, once its `updated` stamp is this many minutes old. */
  staleMinutes: number;
  fileError: string | null;
}

export const DEFAULT_BACKUP_HEALTH_PATH = "C:/ProgramData/Galadriel/health.json";
export const DEFAULT_BACKUP_STALE_MINUTES = 3;

export function defaultBackupHealthSettings(): BackupHealthSettings {
  return { enabled: true, path: DEFAULT_BACKUP_HEALTH_PATH, staleMinutes: DEFAULT_BACKUP_STALE_MINUTES, fileError: null };
}

/** Checks a parsed settings file, filling anything missing with the defaults; throws on anything malformed. */
export function parseBackupHealthSettings(data: unknown): BackupHealthSettings {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid backup health file");
  const { enabled = true, path = DEFAULT_BACKUP_HEALTH_PATH, staleMinutes = DEFAULT_BACKUP_STALE_MINUTES, ...rest } = data as Record<string, unknown>;
  for (const key of Object.keys(rest)) throw new Error(`unknown field ${key}`);
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  if (typeof path !== "string" || path.length === 0 || path.length > 500) throw new Error("path must be a non-empty string");
  if (typeof staleMinutes !== "number" || !Number.isFinite(staleMinutes) || staleMinutes < 1 || staleMinutes > 1440) throw new Error("staleMinutes must be a number from 1 to 1440");
  return { enabled, path, staleMinutes, fileError: null };
}

export function backupHealthSettingsReader(path: string): () => BackupHealthSettings {
  let stamp: string | null = null;
  let cached = defaultBackupHealthSettings();
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      observed = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === observed) return cached;
      cached = parseBackupHealthSettings(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      cached = { ...defaultBackupHealthSettings(), fileError: missing ? null : "The backup health settings file is malformed or unreadable; the defaults apply until it is fixed." };
    }
    stamp = observed;
    return cached;
  };
}

const LEVELS: readonly string[] = ["ok", "warn", "critical"];
const text = (value: unknown, max: number): string => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Reads the document Galadriel writes. Throws when it is not an object or has no valid level and `updated` stamp. */
export function parseBackupHealth(raw: unknown): BackupHealth {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("health document is not an object");
  const doc = raw as Record<string, unknown>;
  if (typeof doc["level"] !== "string" || !LEVELS.includes(doc["level"])) throw new Error("health document has no valid level");
  if (typeof doc["updated"] !== "string" || Number.isNaN(Date.parse(doc["updated"]))) throw new Error("health document has no valid updated stamp");
  const reasons: BackupReason[] = [];
  if (Array.isArray(doc["reasons"])) for (const entry of doc["reasons"]) {
    if (!entry || typeof entry !== "object") continue;
    const reason = entry as Record<string, unknown>;
    if (typeof reason["level"] !== "string" || !LEVELS.includes(reason["level"])) continue;
    reasons.push({ kind: text(reason["kind"], 60), level: reason["level"] as BackupLevel, message: text(reason["message"], 300) });
  }
  return {
    level: doc["level"] as BackupLevel,
    reasons,
    lastSuccess: typeof doc["last_success"] === "string" && !Number.isNaN(Date.parse(doc["last_success"])) ? doc["last_success"] : null,
    hoursSinceSuccess: number(doc["hours_since_success"]),
    destinationPresent: typeof doc["destination_present"] === "boolean" ? doc["destination_present"] : null,
    updated: doc["updated"],
  };
}

/** Turns the file's text (or its absence) into a reading. A stamp older than the limit means the daemon is down whatever level the file still shows. */
export function readBackupHealth(settings: BackupHealthSettings, nowMs: number, read: (path: string) => { text: string; mtimeMs: number } | null): BackupReading {
  if (!settings.enabled) return { state: "not-installed" };
  const file = read(settings.path);
  if (file === null) return { state: "not-installed" };
  const limitMs = settings.staleMinutes * 60_000;
  let health: BackupHealth;
  try {
    health = parseBackupHealth(JSON.parse(file.text));
  } catch (err) {
    // A rewrite in progress can leave the file unreadable for a moment; only a file nobody has touched for the limit counts as a stopped daemon.
    return nowMs - file.mtimeMs > limitMs ? { state: "daemon-down", health: null, staleMinutes: settings.staleMinutes } : { state: "unknown", message: (err as Error).message };
  }
  if (nowMs - Date.parse(health.updated) > limitMs) return { state: "daemon-down", health, staleMinutes: settings.staleMinutes };
  return { state: health.level, health };
}

export function readBackupHealthFile(settings: BackupHealthSettings, nowMs: number = Date.now()): BackupReading {
  return readBackupHealth(settings, nowMs, (path) => {
    try { return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs }; } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { text: "", mtimeMs: 0 };
    }
  });
}

export interface BackupAlert { severity: "high"; title: string; detail: string }

/** `alert` when the reading calls for an alert, `clear` when it does not, `hold` when it says nothing either way. */
export function backupAlertState(reading: BackupReading): "alert" | "clear" | "hold" {
  return reading.state === "critical" || reading.state === "daemon-down" ? "alert" : reading.state === "unknown" ? "hold" : "clear";
}

const hoursText = (hours: number): string => hours < 1 ? "under an hour" : hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;

/** The alert text for a reading that calls for one, or null. */
export function backupAlert(reading: BackupReading, machine: string): BackupAlert | null {
  if (reading.state === "daemon-down") {
    const since = reading.health ? ` The last update was at ${reading.health.updated}.` : "";
    return { severity: "high", title: `Backup service is not running on ${machine}`, detail: `The Galadriel health file has not been rewritten for ${reading.staleMinutes} minutes, so the backup service looks stopped.${since}` };
  }
  if (reading.state !== "critical") return null;
  const { health } = reading;
  const critical = health.reasons.filter((reason) => reason.level === "critical").map((reason) => reason.message).filter((message) => message.length > 0);
  const lead = critical.length > 0 ? critical.join(" ") : "The backup reports a critical problem.";
  const last = health.hoursSinceSuccess === null ? "" : ` The last complete pass was ${hoursText(health.hoursSinceSuccess)} ago.`;
  return { severity: "high", title: `Backup is critical on ${machine}`, detail: `${lead}${last}` };
}

/** The quiet notices for a change between two readings: one when the alert is raised and one when it clears. */
export function backupNotice(before: "alert" | "clear" | "hold", after: "alert" | "clear" | "hold", reading: BackupReading, machine: string): OutageNotice | null {
  if (before === "hold" || after === "hold" || before === after) return null;
  if (after === "alert") {
    const alert = backupAlert(reading, machine);
    return alert ? { title: alert.title, body: alert.detail, severity: "high" } : null;
  }
  return { title: `Backup is healthy again on ${machine}`, body: `The Galadriel backup on ${machine} is no longer critical.`, severity: "info" };
}
