import type { Db } from "./db.ts";

export interface SupportWindow {
  cycle: string;
  eol: string | boolean | null;
  latest: string | null;
  lts: boolean;
}

export interface StoredSupportWindow extends Omit<SupportWindow, "eol"> {
  packageId: number;
  eol: string | null;
  eolPassed: boolean;
  observedAt: string;
}

export function supportEnded(eol: SupportWindow["eol"], now: string): boolean {
  return eol === true || (typeof eol === "string" && eol < now.slice(0, 10));
}

export function recordSupportWindows(db: Db, packageId: number, windows: SupportWindow[], now = new Date().toISOString()): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM support_windows WHERE package_id = ?").run(packageId);
    const insert = db.prepare("INSERT INTO support_windows (package_id, cycle, eol, eol_passed, latest, lts, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const window of windows) insert.run(packageId, window.cycle, typeof window.eol === "string" ? window.eol : null, supportEnded(window.eol, now) ? 1 : 0, window.latest, window.lts ? 1 : 0, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function supportWindowsOf(db: Db, packageId: number): StoredSupportWindow[] {
  return (db.prepare("SELECT package_id AS packageId, cycle, eol, eol_passed AS eolPassed, latest, lts, observed_at AS observedAt FROM support_windows WHERE package_id = ? ORDER BY cycle").all(packageId) as unknown as (Omit<StoredSupportWindow, "eolPassed" | "lts"> & { eolPassed: number; lts: number })[]).map((row) => ({ ...row, eolPassed: row.eolPassed === 1, lts: row.lts === 1 }));
}
