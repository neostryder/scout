import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openCatalog, upsertMachine } from "@scout/core";
import { ScanSchedule, scanIntervalFromArgs, type ScanScheduleOptions } from "../src/scan-schedule.ts";
import type { ScheduleClock } from "../src/schedule.ts";
import { createHub, type HubOptions } from "../src/server.ts";
import type { Jwk } from "../src/access.ts";

const START = Date.parse("2026-10-18T00:00:00Z");
const HOUR = 3_600_000;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeClock implements ScheduleClock {
  time = START;
  serial = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
    this.time = until;
    await settle();
  }
}

function fixture(t: TestContext, overrides: Partial<ScanScheduleOptions> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "scout-scans-"));
  const machinesPath = join(folder, "machines.json");
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  const calls: { command: string; args: string[]; options: SpawnOptions; child: ChildProcess; at: number }[] = [];
  const lines: string[] = [];
  let autoClose = true;
  let code = 0;
  let updateCatalog = true;
  const writeMachines = (entries: { id: string; paused?: boolean; local?: boolean; guest?: boolean }[]) => {
    writeFileSync(machinesPath, JSON.stringify({ machines: entries.map(({ id, paused, local, guest }) => ({ id, name: id, os: "linux", paused, transport: local ? { type: "local" } : { type: "ssh", target: `test@${id}`, ...(guest ? { guest: ["colima", "ssh", "--"] } : {}) } })) }));
  };
  const seed = (id: string, lastScan: number | null = null) => {
    upsertMachine(db, { id, name: id, os: "linux", kind: "host" });
    db.prepare("UPDATE machines SET last_scan = ? WHERE id = ?").run(lastScan === null ? null : new Date(lastScan).toISOString(), id);
  };
  writeMachines([{ id: "one" }]);
  seed("one");
  const finish = (index = calls.length - 1) => {
    const call = calls[index]!;
    if (updateCatalog) db.prepare("UPDATE machines SET last_scan = ? WHERE id = ?").run(new Date(clock.now()).toISOString(), call.args[1]!);
    call.child.emit("close", code, null);
  };
  const schedule = new ScanSchedule(db, { machinesPath, dbPath: join(folder, "catalog.db"), root: folder, clock, log: (line) => lines.push(line), spawn: (command, args, options) => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    calls.push({ command, args, options, child, at: clock.now() });
    if (autoClose) queueMicrotask(() => finish());
    return child;
  }, kill: (child) => { (child as ChildProcess).emit("close", null, "SIGKILL"); }, ...overrides });
  t.after(async () => {
    schedule.stop();
    await settle();
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { db, clock, calls, lines, schedule, machinesPath, folder, writeMachines, seed, finish,
    hold() { autoClose = false; }, fail(exitCode = 0) { code = exitCode; updateCatalog = false; }, exit(exitCode: number) { code = exitCode; },
  };
}

test("scan interval accepts integer hours from 1 to 168 and rejects missing or invalid values", () => {
  assert.equal(scanIntervalFromArgs([]), 6 * HOUR);
  assert.equal(scanIntervalFromArgs(["--scan-interval", "1"]), HOUR);
  assert.equal(scanIntervalFromArgs(["--scan-interval", "168"]), 168 * HOUR);
  for (const value of [undefined, "0", "169", "1.5", "NaN", "--no-schedule", ""]) assert.throws(() => scanIntervalFromArgs(["--scan-interval", ...(value === undefined ? [] : [value])]), /integer from 1 to 168 hours/);
});

test("scans wait three minutes, select never scanned and old hosts in order, and persist cadence through restart", async (t) => {
  const f = fixture(t);
  f.writeMachines([{ id: "recent" }, { id: "old" }, { id: "older" }, { id: "one" }, { id: "guest", guest: true }]);
  f.seed("recent", START - HOUR);
  f.seed("old", START - 7 * HOUR);
  f.seed("older", START - 8 * HOUR);
  f.seed("guest");
  f.schedule.start();
  f.schedule.start();
  assert.equal(f.schedule.status().find((row) => row.machineId === "one")?.nextDueAt, new Date(START + 180_000).toISOString());
  await f.clock.advance(179_999);
  assert.equal(f.calls.length, 0);
  await f.clock.advance(1);
  assert.deepEqual(f.calls.map((call) => call.args[1]), ["one", "older", "old"]);
  assert.ok(f.schedule.status().filter((row) => row.machineId !== "recent").every((row) => row.lastOk === true));
  f.schedule.stop();
  f.schedule.start();
  await f.clock.advance(180_000);
  assert.equal(f.calls.length, 3);
  await f.clock.advance(5 * HOUR - 360_000);
  assert.equal(f.calls.at(-1)?.args[1], "recent");
});

test("custom startup delay and interval govern the first and subsequent scans", async (t) => {
  const f = fixture(t, { startupDelayMs: 1000, intervalMs: HOUR });
  f.schedule.start();
  await f.clock.advance(999);
  assert.equal(f.calls.length, 0);
  await f.clock.advance(1);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(HOUR - 1);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(1);
  assert.equal(f.calls.length, 2);
  f.schedule.stop();
  assert.equal(f.clock.timers.size, 0);
});

test("scan child receives the node command, hub database, hidden window and prefixed output", async (t) => {
  const f = fixture(t);
  f.hold();
  f.schedule.runNow("one");
  const call = f.calls[0]!;
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [join(f.folder, "packages/cli/src/scan.ts"), "one", "--db", join(f.folder, "catalog.db")]);
  assert.deepEqual(call.options, { cwd: f.folder, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  (call.child.stdout as PassThrough).write("first\nsec");
  (call.child.stdout as PassThrough).end("ond\n");
  (call.child.stderr as PassThrough).end("warning\n");
  await settle();
  assert.deepEqual(f.lines, ["[scan one] first", "[scan one] second", "[scan one] warning"]);
  f.finish();
  await settle();
  assert.equal(f.schedule.status()[0]?.lastOk, true);
});

test("exit zero without a fresh last_scan fails and backs off for an hour", async (t) => {
  const f = fixture(t, { startupDelayMs: 0 });
  f.fail();
  f.schedule.start();
  await f.clock.advance(0);
  assert.equal(f.schedule.status()[0]?.lastOk, false);
  assert.match(f.schedule.status()[0]?.lastError ?? "", /did not update/);
  assert.equal(f.schedule.status()[0]?.nextDueAt, new Date(START + HOUR).toISOString());
  await f.clock.advance(HOUR - 1);
  assert.equal(f.calls.length, 1);
  await f.clock.advance(1);
  assert.equal(f.calls.length, 2);
});

test("a stale catalog timestamp and a nonzero exit both fail even when only one success condition holds", async (t) => {
  const stale = fixture(t);
  stale.seed("one", START - 1);
  stale.fail();
  stale.schedule.runNow();
  await settle();
  assert.equal(stale.schedule.status()[0]?.lastOk, false);
  const nonzero = fixture(t);
  nonzero.exit(1);
  nonzero.schedule.runNow();
  await settle();
  assert.equal(nonzero.schedule.status()[0]?.lastScanAt, new Date(START).toISOString());
  assert.equal(nonzero.schedule.status()[0]?.lastOk, false);
  assert.match(nonzero.schedule.status()[0]?.lastError ?? "", /code 1/);
  assert.equal(nonzero.schedule.status()[0]?.nextDueAt, new Date(START + HOUR).toISOString());
});

test("failure backoff uses a shorter configured interval", async (t) => {
  const f = fixture(t, { intervalMs: 1000 });
  f.fail();
  f.schedule.runNow();
  await settle();
  assert.equal(f.schedule.status()[0]?.nextDueAt, new Date(START + 1000).toISOString());
});

test("a timeout kills the child and waits for its close before another scan can start", async (t) => {
  let kills = 0;
  const f = fixture(t, { timeoutMs: 1000, kill: () => { kills++; } });
  f.hold();
  f.fail();
  f.schedule.runNow();
  await f.clock.advance(1000);
  assert.equal(kills, 1);
  assert.deepEqual(f.schedule.runNow(), { started: false, reason: "a catalog scan is already running" });
  f.calls[0]!.child.emit("close", null, "SIGKILL");
  await settle();
  assert.equal(f.schedule.status()[0]?.lastOk, false);
  assert.equal(f.schedule.status()[0]?.lastError, "scan timed out");
});

test("manual requests refuse overlap and an all-machine drain runs one child at a time", async (t) => {
  const f = fixture(t);
  f.writeMachines([{ id: "one" }, { id: "two" }]);
  f.seed("two");
  f.hold();
  const result = f.schedule.runNow();
  assert.equal(result.started, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.schedule.runNow("two").started, false);
  f.finish();
  await settle();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.schedule.status().filter((row) => row.running).map((row) => row.machineId), ["two"]);
  f.finish();
  await settle();
  assert.ok(f.schedule.status().every((row) => row.lastOk));
});

test("stop kills an active child, drops the remaining machines, and leaves no timers", async (t) => {
  const f = fixture(t);
  f.writeMachines([{ id: "one" }, { id: "two" }]);
  f.seed("two");
  f.hold();
  f.schedule.runNow();
  f.schedule.stop();
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.schedule.status()[0]?.running, false);
  assert.equal(f.schedule.status()[0]?.lastError, "scan stopped");
});

