import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION, V2_PACKAGE_COLUMNS, JOB_COLUMNS, SERVICE_COLUMNS } from "./schema.ts";

export type Db = DatabaseSync;

/** Open (creating if needed) the catalog. Pass ":memory:" for tests. */
export function openCatalog(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrateToV2(db);
  migrateJobs(db);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'services'").get()) {
    const have = new Set((db.prepare("PRAGMA table_info(services)").all() as { name: string }[]).map((c) => c.name));
    for (const def of SERVICE_COLUMNS) if (!have.has(def.split(" ")[0] as string)) db.exec(`ALTER TABLE services ADD COLUMN ${def}`);
  }
  migrateDependencyEdges(db);
  migrateActions(db);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listeners'").get()) {
    const columns = db.prepare("PRAGMA table_info(listeners)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "expected_down")) db.exec("ALTER TABLE listeners ADD COLUMN expected_down INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "script_path")) db.exec("ALTER TABLE listeners ADD COLUMN script_path TEXT");
    if (!columns.some((column) => column.name === "ppid")) db.exec("ALTER TABLE listeners ADD COLUMN ppid INTEGER");
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'watch_state'").get()) {
    const columns = db.prepare("PRAGMA table_info(watch_state)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "last_ok_at")) {
      db.exec("ALTER TABLE watch_state ADD COLUMN last_ok_at TEXT");
      db.exec("UPDATE watch_state SET last_ok_at = last_checked_at WHERE failures = 0");
    }
  }
  const hadFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'packages_fts'").get() !== undefined;
  db.exec(SCHEMA_SQL);
  const descriptionColumns = db.prepare("PRAGMA table_info(descriptions)").all() as { name: string }[];
  if (!descriptionColumns.some((column) => column.name === "input_hash")) db.exec("ALTER TABLE descriptions ADD COLUMN input_hash TEXT");
  // An existing catalog gains the index here; index its rows once.
  if (!hadFts) db.exec("INSERT INTO packages_fts(packages_fts) VALUES ('rebuild')");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) < SCHEMA_VERSION) {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`catalog schema version ${row.value} does not match ${SCHEMA_VERSION}`);
  }
  return db;
}

/** The first dependency_edges table limited `source` to the three readers; reviewed edges need a fourth value, and SQLite cannot drop a CHECK in place. */
function migrateDependencyEdges(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dependency_edges'").get() as { sql: string } | undefined;
  if (!row || !/CHECK \(source IN/.test(row.sql)) return;
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE dependency_edges RENAME TO dependency_edges_old");
    db.exec("DROP INDEX IF EXISTS dependency_target");
    db.exec("DROP INDEX IF EXISTS dependency_identity");
    db.exec(SCHEMA_SQL);
    db.exec("INSERT INTO dependency_edges SELECT * FROM dependency_edges_old");
    db.exec("DROP TABLE dependency_edges_old");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateActions(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actions'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'stack'") && row.sql.includes("'disable'")) return;
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE actions RENAME TO actions_old");
    db.exec("DROP INDEX IF EXISTS actions_machine");
    db.exec(SCHEMA_SQL);
    db.exec("INSERT INTO actions SELECT * FROM actions_old");
    db.exec("DROP TABLE actions_old");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function migrateJobs(db: Db): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()) return;
  const have = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  for (const def of JOB_COLUMNS) {
    if (!have.has(def.split(" ")[0] as string)) db.exec(`ALTER TABLE jobs ADD COLUMN ${def}`);
  }
}

/** A version 1 catalog lacks the description columns on `packages`; add them before the schema statements run. */
function migrateToV2(db: Db): void {
  const hasPackages = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'packages'").get();
  if (!hasPackages) return;
  const have = new Set((db.prepare("PRAGMA table_info(packages)").all() as { name: string }[]).map((c) => c.name));
  for (const def of V2_PACKAGE_COLUMNS) {
    const name = def.split(" ")[0] as string;
    if (!have.has(name)) db.exec(`ALTER TABLE packages ADD COLUMN ${def}`);
  }
}
