import type { Db } from "./db.ts";

export interface ChangelogSummary {
  packageId: number;
  version: string;
  summary: string;
  sourceUrl: string;
  model: string;
  flagsJson: string | null;
  createdAt: string;
}

export function recordChangelogSummary(db: Db, input: Omit<ChangelogSummary, "createdAt" | "flagsJson">, now = new Date().toISOString()): void {
  db.prepare("INSERT INTO changelog_summaries (package_id, version, summary, source_url, model, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(package_id, version) DO NOTHING").run(input.packageId, input.version, input.summary, input.sourceUrl, input.model, now);
}

const COLUMNS = "package_id AS packageId, version, summary, source_url AS sourceUrl, model, flags_json AS flagsJson, created_at AS createdAt";

export function changelogSummaryFor(db: Db, packageId: number, version: string): ChangelogSummary | null {
  return db.prepare(`SELECT ${COLUMNS} FROM changelog_summaries WHERE package_id = ? AND version = ?`).get(packageId, version) as unknown as ChangelogSummary | undefined ?? null;
}

export function listChangelogSummaries(db: Db, packageIds: number[]): ChangelogSummary[] {
  if (!packageIds.length) return [];
  return db.prepare(`SELECT ${COLUMNS} FROM changelog_summaries WHERE package_id IN (${packageIds.map(() => "?").join(",")}) ORDER BY package_id, version`).all(...packageIds) as unknown as ChangelogSummary[];
}
