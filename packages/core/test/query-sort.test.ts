import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { countInstalls, facetCounts, openCatalog, queryInstalls, recordScan, upsertMachine, type Db, type Filter } from "../src/index.ts";

const EARLY = "2026-09-27T12:00:00.000Z";
const LATE = "2026-09-29T12:00:00.000Z";

function seed(): Db {
  const db = openCatalog(":memory:");
  for (const id of ["a", "b"]) upsertMachine(db, { id, name: id, os: "macos", kind: "host" });
  const rows = [
    { key: "alpha", name: "Alpha", version: "2.0", location: "/a", publisher: "Acme", description: "A tool", homepage: "https://example.com/a", details: { scope: "user" } },
    { key: "beta", name: "Beta", version: "10.0", location: "/b", publisher: "Bravo", details: { scope: "machine" } },
    { key: "gamma", name: "Gamma", version: null, location: "/c", details: {} },
  ];
  recordScan(db, "a", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: rows.map((r) => ({ ecosystem: "brew", kind: "package" as const, ...r })) }, EARLY);
  recordScan(db, "b", { sourceKind: "app", location: "/Applications", status: "ok", installs: [{ ecosystem: "bundle", key: "delta", name: "Delta", kind: "app", version: "1.0", location: "/d", details: {} }] }, LATE);
  db.prepare("UPDATE packages SET category = 'tool', category_source = 'manual' WHERE key = 'alpha'").run();
  db.prepare("UPDATE packages SET category = 'game', category_source = 'generated' WHERE key = 'beta'").run();
  db.prepare("UPDATE installs SET last_seen = ? WHERE id = (SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'alpha')").run(LATE);
  const alpha = (db.prepare("SELECT i.id, i.package_id AS packageId FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'alpha'").get() as { id: number; packageId: number });
  const beta = (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'beta'").get() as { id: number }).id;
  db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '2.0', 'test', ?)").run(alpha.id, EARLY);
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, 1, 'test', ?)").run(alpha.id, "last_used", LATE, LATE);
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, 1, 'test', ?)").run(alpha.id, "use_count", "2", LATE);
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, ?, ?, 1, 'test', ?)").run(beta, "use_count", "12", LATE);
  return db;
}

const names = (db: Db, f: Filter): string[] => queryInstalls(db, { limit: 50, ...f }).map((r) => r.name);

test("every sort accepts both directions and places nulls last", () => {
  const db = seed();
  try {
    const sorts: NonNullable<Filter["sort"]>[] = ["name", "path", "machine", "source", "kind", "ecosystem", "version", "category", "publisher", "lastUsed", "firstSeen", "lastSeen", "useCount"];
    const expected: Record<NonNullable<Filter["sort"]>, [string[], string[]]> = {
      name: [["Alpha", "Beta", "Delta", "Gamma"], ["Gamma", "Delta", "Beta", "Alpha"]],
      path: [["Alpha", "Beta", "Gamma", "Delta"], ["Delta", "Gamma", "Beta", "Alpha"]],
      machine: [["Alpha", "Beta", "Gamma", "Delta"], ["Delta", "Alpha", "Beta", "Gamma"]],
      source: [["Delta", "Alpha", "Beta", "Gamma"], ["Alpha", "Beta", "Gamma", "Delta"]],
      kind: [["Delta", "Alpha", "Beta", "Gamma"], ["Alpha", "Beta", "Gamma", "Delta"]],
      ecosystem: [["Alpha", "Beta", "Gamma", "Delta"], ["Delta", "Alpha", "Beta", "Gamma"]],
      version: [["Delta", "Alpha", "Beta", "Gamma"], ["Beta", "Alpha", "Delta", "Gamma"]],
      category: [["Beta", "Alpha", "Delta", "Gamma"], ["Alpha", "Beta", "Delta", "Gamma"]],
      publisher: [["Alpha", "Beta", "Delta", "Gamma"], ["Beta", "Alpha", "Delta", "Gamma"]],
      lastUsed: [["Alpha", "Beta", "Delta", "Gamma"], ["Alpha", "Beta", "Delta", "Gamma"]],
      firstSeen: [["Alpha", "Beta", "Gamma", "Delta"], ["Delta", "Alpha", "Beta", "Gamma"]],
      lastSeen: [["Beta", "Gamma", "Alpha", "Delta"], ["Alpha", "Delta", "Beta", "Gamma"]],
      useCount: [["Alpha", "Beta", "Delta", "Gamma"], ["Beta", "Alpha", "Delta", "Gamma"]],
    };
    for (const sort of sorts) {
      const asc = queryInstalls(db, { sort, dir: "asc" });
      const desc = queryInstalls(db, { sort, dir: "desc" });
      assert.equal(asc.length, 4, sort);
      assert.equal(desc.length, 4, sort);
      assert.deepEqual(new Set(asc.map((r) => r.installId)), new Set(desc.map((r) => r.installId)), sort);
      assert.deepEqual(asc.map((r) => r.name), expected[sort][0], `${sort} asc`);
      assert.deepEqual(desc.map((r) => r.name), expected[sort][1], `${sort} desc`);
      const field = (sort === "path" ? "location" : sort === "machine" ? "machineId" : sort === "source" ? "sourceKind" : sort) as keyof typeof asc[number];
      if (["version", "category", "publisher", "lastUsed", "useCount"].includes(sort)) {
        const nullCount = asc.filter((r) => r[field as keyof typeof r] === null).length;
        if (nullCount) {
          assert.ok(asc.slice(-nullCount).every((r) => r[field] === null), `${sort} asc nulls`);
          assert.ok(desc.slice(-nullCount).every((r) => r[field] === null), `${sort} desc nulls`);
        }
      }
    }
    assert.deepEqual(names(db, { sort: "version" }), ["Delta", "Alpha", "Beta", "Gamma"]);
    assert.deepEqual(names(db, { sort: "version", dir: "desc" }), ["Beta", "Alpha", "Delta", "Gamma"]);
    assert.deepEqual(names(db, { sort: "useCount" }).slice(0, 2), ["Beta", "Alpha"]);
    assert.deepEqual(names(db, { sort: "firstSeen" })[0], "Delta");
  } finally { db.close(); }
});

