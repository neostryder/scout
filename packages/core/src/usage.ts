import type { Db } from "./db.ts";
import type { Probe, ProbeContext, ProbeOutputs } from "./adapter.ts";

// Usage collection. A usage adapter reads one usage source (Spotlight, the process list, UserAssist) and names which
// installs each reading is about. Like an inventory adapter it never touches a machine: it lists fixed probes and parses
// their recorded output, so it is tested against fixtures.

/** Which install a reading is about. Exactly one field is set. */
export type UsageMatch =
  | { path: string } // the install's location equals this path, or contains it (a process inside an app folder)
  | { name: string; ecosystem?: never; key?: never }
  | { ecosystem: string; key: string }; // a package by identity, for sources that report identities rather than paths

export interface UsageSignalRecord {
  match: UsageMatch;
  /** last_used | use_count | running | autostart | referenced | ai_use_7d | ai_use_30d | ai_last_used | dependent */
  kind: string;
  /** ISO time for last_used, a decimal count, or "1" and "0" for flags. null means the source was readable and the thing has no record. */
  value: string | null;
  /** False when the source could not be read, so the absence of a value proves nothing. */
  available: boolean;
}

export interface UsageResult {
  /** spotlight | processes | userassist | ... */
  origin: string;
  status: "ok" | "partial" | "failed" | "skipped";
  signals: UsageSignalRecord[];
  /** Kinds this source reports for every install it can see. An install with a location and no positive reading gets "0". */
  completeFor?: string[];
  message?: string;
}

export interface UsageAdapter {
  origin: string;
  os: ReadonlyArray<"macos" | "windows" | "linux">;
  probes(ctx: ProbeContext): Probe[];
  parse(outputs: ProbeOutputs): UsageResult;
}

const norm = (p: string): string => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

interface Target {
  id: number;
  loc: string;
  ecosystem: string;
  key: string;
}

function targets(db: Db, machineId: string): Target[] {
  return (
    db
      .prepare(
        `SELECT i.id, i.location, p.ecosystem, p.key FROM installs i JOIN packages p ON p.id = i.package_id
         WHERE i.machine_id = ? AND i.removed_at IS NULL`,
      )
      .all(machineId) as unknown as { id: number; location: string; ecosystem: string; key: string }[]
  ).map((r) => ({ id: r.id, loc: norm(r.location), ecosystem: r.ecosystem, key: r.key }));
}

/** The installs a reading is about: an exact location, or the deepest install whose folder contains the path. */
function resolve(all: Target[], match: UsageMatch): number[] {
  if ("name" in match) {
    const executable = (value: string): string => norm(value).split("/").at(-1)?.replace(/\.(exe|cmd|bat)$/, "") ?? "";
    const name = executable(match.name);
    return all.filter((t) => name !== "" && (executable(t.loc) === name || executable(t.key) === name)).map((t) => t.id);
  }
  if ("path" in match) {
    const p = norm(match.path);
    const exact = all.filter((t) => t.loc !== "" && t.loc === p);
    if (exact.length > 0) return exact.map((t) => t.id);
    const containing = all.filter((t) => t.loc.length > 3 && p.startsWith(`${t.loc}/`));
    if (containing.length === 0) return [];
    const deepest = Math.max(...containing.map((t) => t.loc.length));
    return containing.filter((t) => t.loc.length === deepest).map((t) => t.id);
  }
  return all.filter((t) => t.ecosystem === match.ecosystem && t.key === match.key).map((t) => t.id);
}

export interface UsageSummary {
  signals: number;
  unmatched: number;
}

/**
 * Store a usage result for one machine. The newest reading of a kind replaces the earlier one for an install. A
 * source listed in `completeFor` also writes "0" for every located install it saw no positive reading for.
 */
