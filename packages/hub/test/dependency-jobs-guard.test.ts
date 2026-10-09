import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordDependencies, recordResearch, recordScan, upsertMachine, type Db } from "@scout/core";
import { Runner, type Preview } from "@scout/ops";
import { updatesResponse } from "../src/api.ts";
import { createJobsResponse, planResponse } from "../src/jobs-api.ts";

const T = "2026-09-30T12:00:00Z";

function seed(t: TestContext): { db: Db; runner: Runner } {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (const machine of ["mini", "hub"]) {
    upsertMachine(db, { id: machine, name: machine, os: "macos", kind: "host" });
    recordScan(db, machine, { sourceKind: "test", location: "", status: "ok", installs: [
      { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
      { ecosystem: "brew", key: "eza", name: "eza", kind: "package", version: "1.0.0", location: "" },
      { ecosystem: "brew", key: "node", name: "node", kind: "runtime", version: "26.10.0", location: "" },
      { ecosystem: "npm", key: "tool", name: "tool", kind: "package", version: "1.0.0", location: "" },
    ] }, T);
  }
  for (const row of db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[]) {
    recordResearch(db, row.id, "test", "ok", [{ channel: "stable", version: row.key === "llhttp" ? "9.5.0" : row.key === "node" ? "27.0.0" : "2.0.0", installable: true }], null, T);
  }
  const runner = new Runner(db, { machines: ["mini", "hub"].map((id) => ({ id, transport: { type: "local" } })), exec: async () => { throw new Error("the test does not run queued jobs"); } });
  runner.wake = () => {};
  return { db, runner };
}

function id(db: Db, key: string, machine = "mini"): number {
  return (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ? AND i.machine_id = ?").get(key, machine) as { id: number }).id;
}

function library(db: Db): void {
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [
    { from: { ecosystem: "brew", key: "eza" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "keg" },
  ] }, T);
}

function runtime(db: Db, constraint = "<27"): void {
  recordDependencies(db, "mini", { origin: "npm-engines", status: "ok", facts: [
    { from: { ecosystem: "npm", key: "tool" }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint, builtAgainst: "26.10.0", evidence: "engines.node" },
  ] }, T);
}

interface JobsBody { batchId: string | null; jobs: { installId: number }[]; refused: { installId: number; reason: string }[] }

test("the updates handler returns risk and safe=1 removes hard breaks", (t) => {
  const { db } = seed(t);
  library(db);
  runtime(db);
  const all = updatesResponse(db, new URLSearchParams()) as { total: number; rows: { key: string; machineId: string; risk: { hard: number; soft: number } | null }[] };
  assert.deepEqual(all.rows.find((row) => row.key === "llhttp" && row.machineId === "mini")?.risk, { hard: 0, soft: 1 });
  assert.deepEqual(all.rows.find((row) => row.key === "node" && row.machineId === "mini")?.risk, { hard: 1, soft: 0 });
  const safe = updatesResponse(db, new URLSearchParams("safe=1")) as typeof all;
  assert.equal(safe.total, all.total - 1);
  assert.ok(safe.rows.every((row) => (row.risk?.hard ?? 0) === 0));
  assert.equal((updatesResponse(db, new URLSearchParams("safe=true")) as typeof all).total, all.total);
});

test("the plan handler parses alsoInstallIds and accepts only same-machine dependents", (t) => {
  const { db, runner } = seed(t);
  library(db);
  runtime(db);
  for (const [key, dependent] of [["node", "tool"]]) {
    const installId = id(db, key!);
    assert.equal((planResponse(db, runner, installId) as Preview).allowed, false);
    assert.equal((planResponse(db, runner, installId, `${id(db, dependent!)},999999`) as Preview).allowed, true);
    assert.equal((planResponse(db, runner, installId, `${id(db, dependent!, "hub")},${installId}`) as Preview).allowed, false);
    assert.equal((planResponse(db, runner, installId, "-1,0,1.5,junk,9007199254740992") as Preview).allowed, false);
  }
});

test("a library change needs confirmSoft unless its dependents update in the same batch", (t) => {
  const { db, runner } = seed(t);
  library(db);
  const installId = id(db, "llhttp");
  const alone = createJobsResponse(db, runner, { installIds: [installId], confirm: true });
  assert.equal(alone.status, 409);
  assert.equal((alone.body as JobsBody).refused[0]?.reason, "needs confirmation: eza");
  const confirmed = createJobsResponse(db, runner, { installIds: [installId], confirm: true, confirmSoft: true });
  assert.equal(confirmed.status, 202);
  const second = seed(t);
  library(second.db);
  const together = createJobsResponse(second.db, second.runner, { installIds: [id(second.db, "llhttp"), id(second.db, "eza")], confirm: true });
  assert.equal(together.status, 202);
  assert.deepEqual((together.body as JobsBody).refused, []);
});

test("job creation refuses hard breaks even with confirmSoft and accepts runtime batches", (t) => {
  for (const kind of ["runtime"]) {
    const { db, runner } = seed(t);
    if (kind === "library") library(db);
    else runtime(db);
    const installId = id(db, kind === "library" ? "llhttp" : "node");
    const dependentId = id(db, kind === "library" ? "eza" : "tool");
    const blocked = createJobsResponse(db, runner, { installIds: [installId], confirm: true, confirmSoft: true });
    assert.equal(blocked.status, 400);
    assert.equal((blocked.body as JobsBody).jobs.length, 0);
    assert.match((blocked.body as JobsBody).refused[0]!.reason, /update them together or leave this one/);
    const result = createJobsResponse(db, runner, { installIds: [installId, dependentId], confirm: true });
    assert.equal(result.status, 202);
    assert.deepEqual((result.body as JobsBody).jobs.map((job) => job.installId), [installId, dependentId]);
    assert.deepEqual((result.body as JobsBody).refused, []);
  }
});

test("foreign batch partners cannot excuse a local break", (t) => {
  const { db, runner } = seed(t);
  library(db);
  const local = id(db, "llhttp");
  const foreign = id(db, "eza", "hub");
  const result = createJobsResponse(db, runner, { installIds: [local, foreign], confirm: true });
  assert.equal(result.status, 202);
  assert.deepEqual((result.body as JobsBody).jobs.map((job) => job.installId), [foreign]);
  assert.equal((result.body as JobsBody).refused[0]?.installId, local);
});

test("job creation removes refused partners and repeats the guard for cascading breaks", (t) => {
  const { db, runner } = seed(t);
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [
    { from: { ecosystem: "brew", key: "eza" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "keg" },
    { from: { ecosystem: "brew", key: "node" }, to: { ecosystem: "brew", key: "eza" }, kind: "library", constraint: null, builtAgainst: "1.0.0", evidence: "keg" },
  ] }, T);
  db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '26.10.0', 'test', ?)").run(id(db, "node"), T);
  const result = createJobsResponse(db, runner, { installIds: [id(db, "llhttp"), id(db, "eza"), id(db, "node")], confirm: true });
  assert.equal(result.status, 409);
  assert.equal((result.body as JobsBody).jobs.length, 0);
  assert.equal((result.body as JobsBody).refused.length, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
});

