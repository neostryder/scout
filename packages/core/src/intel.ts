import type { Db } from "./db.ts";

// Upstream facts that do not fit one version number: the latest revision of a Hugging Face repository, the
// variants and possible successors of a model, how far a clone sits behind its upstream. A researcher writes one
// document per (package, source) and the catalog reads it back; the latest document replaces the earlier one.

export interface IntelRow {
  packageId: number;
  source: string;
  fetchedAt: string;
  /** The parsed document. Shape is owned by the source that wrote it. */
  data: Record<string, unknown>;
}

export function putIntel(db: Db, packageId: number, source: string, data: Record<string, unknown>, fetchedAt: string): void {
  db.prepare(
    "INSERT INTO source_intel (package_id, source, fetched_at, data_json) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(package_id, source) DO UPDATE SET fetched_at = excluded.fetched_at, data_json = excluded.data_json",
  ).run(packageId, source, fetchedAt, JSON.stringify(data));
}

export function getIntel(db: Db, packageId: number, source: string): IntelRow | null {
  const row = db.prepare("SELECT fetched_at, data_json FROM source_intel WHERE package_id = ? AND source = ?").get(packageId, source) as { fetched_at: string; data_json: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    return { packageId, source, fetchedAt: row.fetched_at, data: data as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function listIntel(db: Db, packageId: number): IntelRow[] {
  const rows = db.prepare("SELECT source FROM source_intel WHERE package_id = ? ORDER BY source").all(packageId) as { source: string }[];
  return rows.flatMap((row) => {
    const intel = getIntel(db, packageId, row.source);
    return intel ? [intel] : [];
  });
}
