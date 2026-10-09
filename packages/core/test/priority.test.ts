import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { cachedPriorityFlags, defaultPriorityJudge, judgePriorityFlags, openCatalog, priorityScore, PRIORITY_WEIGHTS, queryUpdates, recordResearch, recordScan, SCHEMA_SQL, SCHEMA_VERSION, upsertMachine, type Db, type PriorityInput, type PriorityJudge, type PriorityWeights } from "../src/index.ts";

const T = "2026-09-30T00:00:00.000Z";
const BASE: PriorityInput = { installed: "1.2.3", available: "1.2.4", now: T };
const ZERO: PriorityWeights = Object.fromEntries(Object.keys(PRIORITY_WEIGHTS).map((name) => [name, 0]));
const alone = (name: keyof typeof PRIORITY_WEIGHTS, input: PriorityInput = BASE) => priorityScore(input, { ...ZERO, [name]: 100 });

test("priority behind uses bump size and saturating comparable minor and patch gaps", () => {
  for (const [available, value] of [["2.0.0", 1], ["1.3.0", 0.6], ["1.2.4", 0.3]] as const) assert.equal(alone("behind", { ...BASE, available }).score, value * 100);
  assert.equal(alone("behind", { ...BASE, installed: "old", available: "new" }).score, 40);
  assert.equal(alone("behind", { ...BASE, available: "1.2.3" }).score, 0);
  assert.equal(alone("behind", { ...BASE, available: "1.2.2" }).score, 0);
  assert.equal(alone("behind", { ...BASE, installed: null }).score, 0);
  assert.equal(alone("behind", { ...BASE, available: null }).score, 0);
  assert.ok(alone("behind", { ...BASE, available: "1.4.0" }).score > 60);
  assert.ok(alone("behind", { ...BASE, available: "1.2.5" }).score > 30);
  assert.equal(alone("behind", { ...BASE, available: "1.7.0" }).score, 100);
  assert.equal(alone("behind", { ...BASE, available: "1.2.13" }).score, 100);
  assert.equal(alone("behind", { ...BASE, available: "1.2.99999999999999999999999999999" }).score, 100);
  assert.equal(alone("behind", { ...BASE, installed: "1.2.3-r1", available: "1.2.13-r1" }).score, 30);
});

test("priority usage follows the recent-use windows and keeps unknown and never-used at the baseline", () => {
  for (const [days, value] of [[0, 1], [7, 1], [8, 0.6], [30, 0.6], [31, 0.3], [90, 0.3], [91, 0.1]] as const) {
    const lastUsed = new Date(Date.parse(T) - days * 86_400_000).toISOString();
    assert.equal(alone("usage", { ...BASE, lastUsed }).score, value * 100);
  }
  for (const lastUsed of [undefined, null, "invalid"]) assert.equal(alone("usage", { ...BASE, lastUsed }).score, 10);
  assert.equal(alone("running", { ...BASE, running: true }).score, 100);
  assert.equal(alone("running").score, 0);
  assert.ok(priorityScore({ ...BASE, running: true }).score > priorityScore(BASE).score);
});

test("priority exposure covers services, launchd daemons, images and server or security categories", () => {
  for (const kind of ["service", "image"]) assert.equal(alone("exposure", { ...BASE, kind }).score, 100);
  for (const category of ["server", "database", "networking", "security", "security tool", "container image"]) assert.equal(alone("exposure", { ...BASE, kind: "package", category }).score, 100);
  assert.equal(alone("exposure", { ...BASE, kind: "app", category: "editor or IDE" }).score, 0);
});

test("priority flags add security weight and subtract risk weight while missing flags work", () => {
  const baseline = priorityScore(BASE).score;
  assert.equal(priorityScore({ ...BASE, flags: {} }).score, baseline);
  assert.equal(priorityScore({ ...BASE, flags: { security: true } }).score, baseline + PRIORITY_WEIGHTS.security);
  for (const name of ["breaking", "migration", "removed"] as const) {
    assert.equal(alone(name, { ...BASE, flags: { [name]: true } }).score, 100);
    assert.equal(priorityScore({ ...BASE, flags: { [name]: true } }).score, Math.max(0, baseline + PRIORITY_WEIGHTS[name]));
  }
});

test("priority respects overridden weights, clamps scores and returns deterministic normalized parts", () => {
  const input = { ...BASE, available: "2.0.0", kind: "service", lastUsed: T, running: true, flags: { security: true } };
  const result = priorityScore(input);
  assert.equal(result.score, 100);
  assert.deepEqual(priorityScore(input), result);
  assert.ok(result.parts.every((part) => part.value >= 0 && part.value <= 1));
  assert.ok(result.parts.every((part) => part.weight === PRIORITY_WEIGHTS[part.name as keyof typeof PRIORITY_WEIGHTS]));
  assert.equal(priorityScore(BASE, ZERO).score, 0);
  assert.equal(priorityScore(BASE, { ...ZERO, behind: 10 }).score, 3);
  assert.equal(priorityScore(BASE, { ...ZERO, behind: -10 }).score, 0);
  assert.equal(result.parts.some((part) => part.name === "staleness"), false);
});

