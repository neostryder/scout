import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordScan, upsertMachine, type ScanResult } from "../src/index.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";

const T1 = "2026-09-28T12:00:00Z";
const T2 = "2026-09-28T13:00:00Z";

function seed() {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host", address: "192.168.1.154" });
  return db;
}

const scan = (names: string[], status: ScanResult["status"] = "ok"): ScanResult => ({
  sourceKind: "brew",
  location: "/opt/homebrew",
  status,
  installs: names.map((n) => ({
    ecosystem: "brew",
    key: n,
    name: n,
    kind: "package" as const,
    version: "1.0",
    location: `/opt/homebrew/Cellar/${n}/1.0`,
  })),
});

test("schema opens and records its version", () => {
  const db = seed();
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(row.value, String(SCHEMA_VERSION));
});

test("a scan adds installs, then updates them", () => {
  const db = seed();
  assert.deepEqual(recordScan(db, "mini", scan(["node", "git"]), T1), { added: 2, updated: 0, removed: 0 });
  assert.deepEqual(recordScan(db, "mini", scan(["node", "git"]), T2), { added: 0, updated: 2, removed: 0 });
});

test("an ok scan marks unseen installs removed, and they return when seen again", () => {
  const db = seed();
  recordScan(db, "mini", scan(["node", "git"]), T1);
  assert.equal(recordScan(db, "mini", scan(["node"]), T2).removed, 1);
  const gone = db.prepare("SELECT removed_at FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'git'").get() as { removed_at: string };
  assert.equal(gone.removed_at, T2);
  recordScan(db, "mini", scan(["node", "git"]), "2026-09-28T14:00:00Z");
  const back = db.prepare("SELECT removed_at FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'git'").get() as { removed_at: string | null };
  assert.equal(back.removed_at, null);
});

test("a failed or partial scan never marks anything removed", () => {
  const db = seed();
  recordScan(db, "mini", scan(["node", "git"]), T1);
  assert.equal(recordScan(db, "mini", { ...scan([]), status: "failed", message: "brew missing" }, T2).removed, 0);
  assert.equal(recordScan(db, "mini", scan(["node"], "partial"), T2).removed, 0);
});

test("every scan writes a coverage row", () => {
  const db = seed();
  recordScan(db, "mini", scan(["node"]), T1);
  recordScan(db, "mini", { ...scan([]), status: "skipped", message: "guest not running" }, T2);
  const rows = db.prepare("SELECT status, found, message FROM coverage ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.status), ["ok", "skipped"]);
});

test("two prefixes of the same package stay separate installs", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "server", name: "Server", os: "macos", kind: "host" });
  recordScan(db, "server", { ...scan(["node"]), location: "/opt/homebrew" }, T1);
  recordScan(db, "server", { ...scan(["node"]), location: "/Users/user/.homebrew" }, T1);
  const n = db.prepare("SELECT COUNT(*) AS n FROM installs").get() as { n: number };
  assert.equal(n.n, 2);
});
