import type { Db } from "./db.ts";
import type { UpdateBump } from "./updates-query.ts";

export type AutoBump = "patch" | "minor" | "major";
export const AUTO_BUMPS: readonly AutoBump[] = ["patch", "minor", "major"];
export const DEFAULT_AUTO_BUMP: AutoBump = "minor";

export interface AutoUpdate {
  machineId: string;
  packageId: number;
  name: string;
  ecosystem: string;
  /** The biggest version step the automatic run may take for this software. */
  maxBump: AutoBump;
  createdAt: string;
}

export const isAutoBump = (value: unknown): value is AutoBump => AUTO_BUMPS.includes(value as AutoBump);

/** Every opted-in package, by machine and then name. */
export function listAutoUpdates(db: Db): AutoUpdate[] {
  const rows = db.prepare("SELECT a.machine_id AS machineId, a.package_id AS packageId, p.name AS name, p.ecosystem AS ecosystem, a.max_bump AS maxBump, a.created_at AS createdAt FROM auto_updates a JOIN packages p ON p.id = a.package_id ORDER BY a.machine_id, p.name").all() as unknown as AutoUpdate[];
  return rows;
}

/** Opts the install's package in on its machine, or out with `null`. Returns the saved row, or null when it was removed or the install does not exist. */
export function setAutoUpdate(db: Db, installId: number, maxBump: AutoBump | null, now = new Date()): AutoUpdate | null {
  const install = db.prepare("SELECT machine_id AS machineId, package_id AS packageId FROM installs WHERE id = ? AND removed_at IS NULL").get(installId) as { machineId: string; packageId: number } | undefined;
  if (!install) throw new Error("no such install");
  if (maxBump === null) {
    db.prepare("DELETE FROM auto_updates WHERE machine_id = ? AND package_id = ?").run(install.machineId, install.packageId);
    return null;
  }
  if (!isAutoBump(maxBump)) throw new Error(`maxBump must be one of ${AUTO_BUMPS.join(", ")}`);
  db.prepare("INSERT INTO auto_updates (machine_id, package_id, max_bump, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (machine_id, package_id) DO UPDATE SET max_bump = excluded.max_bump").run(install.machineId, install.packageId, maxBump, now.toISOString());
  return listAutoUpdates(db).find((entry) => entry.machineId === install.machineId && entry.packageId === install.packageId) ?? null;
}

/** Whether the automatic run may apply this update: the install's package is opted in and the step is no bigger than its limit. A step the catalog cannot classify counts as a major one. */
export function autoUpdateAllows(db: Db, installId: number, bump: UpdateBump | null): boolean {
  const row = db.prepare("SELECT a.max_bump AS maxBump FROM auto_updates a JOIN installs i ON i.machine_id = a.machine_id AND i.package_id = a.package_id WHERE i.id = ?").get(installId) as { maxBump: AutoBump } | undefined;
  if (!row) return false;
  const rank = (value: string | null): number => (value === "patch" ? 0 : value === "minor" ? 1 : 2);
  return rank(bump) <= rank(row.maxBump);
}