test("priority blocked, frozen and advisory-only rows score zero even with security flags", () => {
  for (const name of ["blocked", "frozen", "advisoryOnly"] as const) assert.equal(priorityScore({ ...BASE, [name]: true, flags: { security: true }, running: true }).score, 0);
});

function seed(): Db {
  const db = openCatalog(":memory:");
  for (const machine of ["a", "b"]) {
    upsertMachine(db, { id: machine, name: machine, os: "macos", kind: "host" });
    recordScan(db, machine, { sourceKind: "brew", location: "/b", status: "ok", installs: [
      { ecosystem: "brew", key: "alpha", name: "Alpha", kind: "package", version: "1.0.0", location: "/b/alpha" },
      { ecosystem: "brew", key: "zed", name: "Zed", kind: "package", version: "1.0.0", location: "/b/zed" },
      { ecosystem: "brew", key: "blocked", name: "Blocked", kind: "package", version: "1.0.0", location: "/b/blocked" },
      { ecosystem: "brew", key: "advisory", name: "Advisory", kind: "package", version: "1.0.0", location: "/b/advisory" },
      { ecosystem: "brew", key: "unknown", name: "Unknown", kind: "package", version: null, location: "/b/unknown" },
      { ecosystem: "brew", key: "upstream", name: "Upstream", kind: "package", version: "1.0.0", location: "/b/upstream" },
    ] }, T);
  }
  for (const row of db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[]) recordResearch(db, row.id, "test", "ok", [{ channel: "stable", version: row.key === "zed" ? "2.0.0" : "1.0.1", installable: row.key !== "advisory" && row.key !== "upstream" && row.key !== "unknown", advisory: row.key === "advisory" }], null, T);
  db.prepare("INSERT INTO constraints (package_id, type, hard, spec, origin, observed_at) SELECT id, 'freeze', 1, '1.0.0', 'test', ? FROM packages WHERE key = 'blocked'").run(T);
  return db;
}

test("priority sorting keeps null and blocked rows last in either direction and breaks ties by name then machine", () => {
  const db = seed();
  try {
    const desc = queryUpdates(db, { sort: "priority", now: T }).rows;
    assert.deepEqual(desc.map((row) => [row.name, row.machineId]), [["Zed", "a"], ["Zed", "b"], ["Alpha", "a"], ["Alpha", "b"], ["Upstream", "a"], ["Upstream", "b"], ["Advisory", "a"], ["Advisory", "b"], ["Blocked", "a"], ["Blocked", "b"], ["Unknown", "a"], ["Unknown", "b"]]);
    const asc = queryUpdates(db, { sort: "priority", dir: "asc", now: T }).rows;
    assert.deepEqual(asc.map((row) => row.name), ["Alpha", "Alpha", "Upstream", "Upstream", "Zed", "Zed", "Advisory", "Advisory", "Blocked", "Blocked", "Unknown", "Unknown"]);
    for (const row of desc) {
      if (row.name === "Unknown") assert.deepEqual([row.priority, row.priorityParts], [null, []]);
      else if (row.name === "Blocked" || row.name === "Advisory") assert.equal(row.priority, 0);
      else assert.ok(row.priority !== null && row.priority > 0 && row.priorityParts.length > 0);
    }
    assert.equal(queryUpdates(db, { sort: "priority", offset: 1, limit: 1 }).rows[0]?.machineId, "b");
  } finally { db.close(); }
});

test("priority judges cache flags by package, version and source and query rows read the latest flags", async () => {
  const db = seed();
  try {
    const packageId = (db.prepare("SELECT id FROM packages WHERE key = 'alpha'").get() as { id: number }).id;
    const input = { packageId, ecosystem: "brew", key: "alpha", version: "1.0.1" };
    assert.equal(await defaultPriorityJudge.flags(input), null);
    assert.equal(await judgePriorityFlags(db, input), null);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM priority_flags").get() as { n: number }).n, 0);
    let calls = 0;
    const judge: PriorityJudge = { async flags(received) { assert.deepEqual(received, input); calls++; return { security: true }; } };
    assert.deepEqual(await judgePriorityFlags(db, input, judge, "fake", T), { security: true });
    assert.deepEqual(await judgePriorityFlags(db, input, judge, "fake", T), { security: true });
    assert.equal(calls, 1);
    assert.deepEqual({ ...db.prepare("SELECT package_id, version, flags_json, source, observed_at FROM priority_flags").get() }, { package_id: packageId, version: "1.0.1", flags_json: '{"security":true}', source: "fake", observed_at: T });
    assert.equal(queryUpdates(db, { sort: "priority", now: T }).rows[0]?.name, "Alpha");
    db.prepare("INSERT INTO priority_flags (package_id, version, flags_json, source, observed_at) VALUES (?, '1.0.1', '{\"security\":false}', 'newer', '2026-10-01T00:00:00.000Z')").run(packageId);
    assert.deepEqual(cachedPriorityFlags(db).get(packageId)?.get("1.0.1"), { security: false });
    assert.equal(queryUpdates(db, { sort: "priority", now: T }).rows[0]?.name, "Zed");
    assert.equal(await judgePriorityFlags(db, { ...input, version: "2.0.0" }), null);
    const empty: PriorityJudge = { async flags() { return {}; } };
    assert.deepEqual(await judgePriorityFlags(db, input, empty, "empty", T), {});
    db.prepare("UPDATE priority_flags SET flags_json = 'invalid' WHERE source = 'empty'").run();
    assert.deepEqual(await judgePriorityFlags(db, input, empty, "empty", T), {});
  } finally { db.close(); }
});