test("paused hosts and guests keep catalog rows, reset on resume, and are re-read on each tick", async (t) => {
  const f = fixture(t);
  f.seed("two");
  upsertMachine(f.db, { id: "two/colima", name: "guest", os: "linux", kind: "guest", parentId: "two" });
  f.writeMachines([{ id: "one", local: true, paused: true }, { id: "two", paused: true }]);
  f.schedule.start();
  assert.equal((f.db.prepare("SELECT state FROM machines WHERE id = 'two'").get() as { state: string }).state, "paused");
  assert.equal((f.db.prepare("SELECT state FROM machines WHERE id = 'two/colima'").get() as { state: string }).state, "paused");
  assert.throws(() => f.schedule.runNow("two"), /unknown or paused/);
  await f.clock.advance(180_000);
  assert.deepEqual(f.calls.map((call) => call.args[1]), ["one"]);
  f.writeMachines([{ id: "one", local: true }, { id: "two" }]);
  await f.clock.advance(60_000);
  assert.deepEqual(f.calls.map((call) => call.args[1]), ["one", "two"]);
  assert.equal((f.db.prepare("SELECT state FROM machines WHERE id = 'two'").get() as { state: string }).state, "unknown");
});

test("a machine paused while waiting in a drain is skipped", async (t) => {
  const f = fixture(t);
  f.writeMachines([{ id: "one" }, { id: "two" }]);
  f.seed("two");
  f.hold();
  f.schedule.runNow();
  f.writeMachines([{ id: "one" }, { id: "two", paused: true }]);
  f.finish();
  await settle();
  assert.equal(f.calls.length, 1);
});

