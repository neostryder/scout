import type { Db } from "./db.ts";

const HOUR_MS = 3_600_000;
const DAY_MINUTES = 1_440;
export const DEFAULT_QUIET_HOUR = 3;
const MIN_SAMPLES_PER_HOUR = 3;
const MIN_HOURS_COVERED = 8;
export const QUIET_WINDOW_HOURS = 2;

export interface QuietHour {
  /** Local hour (0 to 23) the quiet window starts. */
  hour: number;
  /** The window is this many hours long. */
  length: number;
  /** "measured" comes from the machine's own CPU history, "default" from too little history. */
  basis: "measured" | "default";
  meanCpuPct: number | null;
  samples: number;
  /** The next start, or now when the window is under way. */
  startsAt: string;
  inWindow: boolean;
}

export interface CpuSample { at: string; cpuPct: number | null }

const mod = (value: number, size: number): number => ((value % size) + size) % size;
const hourOf = (at: string, offsetMinutes: number): number => Math.floor(mod(Date.parse(at) / 60_000 + offsetMinutes, DAY_MINUTES) / 60);
const circular = (hour: number, to: number): number => { const gap = Math.abs(hour - to); return Math.min(gap, 24 - gap); };

/** The next time the local clock reads `hour`:00, or `now` when `now` is inside the window that starts at `hour`. */
export function nextWindowStart(hour: number, length: number, now: Date, offsetMinutes: number): { startsAt: string; inWindow: boolean } {
  const localMinutes = mod(now.getTime() / 60_000 + offsetMinutes, DAY_MINUTES);
  const sinceStart = mod(localMinutes - hour * 60, DAY_MINUTES);
  if (sinceStart < length * 60) return { startsAt: now.toISOString(), inWindow: true };
  const untilStart = DAY_MINUTES - sinceStart;
  return { startsAt: new Date(Math.round(now.getTime() / 60_000 + untilStart) * 60_000).toISOString(), inWindow: false };
}

/** The quietest two-hour stretch of the day by mean CPU over the history, or a default night hour when the history is too thin to say. */
export function quietHour(samples: CpuSample[], now: Date, offsetMinutes = -now.getTimezoneOffset()): QuietHour {
  const sums = Array.from({ length: 24 }, () => ({ total: 0, count: 0 }));
  for (const sample of samples) {
    if (sample.cpuPct === null || !Number.isFinite(sample.cpuPct) || !Number.isFinite(Date.parse(sample.at))) continue;
    const bucket = sums[hourOf(sample.at, offsetMinutes)]!;
    bucket.total += sample.cpuPct;
    bucket.count++;
  }
  const covered = sums.filter((bucket) => bucket.count >= MIN_SAMPLES_PER_HOUR).length;
  let best: { hour: number; mean: number; count: number } | null = null;
  if (covered >= MIN_HOURS_COVERED) {
    for (let hour = 0; hour < 24; hour++) {
      const parts = Array.from({ length: QUIET_WINDOW_HOURS }, (_, k) => sums[(hour + k) % 24]!);
      if (parts.some((part) => part.count < MIN_SAMPLES_PER_HOUR)) continue;
      const count = parts.reduce((sum, part) => sum + part.count, 0);
      const mean = parts.reduce((sum, part) => sum + part.total, 0) / count;
      if (best === null || mean < best.mean - 0.05 || (Math.abs(mean - best.mean) <= 0.05 && circular(hour, DEFAULT_QUIET_HOUR) < circular(best.hour, DEFAULT_QUIET_HOUR))) best = { hour, mean, count };
    }
  }
  const hour = best?.hour ?? DEFAULT_QUIET_HOUR;
  return {
    hour, length: QUIET_WINDOW_HOURS, basis: best ? "measured" : "default",
    meanCpuPct: best ? Math.round(best.mean * 10) / 10 : null, samples: best?.count ?? samples.length,
    ...nextWindowStart(hour, QUIET_WINDOW_HOURS, now, offsetMinutes),
  };
}

export interface DependencyPair { fromId: number; toId: number }

/** Pairs among `ids` where the first install uses the second: the used one must be updated first. */
export function dependencyPairs(db: Db, ids: number[]): DependencyPair[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const rows = db.prepare(
    `SELECT e.from_install_id AS fromId, e.to_install_id AS toId FROM dependency_edges e
     JOIN installs i ON i.id = e.from_install_id JOIN installs t ON t.id = e.to_install_id
     WHERE i.removed_at IS NULL AND t.removed_at IS NULL`,
  ).all() as unknown as DependencyPair[];
  return rows.filter((row) => row.fromId !== row.toId && wanted.has(row.fromId) && wanted.has(row.toId)).map((row) => ({ fromId: row.fromId, toId: row.toId }));
}

/** What an install uses goes first. Ties keep the input order, and a cycle falls back to the input order for what is left. */
export function orderByDependencies(ids: number[], pairs: DependencyPair[]): number[] {
  const waiting = new Map<number, Set<number>>(ids.map((id) => [id, new Set<number>()]));
  for (const pair of pairs) if (waiting.has(pair.fromId) && waiting.has(pair.toId)) waiting.get(pair.fromId)!.add(pair.toId);
  const ordered: number[] = [];
  const left = [...ids];
  while (left.length > 0) {
    const index = left.findIndex((id) => [...waiting.get(id)!].every((need) => ordered.includes(need)));
    const [next] = left.splice(index < 0 ? 0 : index, 1);
    ordered.push(next!);
  }
  return ordered;
}

/** Groups of ids joined by a dependency pair, so a library and what uses it are never split across two runs. */
export function dependencyGroups(ids: number[], pairs: DependencyPair[]): number[][] {
  const parent = new Map<number, number>(ids.map((id) => [id, id]));
  const find = (id: number): number => { let root = id; while (parent.get(root) !== root) root = parent.get(root)!; return root; };
  for (const pair of pairs) if (parent.has(pair.fromId) && parent.has(pair.toId)) parent.set(find(pair.fromId), find(pair.toId));
  const groups = new Map<number, number[]>();
  for (const id of ids) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()];
}

export const WINDOW_HISTORY_MS = 7 * 24 * HOUR_MS;