test("priority freezes stay zero when the constraint does not produce a blocked verdict", () => {
  const db = seed();
  try {
    const installId = (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'alpha' AND i.machine_id = 'a'").get() as { id: number }).id;
    db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '1.0.1', 'test', ?)").run(installId, T);
    const row = queryUpdates(db, { sort: "priority", now: T }).rows.find((row) => row.installId === installId);
    assert.equal(row?.blockedBy, null);
    assert.equal(row?.priority, 0);
    const other = queryUpdates(db, { sort: "priority", now: T }).rows.find((row) => row.name === "Alpha" && row.machineId === "b");
    assert.ok(other?.priority !== null && other?.priority !== undefined && other.priority > 0);
  } finally { db.close(); }
});

test("priority rows without a comparable stable answer stay null even when cached flags exist", () => {
  const db = seed();
  try {
    const packageId = (db.prepare("SELECT id FROM packages WHERE key = 'alpha'").get() as { id: number }).id;
    db.prepare("DELETE FROM assertions WHERE package_id = ?").run(packageId);
    recordResearch(db, packageId, "test", "ok", [{ channel: "beta", version: "2.0.0", installable: true }], null, T);
    let rows = queryUpdates(db, { sort: "priority", status: ["current"], now: T }).rows;
    assert.ok(rows.length === 2 && rows.every((row) => row.priority === null && row.priorityParts.length === 0));
    recordResearch(db, packageId, "test", "ok", [{ channel: "stable", version: "unknown", installable: true }], null, T);
    db.prepare("INSERT INTO priority_flags VALUES (?, 'unknown', '{\"security\":true}', 'fake', ?)").run(packageId, T);
    rows = queryUpdates(db, { sort: "priority", dir: "asc", status: ["current"], now: T }).rows;
    assert.ok(rows.length === 2 && rows.every((row) => row.priority === null));
  } finally { db.close(); }
});

test("priority cache upgrades previous catalogs in place without changing package or install data", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-priority-"));
  try {
    for (const version of [1, 2]) {
      const path = join(dir, `v${version}.db`);
      const prior = new DatabaseSync(path);
      prior.exec(SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS priority_flags \([\s\S]*?\);/, ""));
      prior.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      prior.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'brew', 'kept', 'Kept')");
      if (version === 1) {
        for (const trigger of ["packages_ai", "packages_ad", "packages_au"]) prior.exec(`DROP TRIGGER ${trigger}`);
        prior.exec("DROP TABLE packages_fts; DROP TABLE packages; CREATE TABLE packages (id INTEGER PRIMARY KEY, ecosystem TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (ecosystem, key)); INSERT INTO packages VALUES (1, 'brew', 'kept', 'Kept')");
      }
      prior.exec("INSERT INTO machines (id, name, os, kind) VALUES ('a', 'a', 'macos', 'host'); INSERT INTO sources (id, machine_id, kind) VALUES (1, 'a', 'brew')");
      prior.prepare("INSERT INTO installs (id, machine_id, source_id, package_id, kind, version, first_seen, last_seen) VALUES (1, 'a', 1, 1, 'package', '1.0.0', ?, ?)").run(T, T);
      prior.close();
      const db = openCatalog(path);
      try {
        assert.equal(SCHEMA_VERSION, 3);
        assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "3");
        assert.equal((db.prepare("SELECT name FROM packages WHERE id = 1").get() as { name: string }).name, "Kept");
        assert.deepEqual({ ...db.prepare("SELECT version, first_seen, last_seen FROM installs WHERE id = 1").get() }, { version: "1.0.0", first_seen: T, last_seen: T });
        assert.deepEqual((db.prepare("PRAGMA table_info(priority_flags)").all() as { name: string }[]).map((column) => column.name), ["package_id", "version", "flags_json", "source", "observed_at"]);
        db.prepare("INSERT INTO priority_flags VALUES (1, '2.0', '{}', 'fake', ?)").run(T);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM packages_fts WHERE packages_fts MATCH 'Kept'").get() as { n: number }).n, 1);
      } finally { db.close(); }
      const reopened = openCatalog(path);
      try { assert.equal((reopened.prepare("SELECT COUNT(*) AS n FROM priority_flags").get() as { n: number }).n, 1); } finally { reopened.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
