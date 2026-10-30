import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, recordDependencies, recordResearch, recordScan, setAutoUpdate, upsertMachine, type Db, type Exec } from "@scout/core";
import { Runner } from "@scout/ops";
import { createHub } from "../src/server.ts";
import { WindowRun, optedInGroups } from "../src/update-window-schedule.ts";

const exec: Exec = async () => ({ exitCode: 0, stdout: "git 1.0\n", stderr: "" });
const machines = [{ id: "mini", transport: { type: "local" as const } }];
const inWindow = Date.parse("2026-10-20T04:00:00.000Z");

function seed(t: TestContext, count = 1): { db: Db; runner: Runner } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  const keys = Array.from({ length: count }, (_, index) => `pkg${index}`);
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: keys.map((key) => ({ ecosystem: "brew", key, name: key, kind: "package" as const, version: "1.0", location: "" })) }, "2026-10-20T00:00:00.000Z");
  for (const row of db.prepare("SELECT id FROM packages").all() as { id: number }[]) recordResearch(db, row.id, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  const runner = new Runner(db, { machines, exec });
  // Queued jobs finish on their own after the test body, so the catalog closes a moment later.
  t.after(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); db.close(); });
  return { db, runner };
}

const clockAt = (ms: { value: number }) => ({ now: () => ms.value, setTimeout: () => ({}), clearTimeout: () => undefined });
const jobCount = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
const installOf = (db: Db, key: string): number => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ?").get(key) as { id: number }).id;

test("a fresh run applies only opted-in programs, so switching it on alone queues nothing", (t) => {
  const { db, runner } = seed(t);
  const run = new WindowRun(db, runner, { clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  assert.equal(run.status().scope, "opted-in");
  run.start();
  run.setEnabled(true);
  assert.equal(jobCount(db), 0);
  assert.equal(run.status().lastQueued, 0);
});

test("an opted-in program within its limit is queued, and one past its limit is not", (t) => {
  const { db, runner } = seed(t);
  setAutoUpdate(db, installOf(db, "pkg0"), "patch");
  const blocked = new WindowRun(db, runner, { clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  blocked.start();
  blocked.setEnabled(true);
  assert.equal(jobCount(db), 0);
  setAutoUpdate(db, installOf(db, "pkg0"), "major");
  const allowed = new WindowRun(db, runner, { clock: clockAt({ value: Date.parse("2026-10-21T04:00:00.000Z") }), offsetMinutes: () => 0 });
  allowed.start();
  allowed.setEnabled(true);
  assert.equal(jobCount(db), 1);
});

test("only the opted-in program runs when two are planned", (t) => {
  const { db, runner } = seed(t, 2);
  setAutoUpdate(db, installOf(db, "pkg1"), "major");
  const run = new WindowRun(db, runner, { clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  run.start();
  run.setEnabled(true);
  assert.equal(jobCount(db), 1);
  assert.equal((db.prepare("SELECT install_id AS id FROM jobs").get() as { id: number }).id, installOf(db, "pkg1"));
});

test("the all scope still runs everything planned, and the scope survives a restart", (t) => {
  const { db, runner } = seed(t);
  const dir = mkdtempSync(join(tmpdir(), "scout-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-window.json");
  const run = new WindowRun(db, runner, { path, clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  run.setScope("all");
  run.start();
  run.setEnabled(true);
  assert.equal(jobCount(db), 1);
  assert.equal(new WindowRun(db, runner, { path }).status().scope, "all");
  assert.throws(() => run.setScope("some" as never), /scope must be/);
});

test("a state file from before the scope existed keeps running everything", (t) => {
  const { db, runner } = seed(t);
  const dir = mkdtempSync(join(tmpdir(), "scout-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-window.json");
  writeFileSync(path, JSON.stringify({ enabled: true, lastWindowStart: null, lastQueued: 0, lastRunAt: null, cap: 15, lastDeferred: 0, pausedReason: null, batchIds: [] }));
  assert.equal(new WindowRun(db, runner, { path }).status().scope, "all");
  writeFileSync(path, JSON.stringify({ enabled: false }));
  assert.equal(new WindowRun(db, runner, { path }).status().scope, "opted-in");
});

test("a library runs with its programs only when all of them are opted in", (t) => {
  const { db } = seed(t, 3);
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [
    { from: { ecosystem: "brew", key: "pkg1" }, to: { ecosystem: "brew", key: "pkg2" }, kind: "library", constraint: null, builtAgainst: "1.0", evidence: "keg" },
  ] }, "2026-10-20T00:00:00.000Z");
  const [lib, program, alone] = [installOf(db, "pkg2"), installOf(db, "pkg1"), installOf(db, "pkg0")];
  const ordered = [lib, program, alone];
  assert.deepEqual(optedInGroups(db, ordered, new Set([lib, alone])), [alone]);
  assert.deepEqual(optedInGroups(db, ordered, new Set(ordered)), ordered);
  assert.deepEqual(optedInGroups(db, ordered, new Set()), []);
});

test("the routes opt a program in and out, set the scope, and refuse bad input", async (t) => {
  const { db } = seed(t);
  const server = createHub({ db, webRoot: process.cwd(), jobs: { machines, exec } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const installId = installOf(db, "pkg0");
  assert.deepEqual((await call("GET", "/api/updates/auto-updates")).data.autoUpdates, []);
  const saved = await call("POST", "/api/updates/auto-updates", { installId, maxBump: "minor" });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.autoUpdates[0].maxBump, "minor");
  assert.equal((await call("GET", "/api/updates/window")).data.autoUpdates.length, 1);
  assert.equal((await call("POST", "/api/updates/auto-updates", { installId, maxBump: "huge" })).status, 400);
  assert.equal((await call("POST", "/api/updates/auto-updates", { installId: "1", maxBump: "minor" })).status, 400);
  assert.equal((await call("POST", "/api/updates/auto-updates", { installId: 9999, maxBump: "minor" })).status, 404);
  assert.deepEqual((await call("POST", "/api/updates/auto-updates", { installId, maxBump: null })).data.autoUpdates, []);
  assert.equal((await call("POST", "/api/updates/window/auto", { scope: "all" })).data.scope, "all");
  assert.equal((await call("POST", "/api/updates/window/auto", { scope: "most" })).status, 400);
  assert.equal((await call("GET", "/api/updates/window")).data.autoRun.scope, "all");
});
