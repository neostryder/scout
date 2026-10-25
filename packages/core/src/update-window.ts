import type { Db } from "./db.ts";

const DAY_MINUTES = 1_440;
/** The quiet window starts at 03:30 local time and runs two hours. */
export const QUIET_START_MINUTE = 210;
export const QUIET_WINDOW_MINUTES = 120;

export interface QuietWindow {
  /** Minutes after local midnight the window starts. */
  startMinute: number;
  lengthMinutes: number;
  /** The start of the window under way, or the next start when none is. */
  startsAt: string;
  endsAt: string;
  inWindow: boolean;
}

const mod = (value: number, size: number): number => ((value % size) + size) % size;

/** The fixed local quiet window around `now`: the one under way, or the next one. `offsetMinutes` is the local clock's offset from UTC. */
export function quietWindow(now: Date, offsetMinutes = -now.getTimezoneOffset()): QuietWindow {
  const nowMinutes = Math.floor(now.getTime() / 60_000);
  const sinceStart = mod(nowMinutes + offsetMinutes - QUIET_START_MINUTE, DAY_MINUTES);
  const inWindow = sinceStart < QUIET_WINDOW_MINUTES;
  const startMinutes = inWindow ? nowMinutes - sinceStart : nowMinutes + (DAY_MINUTES - sinceStart);
  return {
    startMinute: QUIET_START_MINUTE, lengthMinutes: QUIET_WINDOW_MINUTES,
    startsAt: new Date(startMinutes * 60_000).toISOString(), endsAt: new Date((startMinutes + QUIET_WINDOW_MINUTES) * 60_000).toISOString(), inWindow,
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
