import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordDependencies, recordResearch, recordScan, upsertMachine, type Db } from "@scout/core";
import { planWindows } from "../src/window.ts";

const T = "2026-10-20T00:00:00.000Z";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const machines = [{ id: "mini", transport: { type: "local" as const } }];

function seed(t: TestContext, available: Record<string, string> = {}): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "mini", name: "mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
    { ecosystem: "brew", key: "node", name: "node", kind: "runtime", version: "26.10.0", location: "" },
    { ecosystem: "brew", key: "eza", name: "eza", kind: "package", version: "1.0.0", location: "" },
  ] }, T);
  recordScan(db, "mini", { sourceKind: "npm", location: "", status: "ok", installs: [{ ecosystem: "npm", key: "tool", name: "tool", kind: "package", version: "1.0.0", location: "" }] }, T);
  const versions: Record<string, string> = { llhttp: "9.5.0", node: "27.0.0", eza: "2.0.0", tool: "2.0.0", ...available };
  for (const row of db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[]) {
    recordResearch(db, row.id, "test", "ok", [{ channel: "stable", version: versions[row.key]!, installable: true }], null, T);
  }
  return db;
}

const id = (db: Db, key: string): number => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ?").get(key) as { id: number }).id;
const names = (items: { name: string }[]): string[] => items.map((item) => item.name);
const plan = (db: Db) => planWindows(db, machines, NOW, 0).machines.find((machine) => machine.machineId === "mini")!;

function library(db: Db): void {
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [
    { from: { ecosystem: "brew", key: "eza" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "keg" },
  ] }, T);
}

function runtime(db: Db): void {
  recordDependencies(db, "mini", { origin: "npm-engines", status: "ok", facts: [
    { from: { ecosystem: "npm", key: "tool" }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint: "<27", builtAgainst: "26.10.0", evidence: "engines.node" },
  ] }, T);
}

const running = (db: Db, key: string): void => {
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES (?, 'running', '1', 1, 'test', ?)").run(id(db, key), T);
};

test("updates with nothing in the way all start now, with what an install uses first", (t) => {
  const db = seed(t);
  library(db);
  const result = plan(db);
  assert.deepEqual(result.atQuietHour, []);
  assert.deepEqual(result.held.map((item) => item.name).filter((name) => name !== "node"), []);
  const order = names(result.now);
  assert.ok(order.indexOf("llhttp") < order.indexOf("eza"), order.join(","));
  assert.ok(order.includes("tool"));
});

test("a running program and what shares a library with it wait for the quiet hour together", (t) => {
  const db = seed(t);
  library(db);
  running(db, "eza");
  const result = plan(db);
  assert.deepEqual(names(result.atQuietHour), ["llhttp", "eza"]);
  assert.ok(!names(result.now).includes("eza") && !names(result.now).includes("llhttp"));
  assert.ok(names(result.now).includes("tool"));
  assert.equal(result.atQuietHour.find((item) => item.name === "eza")?.running, true);
});

test("an update that a pinned runtime refuses is held with the reason, and goes ahead when its dependent updates too", (t) => {
  const together = seed(t);
  runtime(together);
  assert.ok(names(plan(together).now).includes("node"));
  const db = seed(t, { tool: "1.0.0" });
  runtime(db);
  const result = plan(db);
  const held = result.held.find((item) => item.name === "node");
  assert.equal(held?.kind, "blocked");
  assert.match(held?.reason ?? "", /tool/);
  assert.ok(!names(result.now).includes("node"));
});

test("a library whose dependents are not updating needs a check and is held", (t) => {
  const db = seed(t, { eza: "1.0.0" });
  library(db);
  const result = plan(db);
  const held = result.held.find((item) => item.name === "llhttp");
  assert.equal(held?.kind, "confirm");
  assert.match(held?.reason ?? "", /eza/);
  assert.ok(!names(result.now).includes("llhttp"));
});

test("the plan carries the fixed quiet window on the given clock", (t) => {
  const db = seed(t);
  const result = planWindows(db, machines, NOW, 0);
  assert.equal(result.quiet.startsAt, "2026-10-21T03:30:00.000Z");
  assert.equal(result.quiet.endsAt, "2026-10-21T05:30:00.000Z");
  assert.equal(result.quiet.inWindow, false);
  assert.equal(planWindows(db, machines, new Date("2026-10-20T04:00:00.000Z"), 0).quiet.inWindow, true);
});

test("an install with a job in flight and a machine with nothing pending are left out", (t) => {
  const db = seed(t);
  db.prepare("INSERT INTO jobs (batch_id, machine_id, install_id, action, target, state, requested_at, from_version) VALUES ('b', 'mini', ?, 'update', '2.0.0', 'queued', ?, '1.0.0')").run(id(db, "tool"), T);
  const result = plan(db);
  assert.ok(![...result.now, ...result.atQuietHour, ...result.held].some((item) => item.name === "tool"));
  assert.equal(planWindows(openCatalog(":memory:"), machines, NOW, 0).machines.length, 0);
});
