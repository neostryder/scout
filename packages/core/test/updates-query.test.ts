import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, queryUpdates, recordResearch, recordScan, upsertMachine, type Db, type UpdateQuery, type UpdateSort } from "../src/index.ts";

const T = "2026-09-30T00:00:00.000Z";

function seed(): Db {
  const db = openCatalog(":memory:");
  for (const machine of ["a", "b"]) upsertMachine(db, { id: machine, name: machine, os: "macos", kind: "host" });
  const entries = [
    ["alpha", "1.2.3", "2.0.0", "a"], ["beta", "1.2.3", "1.3.0", "a"],
    ["gamma", "1.2.3", "1.2.4", "b"], ["delta", "1.9", "1.10", "b"],
  ] as const;
  for (const machine of ["a", "b"]) recordScan(db, machine, { sourceKind: "brew", location: "/b", status: "ok", installs: entries.filter((entry) => entry[3] === machine).map(([name, version]) => ({ ecosystem: "brew", key: name, name, kind: "package", version, location: `/b/${name}` })) }, T);
  for (const [name, , available] of entries) {
    const id = (db.prepare("SELECT id FROM packages WHERE key = ?").get(name) as { id: number }).id;
    recordResearch(db, id, "brew-api", "ok", [{ channel: "stable", version: available, installable: true }], null, T);
  }
  db.prepare("UPDATE packages SET category = 'tool', publisher = 'Acme', description = 'Useful utility' WHERE key IN ('alpha', 'beta')").run();
  const alpha = (db.prepare("SELECT i.id AS id, p.id AS packageId FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'alpha'").get() as { id: number; packageId: number });
  db.prepare("INSERT INTO constraints (install_id, package_id, type, hard, spec, origin, detail_json, observed_at) VALUES (?, ?, 'freeze', 1, '1.2.3', 'pin', '{}', ?)").run(alpha.id, alpha.packageId, T);
  recordResearch(db, alpha.packageId, "github", "ok", [{ channel: "stable", version: "3.0", installable: false }, { channel: "beta", version: "4.0", installable: false }], null, T);
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, 'last_used', ?, 1, 'test', ?)").run(alpha.id, T, T);
  const install = (key: string) => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ?").get(key) as { id: number }).id;
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, 'last_used', NULL, 1, 'test', ?)").run(install("beta"), T);
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, 'running', '1', 1, 'test', ?)").run(install("gamma"), T);
  return db;
}

test("updates query filters status combinations, bump, text, source, metadata and usage", () => {
  const db = seed();
  try {
    const rows = queryUpdates(db).rows;
    assert.deepEqual(rows.find((r) => r.name === "alpha")?.statuses, ["blocked", "upstream"]);
    assert.deepEqual(rows.map((r) => [r.name, r.bump]), [["alpha", "major"], ["beta", "minor"], ["delta", "minor"], ["gamma", "patch"]]);
    const names = (q: UpdateQuery) => queryUpdates(db, q).rows.map((r) => r.name);
    assert.deepEqual(names({ status: ["blocked"] }), ["alpha"]);
    assert.deepEqual(names({ status: ["upstream"] }), ["alpha"]);
    assert.deepEqual(names({ status: ["updatable"] }), ["beta", "delta", "gamma"]);
    assert.deepEqual(names({ bump: ["patch"] }), ["gamma"]);
    assert.deepEqual(names({ q: "acme useful" }), ["alpha", "beta"]);
    assert.deepEqual(names({ machine: ["b"], ecosystem: ["brew"] }), ["delta", "gamma"]);
    assert.deepEqual(names({ source: ["brew-api"], category: ["tool"], publisher: ["Acme"] }), ["alpha", "beta"]);
    assert.deepEqual(names({ hasBeta: true, hasUpstream: true }), ["alpha"]);
    assert.deepEqual(names({ usedWithinDays: 1, now: T }), ["alpha"]);
    assert.deepEqual(names({ unknownUse: true }), ["delta"]);
    assert.deepEqual(names({ neverUsed: true }), ["beta"]);
    assert.deepEqual(names({ running: true }), ["gamma"]);
  } finally { db.close(); }
});

test("facets omit their own filters and paging follows filtering", () => {
  const db = seed();
  try {
    const result = queryUpdates(db, { machine: ["a"], category: ["tool"], status: ["blocked"], limit: 1 });
    assert.equal(result.total, 1);
    assert.equal(result.updatable, 0);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.facets.machine, [{ value: "a", count: 1 }]);
    assert.deepEqual(result.facets.status, [{ value: "blocked", count: 1 }, { value: "updatable", count: 1 }, { value: "upstream", count: 1 }]);
    assert.deepEqual(queryUpdates(db, { offset: 2, limit: 1 }).rows.map((r) => r.name), ["delta"]);
    assert.equal(queryUpdates(db, { status: ["current"] }).total, 0);
    const baseline = queryUpdates(db).facets;
    assert.deepEqual(queryUpdates(db, { machine: ["a"] }).facets.machine, baseline.machine);
    assert.deepEqual(queryUpdates(db, { ecosystem: ["brew"] }).facets.ecosystem, baseline.ecosystem);
    assert.deepEqual(queryUpdates(db, { source: ["brew-api"] }).facets.source, baseline.source);
    assert.deepEqual(queryUpdates(db, { status: ["blocked"] }).facets.status, baseline.status);
    assert.deepEqual(queryUpdates(db, { bump: ["patch"] }).facets.bump, baseline.bump);
    assert.deepEqual(queryUpdates(db, { category: ["tool"] }).facets.category, baseline.category);
    assert.deepEqual(queryUpdates(db, { publisher: ["Acme"] }).facets.publisher, baseline.publisher);
  } finally { db.close(); }
});

