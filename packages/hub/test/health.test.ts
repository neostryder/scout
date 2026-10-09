import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { healthTarget, openCatalog, recordCloudflare, recordListeners, recordServices, storeHealthSample, syncHealthTargets, upsertMachine, type HealthNotice } from "@scout/core";
import { HealthSchedule, healthOptionsFromArgs, type HealthScheduleOptions } from "../src/health.ts";
import { createHub, type HubOptions } from "../src/server.ts";
import type { LiveClock } from "../src/live.ts";

const AT = "2026-10-07T00:00:00.000Z";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
class FakeClock implements LiveClock {
  time = Date.parse(AT);
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

function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 8080, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 42, processName: "node", processPath: "C:/Tools/node.exe", container: null }] }, AT);
  recordServices(db, "hub", { origin: "services", status: "ok", facts: [{ kind: "windows-service", name: "worker", displayName: null, domain: "system", program: "C:/Tools/node.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null }] }, AT);
  recordCloudflare(db, { zones: [{ id: "z", name: "example.test" }], dns: [{ zone: "example.test", name: "scout.example.test", type: "A", content: "192.0.2.1", proxied: true }] }, AT, null);
  return db;
}

test("health flags preserve the default, minimum, disabled and unscheduled configurations", () => {
  assert.deepEqual(healthOptionsFromArgs([]), { intervalSeconds: 300, scheduled: true });
  assert.deepEqual(healthOptionsFromArgs(["--health-interval", "30", "--no-schedule"]), { intervalSeconds: 30, scheduled: false });
  assert.equal(healthOptionsFromArgs(["--no-health"]), false);
  for (const args of [["--health-interval"], ["--health-interval", "--no-health"], ["--health-interval", "29"], ["--health-interval", "30.5"]]) assert.throws(() => healthOptionsFromArgs(args), /at least 30/);
});

test("the scheduler follows watchers, returns to its configured cadence and stops its timers", async (t) => {
  const db = seed(t);
  const clock = new FakeClock();
  const calls: number[] = [];
  const schedule = new HealthSchedule(db, { clock, cycle: async () => { calls.push(clock.now()); } });
  t.after(() => schedule.stop());
  assert.equal(schedule.status().nextRunAt, null);
  schedule.start();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(schedule.status().intervalSeconds, 300);
  const unwatch = schedule.watch();
  const unwatchSecond = schedule.watch();
  assert.equal(schedule.status().intervalSeconds, 60);
  await clock.advance(60_000);
  assert.equal(calls.length, 2);
  unwatch();
  unwatch();
  assert.equal(schedule.status().intervalSeconds, 60);
  unwatchSecond();
  assert.equal(schedule.status().intervalSeconds, 300);
  await clock.advance(299_999);
  assert.equal(calls.length, 2);
  await clock.advance(1);
  assert.equal(calls.length, 3);
  assert.equal(schedule.status().lastRunAt, new Date(clock.now()).toISOString());
  schedule.stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(schedule.status().nextRunAt, null);
  await clock.advance(300_000);
  assert.equal(calls.length, 3);
  assert.equal(schedule.refresh(), true);
  await settle();
  assert.equal(calls.length, 4);
  assert.equal(clock.timers.size, 0);
});

test("the scheduler locks a running cycle, publishes progress and retries a failed cycle", async (t) => {
  const db = seed(t);
  const clock = new FakeClock();
  const notices: HealthNotice[] = [];
  const logs: string[] = [];
  let finish!: () => void;
  let calls = 0;
  const schedule = new HealthSchedule(db, { clock, log: (line) => logs.push(line), cycle: async (_db, options) => {
    calls++;
    options?.publish?.({ kind: "health-run", data: { running: true, done: 0, total: 1 } });
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
    else throw new Error("fixture cycle");
  } });
  t.after(() => schedule.stop());
  const unsubscribe = schedule.subscribe((notice) => notices.push(notice));
  schedule.start();
  assert.equal(schedule.status().running, true);
  assert.equal(schedule.refresh(), false);
  await clock.advance(400_000);
  assert.equal(calls, 1);
  assert.equal(notices.length, 1);
  unsubscribe();
  finish();
  await settle();
  await clock.advance(0);
  assert.equal(calls, 2);
  assert.equal(schedule.status().running, false);
  assert.equal(logs.length, 1);
  assert.equal(notices.length, 1);
  await clock.advance(300_000);
  assert.equal(calls, 3);
});

test("a restarted scheduler clears stored failure streaks", (t) => {
  const db = seed(t);
  syncHealthTargets(db, AT);
  storeHealthSample(db, "listener:hub:8080", { at: AT, ok: true, status: 200, latencyMs: 1, error: null, tlsNotAfter: null });
  for (let i = 0; i < 3; i++) storeHealthSample(db, "listener:hub:8080", { at: AT, ok: false, status: 503, latencyMs: 1, error: "HTTP 503", tlsNotAfter: null });
  const schedule = new HealthSchedule(db);
  assert.equal(schedule.status().running, false);
  assert.equal(healthTarget(db, "listener:hub:8080", AT)!.failures, 0);
  assert.equal(healthTarget(db, "listener:hub:8080", AT)!.state, "unknown");
  assert.throws(() => new HealthSchedule(db, { intervalSeconds: 29 }), /at least 30/);
});

interface Reply { status: number; body: any }
async function app(t: TestContext, health: HealthScheduleOptions | false, extra: Partial<HubOptions> = {}) {
  const db = extra.db ?? seed(t);
  const server = createHub({ db, webRoot: ".", control: false, alerts: { alertsPath: "fixtures/alerts/missing.json" }, health, ...extra });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<Reply> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { db, port, call };
}

test("health endpoints return the contract shape, filter rows and reject overlapping refreshes", async (t) => {
  let finish!: () => void;
  let calls = 0;
  const { call } = await app(t, { scheduled: false, cycle: async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); } });
  const listed = await call("/api/services/health");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.targets.length, 2);
  assert.deepEqual(listed.body.counts, { up: 0, slow: 0, failing: 0, down: 0, "not-http": 0, unknown: 2 });
  assert.deepEqual(listed.body.probe, { running: false, lastRunAt: null, nextRunAt: null, intervalSeconds: 300 });
  assert.equal((await call("/api/services/health?kind=listener&state=unknown")).body.targets.length, 1);
  assert.equal((await call("/api/services/health?state=wrong")).status, 400);
  assert.equal((await call("/api/services/health?kind=wrong")).status, 400);
  assert.equal((await call("/api/services/health/refresh", { url: "http://example.test/" })).status, 400);
  const started = await call("/api/services/health/refresh", {});
  assert.deepEqual(started, { status: 202, body: { state: "running" } });
  assert.equal((await call("/api/services/health")).body.probe.running, true);
  assert.deepEqual(await call("/api/services/health/refresh", {}), { status: 409, body: { error: "a probe is already running" } });
  assert.equal(calls, 1);
  finish();
  await settle();
  assert.equal((await call("/api/services/health")).body.probe.running, false);
});

