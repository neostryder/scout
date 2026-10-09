import type { Db } from "./db.ts";
import { compareVersions } from "./version.ts";
import { PRIORITY_WEIGHTS, PRIORITY_BUMP_VALUES, PRIORITY_STEP_LIMITS, PRIORITY_USAGE_WINDOWS, PRIORITY_UNKNOWN_USAGE, PRIORITY_EXPOSED_KINDS, PRIORITY_EXPOSED_CATEGORIES } from "./decisions.ts";

export interface PriorityFlags {
  breaking?: boolean;
  security?: boolean;
  migration?: boolean;
  removed?: boolean;
}

export interface PriorityInput {
  installed: string | null;
  available: string | null;
  now: string;
  bump?: keyof typeof PRIORITY_BUMP_VALUES | null;
  lastUsed?: string | null;
  running?: boolean;
  kind?: string;
  category?: string | null;
  blocked?: boolean;
  frozen?: boolean;
  advisoryOnly?: boolean;
  flags?: PriorityFlags;
}

export interface PriorityPart {
  name: string;
  value: number;
  weight: number;
}

export type PriorityWeights = Partial<Record<keyof typeof PRIORITY_WEIGHTS, number>>;

function behindValue(input: PriorityInput): number {
  const { installed, available } = input;
  if (installed === null || available === null) return 0;
  const comparison = compareVersions(available, installed);
  if (comparison !== null && comparison <= 0) return 0;
  const numbers = (v: string): bigint[] => [...v.matchAll(/\d+/g)].map((m) => BigInt(m[0]));
  const from = numbers(installed);
  const to = numbers(available);
  const changed = Array.from({ length: Math.max(from.length, to.length) }, (_, n) => (from[n] ?? 0n) !== (to[n] ?? 0n)).indexOf(true);
  const bump = input.bump ?? (comparison === null ? "other" : changed === 0 ? "major" : changed === 1 ? "minor" : "patch");
  const base = PRIORITY_BUMP_VALUES[bump];
  // Only dotted release numbers give a reliable count of minor or patch steps.
  if ((bump !== "minor" && bump !== "patch") || !/^v?\d+(\.\d+)*$/i.test(installed) || !/^v?\d+(\.\d+)*$/i.test(available)) return base;
  const index = bump === "minor" ? 1 : 2;
  if (from.slice(0, index).some((n, i) => n !== (to[i] ?? 0n))) return base;
  const steps = (to[index] ?? 0n) - (from[index] ?? 0n);
  const limit = PRIORITY_STEP_LIMITS[bump];
  const extra = steps <= 1n ? 0 : steps >= BigInt(limit) ? 1 : Number(steps - 1n) / (limit - 1);
  return base + (1 - base) * extra;
}

export function priorityScore(input: PriorityInput, weights: PriorityWeights = {}): { score: number; parts: PriorityPart[] } {
  const days = input.lastUsed ? (Date.parse(input.now) - Date.parse(input.lastUsed)) / 86_400_000 : NaN;
  const usage = Number.isFinite(days) ? (PRIORITY_USAGE_WINDOWS.find((window) => days <= window.days)?.value ?? PRIORITY_UNKNOWN_USAGE) : PRIORITY_UNKNOWN_USAGE;
  const values = {
    behind: behindValue(input),
    usage,
    running: input.running ? 1 : 0,
    exposure: PRIORITY_EXPOSED_KINDS.some((kind) => kind === input.kind) || PRIORITY_EXPOSED_CATEGORIES.some((category) => category === input.category?.toLowerCase()) ? 1 : 0,
    security: input.flags?.security ? 1 : 0,
    breaking: input.flags?.breaking ? 1 : 0,
    migration: input.flags?.migration ? 1 : 0,
    removed: input.flags?.removed ? 1 : 0,
  };
  const parts = (Object.keys(values) as (keyof typeof values)[]).map((name) => ({ name, value: values[name], weight: weights[name] ?? PRIORITY_WEIGHTS[name] }));
  const total = parts.reduce((sum, part) => sum + part.value * part.weight, 0);
  return { score: input.blocked || input.frozen || input.advisoryOnly ? 0 : Math.max(0, Math.min(100, total)), parts };
}

export interface PriorityJudgeInput {
  packageId: number;
  ecosystem: string;
  key: string;
  version: string;
  changelog?: string;
}

export interface PriorityJudge {
  flags(input: PriorityJudgeInput): Promise<PriorityFlags | null>;
}

export const defaultPriorityJudge: PriorityJudge = { async flags() { return null; } };

function parseFlags(json: string): PriorityFlags | null {
  try {
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const flags: PriorityFlags = {};
    for (const name of ["breaking", "security", "migration", "removed"] as const) {
      if (name in value) {
        const flag = (value as Record<string, unknown>)[name];
        if (typeof flag !== "boolean") return null;
        flags[name] = flag;
      }
    }
    return flags;
  } catch {
    return null;
  }
}

export async function judgePriorityFlags(db: Db, input: PriorityJudgeInput, judge: PriorityJudge = defaultPriorityJudge, source = "judge", now = new Date().toISOString()): Promise<PriorityFlags | null> {
  const cached = db.prepare("SELECT flags_json FROM priority_flags WHERE package_id = ? AND version = ? AND source = ?").get(input.packageId, input.version, source) as { flags_json: string } | undefined;
  if (cached) {
    const flags = parseFlags(cached.flags_json);
    if (flags !== null) return flags;
  }
  const answer = await judge.flags(input);
  if (answer === null) return null;
  const flags = parseFlags(JSON.stringify(answer));
  if (flags === null) return null;
  db.prepare(
    `INSERT INTO priority_flags (package_id, version, flags_json, source, observed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(package_id, version, source) DO UPDATE SET flags_json = excluded.flags_json, observed_at = excluded.observed_at`,
  ).run(input.packageId, input.version, JSON.stringify(flags), source, now);
  return flags;
}

export function cachedPriorityFlags(db: Db): Map<number, Map<string, PriorityFlags>> {
  const result = new Map<number, Map<string, PriorityFlags>>();
  const rows = db.prepare("SELECT package_id AS packageId, version, flags_json AS json FROM priority_flags ORDER BY observed_at DESC, source").all() as { packageId: number; version: string; json: string }[];
  for (const row of rows) {
    const versions = result.get(row.packageId) ?? new Map<string, PriorityFlags>();
    const flags = parseFlags(row.json);
    if (flags === null || versions.has(row.version)) continue;
    versions.set(row.version, flags);
    result.set(row.packageId, versions);
  }
  return result;
}