test("every sort accepts both directions and versions use numeric order", () => {
  const db = seed();
  try {
    const sorts: UpdateSort[] = ["name", "machine", "ecosystem", "source", "installed", "available", "status", "bump", "checked", "lastUsed", "category", "publisher", "firstSeen"];
    for (const sort of sorts) {
      for (const dir of ["asc", "desc"] as const) assert.equal(queryUpdates(db, { sort, dir }).rows.length, 4, `${sort} ${dir}`);
    }
    assert.deepEqual(queryUpdates(db, { sort: "available" }).rows.map((r) => r.name), ["gamma", "beta", "delta", "alpha"]);
    assert.deepEqual(queryUpdates(db, { sort: "available", dir: "desc" }).rows.map((r) => r.name), ["alpha", "delta", "beta", "gamma"]);
    assert.deepEqual(queryUpdates(db, { sort: "status" }).rows.map((r) => r.name), ["beta", "delta", "gamma", "alpha"]);
    assert.deepEqual(queryUpdates(db, { sort: "status", dir: "desc" }).rows.map((r) => r.name), ["alpha", "beta", "delta", "gamma"]);
    assert.deepEqual(queryUpdates(db, { sort: "bump" }).rows.map((r) => r.name), ["alpha", "beta", "delta", "gamma"]);
    assert.deepEqual(queryUpdates(db, { sort: "bump", dir: "asc" }).rows.map((r) => r.name), ["gamma", "beta", "delta", "alpha"]);
    assert.deepEqual(queryUpdates(db, { sort: "name", dir: "desc" }).rows.map((r) => r.name), ["gamma", "delta", "beta", "alpha"]);
  } finally { db.close(); }
});

test("current, advisory and nonnumeric answers keep their distinct verdicts", () => {
  const db = openCatalog(":memory:");
  try {
    upsertMachine(db, { id: "a", name: "a", os: "macos", kind: "host" });
    recordScan(db, "a", { sourceKind: "brew", location: "/b", status: "ok", installs: [
      { ecosystem: "brew", key: "current", name: "Current", kind: "package", version: "1.0", location: "/b/current" },
      { ecosystem: "brew", key: "advisory", name: "Advisory", kind: "package", version: "1.0", location: "/b/advisory" },
      { ecosystem: "brew", key: "other", name: "Other", kind: "package", version: "release", location: "/b/other" },
    ] }, T);
    const id = (key: string) => (db.prepare("SELECT id FROM packages WHERE key = ?").get(key) as { id: number }).id;
    recordResearch(db, id("current"), "brew-api", "ok", [{ channel: "stable", version: "1.0", installable: true }], null, T);
    recordResearch(db, id("advisory"), "vendor", "ok", [{ channel: "stable", version: "2.0", installable: false, advisory: true }], null, T);
    recordResearch(db, id("other"), "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null, T);
    const rows = queryUpdates(db, { status: ["current", "advisory"] }).rows;
    assert.deepEqual(rows.map((r) => [r.name, r.statuses, r.bump]), [["Advisory", ["advisory"], null], ["Current", ["current"], null], ["Other", ["current"], "other"]]);
    assert.deepEqual(queryUpdates(db, { bump: ["other"], status: ["current"] }).rows.map((r) => r.name), ["Other"]);
    assert.deepEqual(queryUpdates(db, { sort: "available", dir: "asc", status: ["current", "advisory"] }).rows.map((r) => r.name), ["Current", "Other", "Advisory"]);
    assert.deepEqual(queryUpdates(db, { sort: "available", dir: "desc", status: ["current", "advisory"] }).rows.map((r) => r.name), ["Other", "Current", "Advisory"]);
    assert.equal(queryUpdates(db).total, 1);
  } finally { db.close(); }
});

test("a query over 2000 installs stays within a generous response budget", () => {
  const db = openCatalog(":memory:");
  try {
    upsertMachine(db, { id: "a", name: "a", os: "macos", kind: "host" });
    const installs = Array.from({ length: 2000 }, (_, n) => ({ ecosystem: "brew", key: `pkg${n}`, name: `pkg${n}`, kind: "package" as const, version: "1.0", location: `/b/pkg${n}` }));
    recordScan(db, "a", { sourceKind: "brew", location: "/b", status: "ok", installs }, T);
    const ids = db.prepare("SELECT id FROM packages").all() as { id: number }[];
    const insert = db.prepare("INSERT INTO assertions (package_id, source, channel, version, installable, advisory, observed_at) VALUES (?, 'brew-api', 'stable', '1.1', 1, 0, ?)");
    for (const { id } of ids) insert.run(id, T);
    const start = performance.now();
    assert.equal(queryUpdates(db).total, 2000);
    assert.ok(performance.now() - start < 500);
  } finally { db.close(); }
});
