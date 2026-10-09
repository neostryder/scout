import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { assessUpdate, openCatalog, queryUpdates, recordDependencies, recordResearch, recordScan, riskCounts, updatesView, updateTarget, upsertMachine, type Db, type UpdateRow } from "../src/index.ts";

const T = "2026-09-30T12:00:00Z";

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (const machine of ["mini", "hub"]) {
    upsertMachine(db, { id: machine, name: machine, os: "macos", kind: "host" });
    recordScan(db, machine, { sourceKind: "test", location: "", status: "ok", installs: [
      { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
      { ecosystem: "brew", key: "node", name: "node", kind: "runtime", version: "26.10.0", location: "" },
      { ecosystem: "npm", key: "tool", name: "tool", kind: "package", version: "1.0.0", location: "" },
      { ecosystem: "npm", key: "unknown", name: "unknown", kind: "package", version: "1.0.0", location: "" },
      { ecosystem: "npm", key: "unconstrained", name: "unconstrained", kind: "package", version: "1.0.0", location: "" },
      { ecosystem: "python", key: "3.14", name: "Python", kind: "runtime", version: "3.14.3", location: "" },
      { ecosystem: "pipx", key: "ruff", name: "ruff", kind: "package", version: "1.0.0", location: "" },
    ] }, T);
    recordDependencies(db, machine, { origin: "brew-deps", status: "ok", facts: [
      { from: { ecosystem: "brew", key: "node" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3_1", evidence: "keg" },
      { from: { ecosystem: "brew", key: "llhttp" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "self edge" },
    ] }, T);
    recordDependencies(db, machine, { origin: "npm-engines", status: "ok", facts: ["tool", "unknown", "unconstrained"].map((key) => ({
      from: { ecosystem: "npm", key }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint: key === "tool" ? ">=24 <27" : key === "unknown" ? "broken range" : null, builtAgainst: "26.10.0", evidence: "engines.node",
    })) }, T);
    recordDependencies(db, machine, { origin: "pyvenv", status: "ok", facts: [
      { from: { ecosystem: "pipx", key: "ruff" }, to: { ecosystem: "runtime", key: "python" }, kind: "runtime", constraint: "==3.14.*", builtAgainst: "3.14.3", evidence: "pyvenv.cfg" },
    ] }, T);
  }
  for (const row of db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[]) {
    const version = row.key === "llhttp" ? "9.5.0" : row.key === "node" ? "27.0.0" : row.key === "3.14" ? "3.15.0" : "2.0.0";
    recordResearch(db, row.id, "test", "ok", [{ channel: "stable", version, installable: true }], null, T);
  }
  return db;
}

test("riskCounts matches assessment for libraries, revisions, runtime ranges, null targets and upstream targets", (t) => {
  const db = seed(t);
  const all = updatesView(db);
  const rows: UpdateRow[] = [];
  for (const row of all) {
    rows.push(row, { ...row, updatable: false, upstream: "27.0.0" }, { ...row, updatable: false, upstream: null });
    if (row.key === "llhttp") rows.push({ ...row, available: "9.4.3_2" });
    if (row.key === "node") rows.push({ ...row, available: "26.11.0" });
    if (row.key === "3.14") rows.push({ ...row, available: "3.14.5" });
  }
  riskCounts(db, rows);
  for (const row of rows) {
    const target = updateTarget(row);
    const assessment = target === null ? null : assessUpdate(db, row.installId, target);
    assert.deepEqual(row.risk, assessment === null ? null : { hard: assessment.hard.length, soft: assessment.soft.length }, `${row.machineId}/${row.key}/${target}`);
  }
  assert.deepEqual(all.find((row) => row.key === "node")?.risk, { hard: 1, soft: 1 });
  assert.deepEqual(all.find((row) => row.key === "llhttp")?.risk, { hard: 0, soft: 1 });
});

test("riskCounts ignores removed dependent and target installs and loads edges once for a list", (t) => {
  const db = seed(t);
  const rows = updatesView(db);
  db.prepare("UPDATE installs SET removed_at = ? WHERE package_id IN (SELECT id FROM packages WHERE key IN ('tool', 'llhttp'))").run(T);
  const expected = rows.map((row) => {
    const target = updateTarget(row)!;
    const result = assessUpdate(db, row.installId, target);
    return { hard: result.hard.length, soft: result.soft.length };
  });
  let queries = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { queries++; return prepare(sql); };
  riskCounts(db, rows);
  assert.equal(queries, 1);
  assert.deepEqual(rows.map((row) => row.risk), expected);
});

test("the safe filter hides hard breaks and keeps soft breaks, zero risk and null risk", (t) => {
  const db = seed(t);
  db.prepare("UPDATE assertions SET version = '26.11.0' WHERE package_id IN (SELECT id FROM packages WHERE key = 'node')").run();
  db.prepare("UPDATE assertions SET version = '1.0.0' WHERE package_id IN (SELECT id FROM packages WHERE key = 'tool')").run();
  const rows = updatesView(db, { safe: true });
  assert.ok(!rows.some((row) => row.key === "3.14"));
  assert.deepEqual(rows.find((row) => row.key === "llhttp")?.risk, { hard: 0, soft: 1 });
  assert.deepEqual(rows.find((row) => row.key === "node")?.risk, { hard: 0, soft: 1 });
  assert.equal(rows.find((row) => row.key === "tool")?.risk, null);
  assert.deepEqual(rows.find((row) => row.key === "ruff")?.risk, { hard: 0, soft: 0 });
  const result = queryUpdates(db, { safe: true, status: ["current", "updatable"] });
  assert.equal(result.total, rows.length);
  assert.equal(result.facets.machine.reduce((sum, facet) => sum + facet.count, 0), rows.length);
  assert.ok(result.rows.every((row) => (row.risk?.hard ?? 0) === 0));
});

test("a freeze selects the upstream target for risk and no upstream leaves risk null", (t) => {
  const db = seed(t);
  const row = updatesView(db).find((entry) => entry.machineId === "mini" && entry.key === "llhttp")!;
  db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '9.4.3', 'test', ?)").run(row.installId, T);
  assert.equal(updatesView(db).find((entry) => entry.installId === row.installId)?.risk, null);
  recordResearch(db, row.packageId, "upstream", "ok", [{ channel: "stable", version: "10.0.0", installable: false }], null, T);
  const frozen = updatesView(db).find((entry) => entry.installId === row.installId)!;
  assert.equal(updateTarget(frozen), "10.0.0");
  assert.deepEqual(frozen.risk, { hard: 0, soft: 1 });
});