test("health refresh keeps the hub JSON, same-origin and method checks and disabled status", async (t) => {
  const { call } = await app(t, { cycle: async () => {} });
  assert.equal((await call("/api/services/health/refresh")).status, 405);
  assert.equal((await call("/api/services/health", {})).status, 405);
  assert.equal((await call("/api/services/health/refresh", {}, { origin: "https://example.test" })).status, 403);
  assert.equal((await call("/api/services/health/refresh", {}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("/api/services/health/refresh", "bad")).status, 400);
  const off = await app(t, healthOptionsFromArgs(["--no-health"]));
  assert.equal((await off.call("/api/services/health/refresh", {})).status, 404);
  const offList = await off.call("/api/services/health");
  assert.equal(offList.status, 200);
  assert.equal(offList.body.probe.intervalSeconds, 0);
});

test("listener, route and joined service port rows expose their health fields", async (t) => {
  const { db, call } = await app(t, { cycle: async () => {} });
  syncHealthTargets(db, AT);
  storeHealthSample(db, "listener:hub:8080", { at: AT, ok: true, status: 200, latencyMs: 12, error: null, tlsNotAfter: null });
  const expected = { key: "listener:hub:8080", state: "up", latencyMs: 12, lastOkAt: AT, failures: 0, tlsDaysLeft: null };
  assert.deepEqual((await call("/api/listeners")).body.rows[0].health, expected);
  assert.deepEqual((await call("/api/services")).body.rows[0].ports[0].health, expected);
  assert.equal((await call("/api/services/routes")).body.rows[0].health.key, "domain:scout.example.test");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordListeners(db, "mini", { origin: "listeners", status: "ok", facts: [{ port: 8080, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 42, processName: "node", processPath: "/opt/node", container: null }] }, AT);
  assert.equal((await call("/api/listeners?machine=mini")).body.rows[0].health, null);
});

test("the services stream sends hello.health, probe progress, target changes and alert events", async (t) => {
  const clock = new FakeClock();
  let status = 503;
  const { call, port } = await app(t, { clock, probe: { fetch: async () => ({ status }), tls: async () => ({ trusted: true, notAfter: "2026-10-16T00:00:00.000Z" }) } });
  const events: { kind: string; data: any }[] = [];
  let req!: ReturnType<typeof request>;
  let disconnect!: () => void;
  await new Promise<void>((resolve, reject) => {
    req = request({ hostname: "127.0.0.1", port, path: "/api/services/live" }, (res) => {
      disconnect = () => res.destroy();
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => {
        raw += part;
        let end: number;
        while ((end = raw.indexOf("\n\n")) >= 0) {
          const frame = raw.slice(0, end);
          raw = raw.slice(end + 2);
          const match = /^event: (.+)\ndata: (.+)$/.exec(frame);
          if (match) { events.push({ kind: match[1]!, data: JSON.parse(match[2]!) }); if (match[1] === "hello") resolve(); }
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
  t.after(() => { disconnect(); req.destroy(); });
  assert.deepEqual(events[0]!.data.health, { down: 0, failing: 0, expiring: 0 });
  assert.equal((await call("/api/services/health")).body.probe.intervalSeconds, 60);
  for (let i = 0; i < 3; i++) {
    assert.equal((await call("/api/services/health/refresh", {})).status, 202);
    await settle();
  }
  for (let i = 0; i < 50 && !events.some((event) => event.kind === "alert" && event.data.alert.kind === "unhealthy"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(events.some((event) => event.kind === "health" && event.data.target.state === "down" && event.data.change === "state"));
  assert.ok(events.some((event) => event.kind === "health-run" && event.data.running === false && event.data.done === 2 && event.data.total === 2));
  assert.ok(events.some((event) => event.kind === "alert" && event.data.alert.key === "unhealthy:domain:scout.example.test"));
  assert.ok(events.filter((event) => event.kind === "health").every((event) => !("history" in event.data.target)));
  status = 200;
  await call("/api/services/health/refresh", {});
  await settle();
  disconnect();
  for (let i = 0; i < 50 && (await call("/api/services/health")).body.probe.intervalSeconds !== 300; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await call("/api/services/health")).body.probe.intervalSeconds, 300);
});

test("an unscheduled hub permits manual cycles and a scheduled hub uses fake probes on start", async (t) => {
  const clock = new FakeClock();
  let calls = 0;
  const { call } = await app(t, { ...healthOptionsFromArgs(["--no-schedule"]) as HealthScheduleOptions, clock, cycle: async () => { calls++; } });
  await clock.advance(600_000);
  assert.equal(calls, 0);
  assert.equal((await call("/api/services/health/refresh", {})).status, 202);
  await settle();
  assert.equal(calls, 1);
  await clock.advance(600_000);
  assert.equal(calls, 1);
  const scheduled = await app(t, { scheduled: true, clock: new FakeClock(), cycle: async () => {} });
  await settle();
  assert.notEqual((await scheduled.call("/api/services/health")).body.probe.nextRunAt, null);
});