test("an automatic drain skips a machine whose catalog timestamp advances while another child runs", async (t) => {
  const f = fixture(t, { startupDelayMs: 0 });
  f.writeMachines([{ id: "one" }, { id: "two" }]);
  f.seed("two");
  f.hold();
  f.schedule.start();
  await f.clock.advance(0);
  f.db.prepare("UPDATE machines SET last_scan = ? WHERE id = 'two'").run(new Date(START).toISOString());
  f.finish();
  await settle();
  assert.equal(f.calls.length, 1);
});

test("the default timeout kills a scan after 45 minutes", async (t) => {
  let kills = 0;
  const f = fixture(t, { kill: (child) => { kills++; (child as ChildProcess).emit("close", null, "SIGKILL"); } });
  f.hold();
  f.schedule.runNow();
  await f.clock.advance(45 * 60_000 - 1);
  assert.equal(kills, 0);
  await f.clock.advance(1);
  assert.equal(kills, 1);
  assert.equal(f.schedule.status()[0]?.lastError, "scan timed out");
});

test("spawn errors release the drain and record failure", async (t) => {
  const f = fixture(t, { spawn: () => { throw new Error("spawn fixture failed"); } });
  f.schedule.runNow();
  await settle();
  assert.equal(f.schedule.status()[0]?.lastError, "spawn fixture failed");
  assert.equal(f.schedule.status()[0]?.running, false);
});

