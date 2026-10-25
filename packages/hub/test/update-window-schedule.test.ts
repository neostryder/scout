import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, recordResearch, recordScan, upsertMachine, type Db, type Exec } from "@scout/core";
import { Runner } from "@scout/ops";
import { createHub } from "../src/server.ts";
import { WindowRun } from "../src/update-window-schedule.ts";

const exec: Exec = async () => ({ exitCode: 0, stdout: "git 1.0\n", stderr: "" });
const machines = [{ id: "mini", transport: { type: "local" as const } }];
const inWindow = Date.parse("2026-10-20T04:00:00.000Z");
const outside = Date.parse("2026-10-20T12:00:00.000Z");

function seed(t: TestContext, running = false): { db: Db; runner: Runner } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [{ ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.0", location: "" }] }, "2026-10-20T00:00:00.000Z");
  recordResearch(db, (db.prepare("SELECT id FROM packages").get() as { id: number }).id, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  if (running) db.prepare("INSERT INTO usage_signals (install_id, kind, value, available, origin, observed_at) VALUES ((SELECT id FROM installs), 'running', '1', 1, 'test', '2026-10-20T00:00:00.000Z')").run();
  const runner = new Runner(db, { machines, exec });
  // Queued jobs finish on their own after the test body, so the catalog closes a moment later.
  t.after(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); db.close(); });
  return { db, runner };
}

const clockAt = (ms: { value: number }) => ({ now: () => ms.value, setTimeout: () => ({}), clearTimeout: () => undefined });
const jobCount = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;

test("nothing is queued while the switch is off", (t) => {
  const { db, runner } = seed(t);
  const run = new WindowRun(db, runner, { clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  assert.equal(run.tick(), 0);
  assert.equal(jobCount(db), 0);
});

test("nothing is queued outside the quiet window", (t) => {
  const { db, runner } = seed(t);
  const run = new WindowRun(db, runner, { clock: clockAt({ value: outside }), offsetMinutes: () => 0 });
  run.setEnabled(true);
  assert.equal(run.tick(), 0);
  assert.equal(jobCount(db), 0);
});

test("an open window queues the plan once, and the next window runs again", (t) => {
  const { db, runner } = seed(t);
  const time = { value: inWindow };
  const logs: string[] = [];
  const run = new WindowRun(db, runner, { clock: clockAt(time), offsetMinutes: () => 0, log: (line) => logs.push(line) });
  run.start();
  run.setEnabled(true);
  assert.equal(run.status().lastQueued, 1);
  assert.equal(jobCount(db), 1);
  time.value += 600_000;
  assert.equal(run.tick(), 0);
  assert.equal(jobCount(db), 1);
  time.value = Date.parse("2026-10-21T04:00:00.000Z");
  run.tick();
  assert.equal(run.status().lastWindowStart, "2026-10-21T03:30:00.000Z");
  assert.ok(logs.some((line) => /queued 1 update$/.test(line)));
});

test("a running program is updated in the window because the run allows disruptive updates", (t) => {
  const { db, runner } = seed(t, true);
  const run = new WindowRun(db, runner, { clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  run.start();
  run.setEnabled(true);
  assert.equal(jobCount(db), 1);
});

test("the switch and the last run survive a restart", (t) => {
  const { db, runner } = seed(t);
  const dir = mkdtempSync(join(tmpdir(), "scout-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-window.json");
  const first = new WindowRun(db, runner, { path, clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  first.start();
  first.setEnabled(true);
  const second = new WindowRun(db, runner, { path, clock: clockAt({ value: inWindow }), offsetMinutes: () => 0 });
  assert.deepEqual(second.status(), first.status());
  assert.equal(second.status().enabled, true);
  assert.equal(second.tick(), 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).lastWindowStart, "2026-10-20T03:30:00.000Z");
});

test("a damaged state file reads as switched off", (t) => {
  const { db, runner } = seed(t);
  const dir = mkdtempSync(join(tmpdir(), "scout-window-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "update-window.json");
  writeFileSync(path, "{not json");
  assert.equal(new WindowRun(db, runner, { path }).status().enabled, false);
});

test("the auto route switches the run on and off and refuses anything else", async (t) => {
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
  assert.equal((await call("GET", "/api/updates/window")).data.autoRun.enabled, false);
  const on = await call("POST", "/api/updates/window/auto", { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.data.enabled, true);
  assert.equal((await call("GET", "/api/updates/window")).data.autoRun.enabled, true);
  assert.equal((await call("POST", "/api/updates/window/auto", { enabled: "yes" })).status, 400);
  assert.equal((await call("POST", "/api/updates/window/auto", { enabled: false })).data.enabled, false);
});

test("the auto route does not exist without a job runner", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const server = createHub({ db, webRoot: process.cwd() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/updates/window/auto", method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 404);
});