export function recordUsage(db: Db, machineId: string, result: UsageResult, now: string): UsageSummary {
  const summary: UsageSummary = { signals: 0, unmatched: 0 };
  if (result.status === "failed" || result.status === "skipped") return summary;
  const all = targets(db, machineId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const clear = db.prepare("DELETE FROM usage_signals WHERE install_id = ? AND kind = ? AND origin = ?");
    const put = db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, ?, ?, ?)");
    const seen = new Set<string>();
    for (const s of result.signals) {
      const ids = resolve(all, s.match);
      if (ids.length === 0) summary.unmatched++;
      for (const id of ids) {
        const k = `${id}|${s.kind}`;
        // Several readings of the same kind for one install (two processes of one app): a "0" never replaces an
        // earlier reading, and any other value replaces it, so one row remains.
        if (seen.has(k) && s.value === "0") continue;
        clear.run(id, s.kind, result.origin);
        seen.add(k);
        put.run(id, s.kind, s.value, s.available ? 1 : 0, result.origin, now);
        summary.signals++;
      }
    }
    for (const kind of result.completeFor ?? []) {
      for (const t of all) {
        if ((t.loc === "" && !kind.startsWith("ai_use_")) || seen.has(`${t.id}|${kind}`)) continue;
        clear.run(t.id, kind, result.origin);
        put.run(t.id, kind, "0", 1, result.origin, now);
        summary.signals++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}

/** Signals the catalog already implies: a service's state and start mode, launchd's run-at-load, a container's state. */
export function deriveUsage(db: Db, now = new Date().toISOString()): { signals: number } {
  const rows = db
    .prepare(
      `SELECT i.id, p.ecosystem, i.details_json FROM installs i JOIN packages p ON p.id = i.package_id
       WHERE i.removed_at IS NULL AND p.ecosystem IN ('service', 'launchd', 'image')`,
    )
    .all() as unknown as { id: number; ecosystem: string; details_json: string }[];
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM usage_signals WHERE origin = 'catalog'");
    const put = db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, 1, 'catalog', ?)");
    for (const r of rows) {
      const d = JSON.parse(r.details_json) as Record<string, unknown>;
      const flag = (kind: string, on: boolean) => {
        put.run(r.id, kind, on ? "1" : "0", now);
        count++;
      };
      if (r.ecosystem === "service") {
        flag("running", d["state"] === "Running");
        flag("autostart", d["startMode"] === "Auto");
      } else if (r.ecosystem === "launchd") {
        flag("autostart", d["runAtLoad"] === true || d["keepAlive"] === true);
      } else if (r.ecosystem === "image") {
        flag("running", d["state"] === "running");
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { signals: count };
}

const INHERITED_KINDS = ["last_used", "use_count", "running"];

/**
 * Installs of one item on one machine are one piece of software seen by different sources (a winget entry and its
 * registry entry). Usage is read by folder, so only the install that knows its folder gets a reading. An install with
 * no reading of its own takes the newest last use, the highest use count, and whether any sibling is running.
 * Rebuilt on every scan; never overwrites a reading the install has itself.
 */
export function inheritUsage(db: Db, now = new Date().toISOString()): { signals: number } {
  const rows = db
    .prepare(
      `SELECT t.id AS target, u.kind, u.value FROM installs t
         JOIN item_links lt ON lt.package_id = t.package_id
         JOIN item_links ls ON ls.item_id = lt.item_id
         JOIN installs s ON s.package_id = ls.package_id AND s.machine_id = t.machine_id AND s.id != t.id AND s.removed_at IS NULL
         JOIN usage_signals u ON u.install_id = s.id AND u.available = 1 AND u.value IS NOT NULL AND u.origin != 'item'
       WHERE t.removed_at IS NULL AND u.kind IN ('last_used', 'use_count', 'running')
         AND NOT EXISTS (SELECT 1 FROM usage_signals own WHERE own.install_id = t.id AND own.kind = u.kind AND own.available = 1 AND own.origin != 'item')`,
    )
    .all() as unknown as { target: number; kind: string; value: string }[];
  const best = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.target}|${r.kind}`;
    const old = best.get(key);
    const better = old === undefined ? true : r.kind === "use_count" ? BigInt(r.value) > BigInt(old) : r.value > old; // ISO times and "0"/"1" compare as text
    if (better) best.set(key, r.value);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM usage_signals WHERE origin = 'item'");
    const put = db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, 1, 'item', ?)");
    for (const [key, value] of best) {
      const [id, kind] = key.split("|") as [string, string];
      if (INHERITED_KINDS.includes(kind)) put.run(Number(id), kind, value, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { signals: best.size };
}
