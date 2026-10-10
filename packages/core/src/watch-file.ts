import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// `.scout-data/watch.json` holds what the outage watch skips. Everything is watched until a switch here says otherwise, so a missing file
// means "watch everything". The Outages page writes this file; it can be edited by hand too.

export interface WatchConfig {
  /** No checks count and no notices go out until this time (maintenance). */
  pausedUntil: string | null;
  /** `false` switches off every check for one machine. */
  machines: Record<string, boolean>;
  /** `false` switches off one kind of check on every machine. */
  checks: { machine: boolean; url: boolean; service: boolean };
  /** `false` switches off one item by its watch key. */
  items: Record<string, boolean>;
  fileError: string | null;
}

export const DEFAULT_WATCH: WatchConfig = { pausedUntil: null, machines: {}, checks: { machine: true, url: true, service: true }, items: {}, fileError: null };

export function defaultWatchConfig(): WatchConfig {
  return { ...DEFAULT_WATCH, machines: {}, checks: { ...DEFAULT_WATCH.checks }, items: {} };
}

export function isPaused(config: WatchConfig, now: string): boolean {
  return config.pausedUntil !== null && Date.parse(config.pausedUntil) > Date.parse(now);
}

export function isWatched(config: WatchConfig, kind: "machine" | "url" | "service", machineId: string | null, key: string, now: string): boolean {
  if (isPaused(config, now) || !config.checks[kind]) return false;
  if (machineId !== null && config.machines[machineId] === false) return false;
  return config.items[key] !== false;
}

function boolMap(value: unknown, name: string): Record<string, boolean> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const out: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag !== "boolean" || key.length === 0 || key.length > 500) throw new Error(`${name} entries must be booleans`);
    out[key] = flag;
  }
  return out;
}

/** Checks a parsed file or a page edit and returns the config; throws on anything malformed. */
export function parseWatchConfig(data: unknown): WatchConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid watch file");
  const { pausedUntil = null, machines, checks, items } = data as Record<string, unknown>;
  if (pausedUntil !== null && (typeof pausedUntil !== "string" || !Number.isFinite(Date.parse(pausedUntil)))) throw new Error("pausedUntil must be a date or null");
  const kinds = checks === undefined ? {} : boolMap(checks, "checks");
  for (const key of Object.keys(kinds)) if (key !== "machine" && key !== "url" && key !== "service") throw new Error(`unknown check kind ${key}`);
  return {
    pausedUntil: pausedUntil === null ? null : new Date(Date.parse(pausedUntil as string)).toISOString(),
    machines: boolMap(machines, "machines"),
    checks: { machine: kinds["machine"] ?? true, url: kinds["url"] ?? true, service: kinds["service"] ?? true },
    items: boolMap(items, "items"),
    fileError: null,
  };
}

export function watchFileReader(path: string): () => WatchConfig {
  let stamp: string | null = null;
  let cached = defaultWatchConfig();
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      observed = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === observed) return cached;
      cached = parseWatchConfig(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      cached = { ...defaultWatchConfig(), fileError: missing ? null : "The watch file is malformed or unreadable; everything is watched until it is fixed." };
    }
    stamp = observed;
    return cached;
  };
}

/** Applies a page edit to the file: set or clear a pause, and switch a machine, a kind of check or one item on or off. Writes atomically. */
export function updateWatchFile(path: string, current: WatchConfig, body: Record<string, unknown>): WatchConfig {
  const next: WatchConfig = { ...current, machines: { ...current.machines }, checks: { ...current.checks }, items: { ...current.items }, fileError: null };
  const allowed = new Set(["pausedUntil", "machine", "check", "item", "watched"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new Error(`unknown field ${key}`);
  if ("pausedUntil" in body) {
    const value = body["pausedUntil"];
    if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) throw new Error("pausedUntil must be a date or null");
    next.pausedUntil = value === null ? null : new Date(Date.parse(value as string)).toISOString();
  }
  const targets = ["machine", "check", "item"].filter((name) => name in body);
  if (targets.length > 1 || targets.length === 1 && typeof body["watched"] !== "boolean") throw new Error("set one of machine, check or item together with watched");
  if (targets.length === 1) {
    const name = targets[0]!;
    const target = body[name];
    const watched = body["watched"] as boolean;
    if (typeof target !== "string" || target.length === 0 || target.length > 500) throw new Error(`${name} must be a string`);
    if (name === "check") {
      if (target !== "machine" && target !== "url" && target !== "service") throw new Error("check must be machine, url or service");
      next.checks[target] = watched;
    } else {
      const map = name === "machine" ? next.machines : next.items;
      // Switching back on removes the entry so the file only lists what is off.
      if (watched) delete map[target]; else map[target] = false;
    }
  }
  const out = { pausedUntil: next.pausedUntil, machines: next.machines, checks: next.checks, items: next.items };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return next;
}