test("soft requirements and project pins return 409 until confirmSoft is true", (t) => {
  const { db, runner } = seed(t);
  runtime(db, "broken range");
  recordScan(db, "mini", { sourceKind: "projectsel", location: "/projects", status: "ok", installs: [], selectors: [
    { file: "/projects/site/.nvmrc", project: "/projects/site", kind: "node", tool: "node", spec: "26.10.0" },
    { file: "/projects/site/package.json", project: "/projects/site", kind: "engines", tool: "node", spec: "<27" },
  ] }, T);
  const installId = id(db, "node");
  for (const confirmSoft of [undefined, false, "true", 1]) {
    const result = createJobsResponse(db, runner, { installIds: [installId], confirm: true, confirmSoft });
    assert.equal(result.status, 409);
    assert.equal((result.body as JobsBody).batchId, null);
    assert.equal((result.body as JobsBody).refused[0]?.reason, "needs confirmation: site, tool");
  }
  const accepted = createJobsResponse(db, runner, { installIds: [installId], confirm: true, confirmSoft: true });
  assert.equal(accepted.status, 202);
  assert.deepEqual((accepted.body as JobsBody).refused, []);
});

test("a partial batch queues safe installs while refusing unconfirmed soft breaks", (t) => {
  const { db, runner } = seed(t);
  runtime(db, "broken range");
  const result = createJobsResponse(db, runner, { installIds: [id(db, "node"), id(db, "eza")], confirm: true });
  assert.equal(result.status, 202);
  assert.deepEqual((result.body as JobsBody).jobs.map((job) => job.installId), [id(db, "eza")]);
  assert.equal((result.body as JobsBody).refused[0]?.reason, "needs confirmation: tool");
});

test("duplicate and already queued partners cannot admit a broken install", (t) => {
  const { db, runner } = seed(t);
  library(db);
  const partner = id(db, "eza");
  const first = createJobsResponse(db, runner, { installIds: [partner, partner], confirm: true });
  assert.equal(first.status, 202);
  assert.equal((first.body as JobsBody).jobs.length, 1);
  assert.equal((first.body as JobsBody).refused.length, 1);
  const next = createJobsResponse(db, runner, { installIds: [id(db, "llhttp"), partner], confirm: true });
  assert.equal(next.status, 409);
  assert.equal((next.body as JobsBody).jobs.length, 0);
  assert.equal((next.body as JobsBody).refused.length, 2);
});
