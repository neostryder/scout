import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/schema.ts";
import { countInstalls, facetCounts, ftsQuery, openCatalog, queryInstalls, recordScan, upsertMachine, type Db, type InstallRecord } from "../src/index.ts";

const NOW = "2026-09-29T12:00:00Z";

function rec(over: Partial<InstallRecord> & { key: string }): InstallRecord {
  return { ecosystem: "brew", name: over.key, kind: "package", version: "1.0", location: `/opt/homebrew/Cellar/${over.key}/1.0`, ...over };
}

function seed(): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini/colima", name: "Mini colima", os: "linux", kind: "guest", parentId: "mini" });
  recordScan(db, "mini", {
    sourceKind: "brew", location: "/opt/homebrew", status: "ok",
    installs: [
      rec({ key: "redis", description: "Persistent key-value database", homepage: "https://redis.io/", details: { onRequest: true } }),
      rec({ key: "openssl@3", description: "Cryptography and SSL/TLS Toolkit", details: { onRequest: false } }),
      rec({ key: "git", description: "Distributed revision control system", details: { onRequest: true } }),
    ],
  }, NOW);
  recordScan(db, "mini", {
    sourceKind: "app", location: "", status: "ok",
    installs: [rec({ ecosystem: "bundle", key: "com.apple.Safari", name: "Safari", kind: "app", location: "/Applications/Safari.app" })],
  }, NOW);
  recordScan(db, "hub", {
    sourceKind: "winget", location: "", status: "ok",
    installs: [rec({ ecosystem: "winget", key: "Git.Git", name: "git", location: "", publisher: "The Git Development Community" })],
  }, "2026-09-28T00:00:00Z");
  recordScan(db, "mini/colima", {
    sourceKind: "dpkg", location: "", status: "ok",
    installs: [rec({ ecosystem: "dpkg", key: "curl", location: "" })],
  }, NOW);
  return db;
}

/** node:sqlite rows have a null prototype, which strict deep equality distinguishes from a plain object. */
const plain = <T extends object>(rows: T[]): T[] => rows.map((r) => ({ ...r }));

const names = (db: Db, f = {}) => queryInstalls(db, f).map((r) => `${r.machineId}:${r.name}`);

function signal(db: Db, name: string, machine: string, kind: string, value: string | null, available = 1): void {
  const row = db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.name = ? AND i.machine_id = ?").get(name, machine) as { id: number };
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, ?, 'test', ?)").run(row.id, kind, value, available, NOW);
}

test("ftsQuery builds a safe prefix query and drops punctuation", () => {
  assert.equal(ftsQuery("red"), '"red"*');
  assert.equal(ftsQuery("key-value db"), '"key"* "value"* "db"*');
  assert.equal(ftsQuery('"; DROP'), '"DROP"*');
  assert.equal(ftsQuery("  --  "), null);
});

test("filters by machine include that machine's guests unless told otherwise", () => {
  const db = seed();
  assert.deepEqual(names(db, { machines: ["mini"] }).sort(), ["mini/colima:curl", "mini:Safari", "mini:git", "mini:openssl@3", "mini:redis"].sort());
  assert.deepEqual(names(db, { machines: ["mini"], includeGuests: false }).sort(), ["mini:Safari", "mini:git", "mini:openssl@3", "mini:redis"].sort());
});

test("source, ecosystem, kind and category filters combine", () => {
  const db = seed();
  assert.deepEqual(names(db, { sources: ["brew"], machines: ["mini"], includeGuests: false }).sort(), ["mini:git", "mini:openssl@3", "mini:redis"]);
  assert.deepEqual(names(db, { kinds: ["app"] }), ["mini:Safari"]);
  db.prepare("UPDATE packages SET category = 'database' WHERE key = 'redis'").run();
  assert.deepEqual(names(db, { categories: ["database"] }), ["mini:redis"]);
});

test("text search finds words in descriptions and prefixes, and substrings of a path", () => {
  const db = seed();
  assert.deepEqual(names(db, { text: "key-value" }), ["mini:redis"]);
  assert.deepEqual(names(db, { text: "crypto" }), ["mini:openssl@3"]);
  assert.deepEqual(names(db, { text: "Safari.app" }), ["mini:Safari"]);
  assert.deepEqual(names(db, { text: "development community" }), ["hub:git"]);
});

test("the full-text index follows a description change", () => {
  const db = seed();
  db.prepare("UPDATE packages SET description = 'An in-memory cache' WHERE key = 'redis'").run();
  assert.deepEqual(names(db, { text: "cache" }), ["mini:redis"]);
  assert.deepEqual(names(db, { text: "key-value" }), []);
});

test("path prefix matches from the start only", () => {
  const db = seed();
  assert.equal(countInstalls(db, { pathPrefix: "/opt/homebrew/Cellar/redis" }), 1);
  assert.equal(countInstalls(db, { pathPrefix: "homebrew" }), 0);
});