test("paging keeps every install exactly once when sort values tie", () => {
  const db = seed();
  try {
    db.prepare("UPDATE packages SET name = 'Same'").run();
    for (const sort of ["name", "version", "machine"] as const) {
      const full = queryInstalls(db, { sort, limit: 20 }).map((r) => r.installId);
      const pages = [0, 1, 2, 3].flatMap((offset) => queryInstalls(db, { sort, limit: 1, offset }).map((r) => r.installId));
      assert.deepEqual(pages, full, sort);
    }
  } finally { db.close(); }
});

test("new catalog filters and row fields read stored facts", () => {
  const db = seed();
  try {
    const checks: [Filter, string[]][] = [
      [{ publishers: ["Acme"] }, ["Alpha"]], [{ scopes: ["machine"] }, ["Beta"]],
      [{ descriptionSources: ["source"] }, ["Alpha"]], [{ categorySources: ["manual"] }, ["Alpha"]],
      [{ hasHomepage: true }, ["Alpha"]], [{ hasHomepage: false }, ["Beta", "Delta", "Gamma"]],
      [{ versionKnown: false }, ["Gamma"]], [{ versionKnown: true }, ["Alpha", "Beta", "Delta"]],
      [{ constrained: true }, ["Alpha"]], [{ seenBefore: LATE }, ["Beta", "Gamma"]],
      [{ seenSince: LATE }, ["Alpha", "Delta"]], [{ installedBefore: LATE }, ["Alpha", "Beta", "Gamma"]],
    ];
    for (const [filter, expected] of checks) assert.deepEqual(names(db, filter).sort(), expected, JSON.stringify(filter));
    const row = queryInstalls(db, { publishers: ["Acme"] })[0];
    assert.equal(row?.lastSeen, LATE);
    assert.equal(row?.useCount, 2);
    assert.equal(row?.ecosystem, "brew");
    assert.equal(row?.publisher, "Acme");
  } finally { db.close(); }
});

test("every facet excludes its own filter and keeps the other filters", () => {
  const db = seed();
  try {
    const dimensions = ["machine", "source", "ecosystem", "kind", "category", "publisher", "scope", "descriptionSource"] as const;
    const filter: Filter = { machines: ["a"], sources: ["brew"], ecosystems: ["brew"], kinds: ["package"], categories: ["tool"], publishers: ["Acme"], scopes: ["user"], descriptionSources: ["source"] };
    for (const dimension of dimensions) {
      const facets = facetCounts(db, filter, dimension);
      assert.ok(facets.some((r) => r.value !== "(none)" && r.count > 0), dimension);
    }
    assert.ok(facetCounts(db, { ...filter, categories: ["missing"] }, "category").some((r) => r.value === "tool"));
    assert.ok(facetCounts(db, { ...filter, publishers: ["missing"] }, "publisher").some((r) => r.value === "Acme"));
    assert.equal(countInstalls(db, filter), 1);
  } finally { db.close(); }
});

test("two thousand installs return rows and facets within 500 ms", () => {
  const db = openCatalog(":memory:");
  try {
    upsertMachine(db, { id: "a", name: "A", os: "macos", kind: "host" });
    recordScan(db, "a", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: Array.from({ length: 2000 }, (_, i) => ({ ecosystem: "brew", key: `pkg${i}`, name: `Package ${i}`, kind: "package" as const, version: `${i}.0`, location: `/opt/${i}` })) }, LATE);
    const start = performance.now();
    assert.equal(queryInstalls(db, { sort: "version", limit: 100 }).length, 100);
    for (const dimension of ["machine", "source", "ecosystem", "kind", "category", "publisher", "scope", "descriptionSource"] as const) facetCounts(db, {}, dimension);
    assert.ok(performance.now() - start < 500);
  } finally { db.close(); }
});
