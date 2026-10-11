import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meterAlertsFileReader, openCatalog, recordMeterReading, upsertMachine } from "@scout/core";
import { HubMeterAlerts } from "../src/meter-alerts.ts";
import { METER_ACTIVE_SECONDS, METER_ACTIVE_WINDOW_MS, METER_IDLE_SECONDS, MeterSchedule } from "../src/meters.ts";
import { createHub } from "../src/server.ts";
import type { LiveClock } from "../src/live.ts";

const AT = "2026-10-11T00:00:00.000Z";
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

test("the schedule samples every 60 s, every 10 s while a view is open, and returns to idle after the view goes quiet", async (t: TestContext) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock();
  const calls: number[] = [];
  const schedule = new MeterSchedule(db, { machines: () => [], clock, cycle: async () => { calls.push(clock.now() - Date.parse(AT)); return []; } });
  t.after(() => schedule.stop());
  schedule.start();
  await settle();
  assert.deepEqual(calls, [0]);
  assert.equal(schedule.intervalSeconds(), METER_IDLE_SECONDS);
  await clock.advance(59_000);
  assert.equal(calls.length, 1);
  await clock.advance(1_000);
  assert.deepEqual(calls, [0, 60_000]);
  schedule.touch();
  assert.equal(schedule.intervalSeconds(), METER_ACTIVE_SECONDS);
  await clock.advance(METER_ACTIVE_SECONDS * 1000);
  assert.equal(calls.length, 3);
  await clock.advance(METER_ACTIVE_SECONDS * 1000);
  assert.equal(calls.length, 4);
  schedule.touch();
  await clock.advance(METER_ACTIVE_WINDOW_MS);
  assert.equal(schedule.intervalSeconds(), METER_IDLE_SECONDS);
  const before = calls.length;
  await clock.advance(30_000);
  assert.ok(calls.length - before <= 1, "idle cadence is slower than one read per 30 s");
  schedule.stop();
  const stopped = calls.length;
  await clock.advance(600_000);
  assert.equal(calls.length, stopped);
});

test("a failing cycle is logged and the next one still runs", async (t: TestContext) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock();
  const logs: string[] = [];
  let calls = 0;
  const schedule = new MeterSchedule(db, { machines: () => [], clock, log: (line) => logs.push(line), cycle: async () => { calls++; throw new Error("boom"); } });
  t.after(() => schedule.stop());
  schedule.start();
  await settle();
  await clock.advance(60_000);
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);
});

test("/api/resources returns the newest sample per machine and pulls the schedule forward", async (t: TestContext) => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
  recordMeterReading(db, "hub", { cpuPct: 20, memUsedBytes: 50, memTotalBytes: 100, disks: [], gpus: [], netRxBytes: null, netTxBytes: null, processes: [] }, new Date().toISOString());
  let touched = 0;
  const meters = new MeterSchedule(db, { machines: () => [], cycle: async () => [] });
  const touch = meters.touch.bind(meters);
  meters.touch = () => { touched++; touch(); };
  const server = createHub({ db, webRoot: ".", meters });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); db.close(); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/resources`);
  assert.equal(response.status, 200);
  const body = await response.json() as { machines: { name: string; cpuPct: number; mem: { pct: number } }[]; intervalSeconds: number };
  assert.deepEqual(body.machines.map((m) => [m.name, m.cpuPct, m.mem.pct]), [["Eru", 20, 50]]);
  assert.equal(body.intervalSeconds, METER_ACTIVE_SECONDS);
  assert.equal(touched, 1);
});

test("the schedule runs the after-cycle hook each cycle, and a failing hook does not stop the next cycle", async (t: TestContext) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock();
  const logs: string[] = [];
  let hooks = 0;
  const schedule = new MeterSchedule(db, { machines: () => [], clock, log: (line) => logs.push(line), cycle: async () => [], afterCycle: async () => { hooks++; throw new Error("boom"); } });
  t.after(() => schedule.stop());
  schedule.start();
  await settle();
  await clock.advance(60_000);
  assert.equal(hooks, 2);
  assert.deepEqual(logs, ["Meter alerts failed; the next cycle will retry.", "Meter alerts failed; the next cycle will retry."]);
});

test("/api/resources/alerts reads and saves the rules, refuses a bad edit, and check() sends one notice per raised alert", async (t: TestContext) => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
  const dir = mkdtempSync(join(tmpdir(), "scout-hub-meter-alerts-"));
  const path = join(dir, "meter-alerts.json");
  const sent: { title: string }[] = [];
  const now = Date.now();
  const alerts = new HubMeterAlerts(db, { settings: meterAlertsFileReader(path), path, notifier: { send: async (notice) => { sent.push(notice); return []; }, channels: () => ({ discord: false, desktop: true }) }, now: () => now });
  const server = createHub({ db, webRoot: ".", meterAlerts: alerts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/resources/alerts`;
  const post = (body: unknown) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const first = await (await fetch(base)).json() as { settings: { memory: { pct: number } }; channels: { desktop: boolean }; active: unknown[] };
  assert.equal(first.settings.memory.pct, 92);
  assert.equal(first.channels.desktop, true);
  assert.deepEqual(first.active, []);

  const saved = await post({ memory: { pct: 80, minutes: 0 } });
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as { settings: { memory: { pct: number } } }).settings.memory.pct, 80);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).memory.pct, 80);
  assert.equal((await post({ memory: { pct: 10 } })).status, 400);
  assert.equal((await fetch(base, { method: "POST", body: "{}" })).status, 415);

  recordMeterReading(db, "hub", { cpuPct: 5, memUsedBytes: 90, memTotalBytes: 100, disks: [], gpus: [], netRxBytes: null, netTxBytes: null, processes: [] }, new Date(now).toISOString());
  assert.deepEqual((await alerts.check()).map((n) => n.title), ["Eru: memory is at 90%"]);
  assert.deepEqual(sent.map((n) => n.title), ["Eru: memory is at 90%"]);
  assert.deepEqual(await alerts.check(), []);
  assert.equal(alerts.status().active.length, 1);
});