test("hideLibraries hides dependencies nobody asked for", () => {
  const db = seed();
  assert.ok(!names(db, { hideLibraries: true }).includes("mini:openssl@3"));
  assert.ok(names(db, { hideLibraries: true }).includes("mini:redis"));
});

test("newSince keeps recent installs", () => {
  const db = seed();
  assert.ok(!names(db, { newSince: "2026-09-29T00:00:00Z" }).includes("hub:git"));
  assert.ok(names(db, { newSince: "2026-09-27T00:00:00Z" }).includes("hub:git"));
});

test("usage filters: within days, never used, unknown, running", () => {
  const db = seed();
  signal(db, "redis", "mini", "last_used", "2026-09-27T09:00:00Z");
  signal(db, "git", "mini", "last_used", "2026-06-01T09:00:00Z");
  signal(db, "Safari", "mini", "last_used", null); // readable, and nothing recorded: never used
  signal(db, "openssl@3", "mini", "last_used", null, 0); // unreadable: unknown, not never
  signal(db, "redis", "mini", "running", "1");
  assert.deepEqual(names(db, { usedWithinDays: 30, now: NOW }), ["mini:redis"]);
  assert.deepEqual(names(db, { usedWithinDays: 200, now: NOW }).sort(), ["mini:git", "mini:redis"]);
  assert.deepEqual(names(db, { neverUsed: true }), ["mini:Safari"]);
  assert.ok(names(db, { unknownUse: true }).includes("mini:openssl@3"));
  assert.ok(!names(db, { unknownUse: true }).includes("mini:redis"));
  assert.deepEqual(names(db, { running: true }), ["mini:redis"]);
});

test("presence: on one machine only, on every host", () => {
  const db = seed();
  assert.deepEqual(names(db, { presence: "one", text: "git" }).length, 0);
  assert.ok(names(db, { presence: "one" }).includes("mini:redis"));
  assert.ok(!names(db, { presence: "one" }).includes("mini:git"));
  assert.deepEqual(names(db, { presence: "all" }).sort(), ["hub:git", "mini:git"]);
});

test("facet counts ignore their own dimension but honor the others", () => {
  const db = seed();
  const f = { machines: ["mini"], includeGuests: false };
  assert.deepEqual(plain(facetCounts(db, f, "source")), [{ value: "brew", count: 3 }, { value: "app", count: 1 }]);
  // Selecting a source narrows the machine facet, and the machine facet still shows every machine for that source.
  const machines = facetCounts(db, { sources: ["winget"], machines: ["mini"] }, "machine");
  assert.deepEqual(plain(machines), [{ value: "hub", count: 1 }]);
});

test("limit, offset and sort", () => {
  const db = seed();
  assert.deepEqual(queryInstalls(db, { sort: "name", limit: 2 }).map((r) => r.name), ["curl", "git"]);
  assert.deepEqual(queryInstalls(db, { sort: "name", limit: 2, offset: 2 }).map((r) => r.name), ["git", "openssl@3"]);
});

test("a description from the source replaces a generated one but never a manual one", () => {
  const db = seed();
  db.prepare("UPDATE packages SET description = 'guess', description_source = 'generated' WHERE key = 'git' AND ecosystem = 'brew'").run();
  db.prepare("UPDATE packages SET description = 'my words', description_source = 'manual' WHERE key = 'redis'").run();
  recordScan(db, "mini", {
    sourceKind: "brew", location: "/opt/homebrew", status: "ok",
    installs: [
      rec({ key: "git", description: "Distributed revision control system" }),
      rec({ key: "redis", description: "Persistent key-value database" }),
    ],
  }, "2026-09-29T13:00:00Z");
  const d = (k: string) => (db.prepare("SELECT description, description_source FROM packages WHERE key = ? AND ecosystem = 'brew'").get(k) as { description: string; description_source: string });
  assert.deepEqual({ ...d("git") }, { description: "Distributed revision control system", description_source: "source" });
  assert.deepEqual({ ...d("redis") }, { description: "my words", description_source: "manual" });
});

test("a version 1 catalog is upgraded in place and its rows are indexed", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-"));
  const path = join(dir, "v1.db");
  const v1 = new DatabaseSync(path);
  v1.exec(SCHEMA_SQL.replace(/CREATE VIRTUAL TABLE[\s\S]*?END;\s*CREATE TRIGGER[\s\S]*?END;\s*CREATE TRIGGER[\s\S]*?END;/, ""));
  v1.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE IF EXISTS packages_fts; DROP TABLE packages; CREATE TABLE packages (id INTEGER PRIMARY KEY, ecosystem TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (ecosystem, key)); INSERT INTO packages (ecosystem, key, name) VALUES ('brew', 'wget', 'wget'); UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  old.close();
  const db = openCatalog(path);
  const cols = (db.prepare("PRAGMA table_info(packages)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("description") && cols.includes("category"));
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM packages_fts WHERE packages_fts MATCH '\"wget\"*'").get() as { n: number }).n, 1);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