async function api(t: TestContext, access?: HubOptions["access"]) {
  const f = fixture(t);
  f.hold();
  f.writeMachines([{ id: "one" }, { id: "paused", paused: true }]);
  const server = createHub({ db: f.db, webRoot: f.folder, scans: f.schedule, health: false, ...(access ? { access } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "GET", body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return { ...f, call };
}

test("scan API lists status, accepts manual scans, refuses overlap and rejects unknown or paused machines", async (t) => {
  const f = await api(t);
  const before = await f.call("/api/scans");
  assert.equal(before.status, 200);
  assert.equal(JSON.parse(before.body).intervalSeconds, 21_600);
  assert.deepEqual(JSON.parse(before.body).machines.map((row: { machineId: string }) => row.machineId), ["one"]);
  const headers = { "content-type": "application/json" };
  for (const machineId of ["missing", "paused"]) assert.equal((await f.call("/api/scans/run", "POST", JSON.stringify({ machineId }), headers)).status, 400);
  const started = await f.call("/api/scans/run", "POST", '{"machineId":"one"}', headers);
  assert.equal(started.status, 202);
  assert.equal(JSON.parse(started.body)[0].running, true);
  const busy = await f.call("/api/scans/run", "POST", "{}", headers);
  assert.equal(busy.status, 409);
  assert.match(JSON.parse(busy.body).error, /already running/);
  f.finish();
  await settle();
  assert.equal((await f.call("/api/scans/run", "POST", undefined, headers)).status, 202);
});

test("scan API enforces host, origin, JSON content type and body validation", async (t) => {
  const f = await api(t);
  const headers = { "content-type": "application/json" };
  assert.equal((await f.call("/api/scans", "GET", undefined, { host: "evil.test" })).status, 421);
  assert.equal((await f.call("/api/scans/run", "POST", "{}", { ...headers, origin: "https://evil.test" })).status, 403);
  assert.equal((await f.call("/api/scans/run", "POST", "{}", { "content-type": "text/plain" })).status, 415);
  for (const body of ["null", "[]", "{bad", '{"machineId":1}']) assert.equal((await f.call("/api/scans/run", "POST", body, headers)).status, 400);
  assert.equal((await f.call("/api/scans/run", "POST", " ".repeat(4097), headers)).status, 413);
  assert.equal(f.calls.length, 0);
});

test("both scan routes require Access credentials and manual scans require the public origin", async (t) => {
  const config = { host: "scout.example.test", teamDomain: "team.example.test", aud: "scan-test", allowedEmails: ["test@example.test"] };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key: Jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Jwk), kid: "scan-key", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: `https://${config.teamDomain}`, aud: config.aud, email: "test@example.test", exp: now + 3600, nbf: now - 10 })).toString("base64url");
  const token = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
  const f = await api(t, { config, keys: async () => [key] });
  const headers = { host: config.host, "content-type": "application/json", "cf-access-jwt-assertion": token };
  for (const path of ["/api/scans", "/api/scans/run"]) assert.equal((await f.call(path, path.endsWith("run") ? "POST" : "GET", path.endsWith("run") ? "{}" : undefined, { host: config.host })).status, 403);
  assert.equal((await f.call("/api/scans", "GET", undefined, headers)).status, 200);
  assert.equal((await f.call("/api/scans/run", "POST", "{}", { ...headers, origin: "http://127.0.0.1" })).status, 403);
  assert.equal((await f.call("/api/scans/run", "POST", "{}", { ...headers, origin: `https://${config.host}` })).status, 202);
});
