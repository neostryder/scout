import type { Db } from "./db.ts";
import type { ScanResult } from "./adapter.ts";
import { recordProjectSelectors } from "./constraints.ts";

export interface MachineSeed {
  id: string;
  name: string;
  os: "windows" | "macos" | "linux";
  kind: "host" | "guest";
  parentId?: string;
  guestType?: string;
  address?: string;
}

export function upsertMachine(db: Db, m: MachineSeed): void {
  db.prepare(
    `INSERT INTO machines (id, name, os, kind, parent_id, guest_type, address)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, os = excluded.os, kind = excluded.kind,
       parent_id = excluded.parent_id, guest_type = excluded.guest_type, address = excluded.address`,
  ).run(m.id, m.name, m.os, m.kind, m.parentId ?? null, m.guestType ?? null, m.address ?? null);
}

export interface RecordScanSummary {
  added: number;
  updated: number;
  removed: number;
}

/**
 * Store one source's scan for one machine. Installs seen are upserted; installs of the same source that were
 * not seen are marked removed, but only when the scan is "ok" (a partial or failed scan proves nothing about
 * absence). A coverage row is written every time.
 */
export function recordScan(db: Db, machineId: string, result: ScanResult, now: string): RecordScanSummary {
  const summary: RecordScanSummary = { added: 0, updated: 0, removed: 0 };
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR IGNORE INTO sources (machine_id, kind, location) VALUES (?, ?, ?)").run(
      machineId,
      result.sourceKind,
      result.location,
    );
    const source = db
      .prepare("SELECT id FROM sources WHERE machine_id = ? AND kind = ? AND location = ?")
      .get(machineId, result.sourceKind, result.location) as { id: number };

    const seen = new Set<number>();
    if (result.status === "ok" || result.status === "partial") {
      for (const rec of result.installs) {
        db.prepare("INSERT OR IGNORE INTO packages (ecosystem, key, name) VALUES (?, ?, ?)").run(
          rec.ecosystem,
          rec.key,
          rec.name,
        );
        const pkg = db
          .prepare("SELECT id FROM packages WHERE ecosystem = ? AND key = ?")
          .get(rec.ecosystem, rec.key) as { id: number };
        if (rec.description || rec.homepage || rec.publisher) {
          // A description the source supplies replaces a generated one, never a hand-written one.
          db.prepare(
            `UPDATE packages SET
               description = CASE WHEN ?1 IS NOT NULL AND COALESCE(description_source, 'source') != 'manual' THEN ?1 ELSE description END,
               description_source = CASE WHEN ?1 IS NOT NULL AND COALESCE(description_source, 'source') != 'manual' THEN 'source' ELSE description_source END,
               description_at = CASE WHEN ?1 IS NOT NULL AND COALESCE(description_source, 'source') != 'manual' THEN ?4 ELSE description_at END,
               homepage = COALESCE(?2, homepage),
               publisher = COALESCE(?3, publisher)
             WHERE id = ?5`,
          ).run(rec.description ?? null, rec.homepage ?? null, rec.publisher ?? null, now, pkg.id);
        }
        const existing = db
          .prepare(
            "SELECT id FROM installs WHERE machine_id = ? AND source_id = ? AND package_id = ? AND location = ?",
          )
          .get(machineId, source.id, pkg.id, rec.location) as { id: number } | undefined;
        const details = JSON.stringify(rec.details ?? {});
        if (existing) {
          db.prepare(
            `UPDATE installs SET kind = ?, version = ?, digest = ?, details_json = ?, last_seen = ?, removed_at = NULL
             WHERE id = ?`,
          ).run(rec.kind, rec.version, rec.digest ?? null, details, now, existing.id);
          seen.add(existing.id);
          summary.updated++;
        } else {
          const info = db
            .prepare(
              `INSERT INTO installs (machine_id, source_id, package_id, location, kind, version, digest,
                 details_json, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(machineId, source.id, pkg.id, rec.location, rec.kind, rec.version, rec.digest ?? null, details, now, now);
          seen.add(Number(info.lastInsertRowid));
          summary.added++;
        }
      }
    }

    if (result.status === "ok") {
      const live = db
        .prepare("SELECT id FROM installs WHERE machine_id = ? AND source_id = ? AND removed_at IS NULL")
        .all(machineId, source.id) as { id: number }[];
      for (const row of live) {
        if (!seen.has(row.id)) {
          db.prepare("UPDATE installs SET removed_at = ? WHERE id = ?").run(now, row.id);
          summary.removed++;
        }
      }
    }

    if (result.selectors !== undefined && (result.status === "ok" || result.status === "partial")) {
      recordProjectSelectors(db, machineId, source.id, result.selectors, result.status === "ok", now);
    }

    db.prepare(
      "INSERT INTO coverage (machine_id, source_kind, location, ran_at, status, found, message) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(machineId, result.sourceKind, result.location, now, result.status, result.installs.length, result.message ?? null);
    db.prepare("UPDATE machines SET last_scan = ? WHERE id = ?").run(now, machineId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}
