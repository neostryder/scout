import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openCatalog } from "@scout/core";
import { createLoopLag } from "../src/loop-lag.ts";
import { createHub } from "../src/server.ts";

function setup(options: { thresholdMs?: number; intervalMs?: number } = {}) {
  let now = 0;
  let callback = () => {};
  let starts = 0;
  let unrefs = 0;
  const logs: string[] = [];
  const cleared: ReturnType<typeof setInterval>[] = [];
  const timer = { unref: () => { unrefs++; } } as unknown as ReturnType<typeof setInterval>;
  const lag = createLoopLag({
    ...options,
    now: () => now,
    log: (line) => logs.push(line),
    setTimer: (tick, intervalMs) => {
      assert.equal(intervalMs, options.intervalMs ?? 250);
      starts++;
      callback = tick;
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer),
  });
  lag.start();
  return { lag, logs, cleared, timer, starts: () => starts, unrefs: () => unrefs, at: (time: number) => { now = time; }, tick: (time: number) => { now = time; callback(); } };
}

test("ticks at or below the threshold do not log", () => {
  const f = setup();
  f.tick(250);
  f.tick(1500);
  assert.deepEqual(f.logs, []);
  f.tick(2751);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 1001 ms"]);
});

test("a late tick logs at most five running activities, oldest first, with durations", () => {
  const f = setup();
  for (let i = 0; i < 7; i++) {
    f.at(i * 10);
    f.lag.begin(`GET /api/${i}`);
  }
  f.tick(1500);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 1250 ms; running now: GET /api/0 (1500 ms), GET /api/1 (1490 ms), GET /api/2 (1480 ms), GET /api/3 (1470 ms), GET /api/4 (1460 ms)"]);
});

test("custom intervals and thresholds determine the stall duration", () => {
  const f = setup({ intervalMs: 100, thresholdMs: 500 });
  f.tick(600);
  assert.deepEqual(f.logs, []);
  f.tick(1201);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 501 ms"]);
});

test("stall logs are limited to one per ten seconds", () => {
  const f = setup();
  f.tick(1500);
  f.tick(3000);
  assert.equal(f.logs.length, 1);
  f.tick(11_500);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 1250 ms", "[lag] event loop was blocked about 8250 ms"]);
});

test("a stall includes activities that began and ended within its tick window", () => {
  const f = setup();
  const old = f.lag.begin("old");
  old();
  const spanning = f.lag.begin("spanning");
  f.tick(250);
  f.at(300);
  spanning();
  const end = f.lag.begin("GET /api/updates");
  f.at(1400);
  end();
  end();
  f.tick(1501);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 1001 ms; finished during the stall: GET /api/updates (1100 ms)"]);
});

test("the finished activity ring retains only the last fifty and logs at most five", () => {
  const f = setup();
  for (let i = 0; i < 60; i++) {
    f.at(i * 10);
    const end = f.lag.begin(`job ${i}`);
    f.at(i * 10 + 5);
    end();
  }
  f.tick(2000);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 1750 ms; finished during the stall: job 10 (5 ms), job 11 (5 ms), job 12 (5 ms), job 13 (5 ms), job 14 (5 ms)"]);
});

test("activities with the same label end independently and labels stay on one ASCII line", () => {
  const f = setup();
  const end = f.lag.begin("same\n\u00e9");
  f.at(100);
  f.lag.begin("same\n\u00e9");
  f.at(500);
  end();
  f.tick(1500);
  assert.deepEqual(f.logs, ["[lag] event loop was blocked about 1250 ms; running now: same?? (1400 ms); finished during the stall: same?? (500 ms)"]);
});

test("start and stop are idempotent, unref the timer, and reset the tick baseline on restart", () => {
  const f = setup();
  f.lag.start();
  assert.equal(f.starts(), 1);
  assert.equal(f.unrefs(), 1);
  f.lag.stop();
  f.lag.stop();
  assert.deepEqual(f.cleared, [f.timer]);
  f.at(30_000);
  f.lag.start();
  f.tick(30_250);
  assert.equal(f.starts(), 2);
  assert.equal(f.unrefs(), 2);
  assert.deepEqual(f.logs, []);
  f.lag.stop();
  assert.deepEqual(f.cleared, [f.timer, f.timer]);
});

test("server labels omit query strings and failed requests end on response finish", async (t) => {
  let now = 0;
  let tick = () => {};
  let reads = 0;
  let unrefs = 0;
  const logs: string[] = [];
  const cleared: ReturnType<typeof setInterval>[] = [];
  const timer = { unref: () => { unrefs++; } } as unknown as ReturnType<typeof setInterval>;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", ((callback: () => void, intervalMs: number) => {
    assert.equal(intervalMs, 250);
    tick = callback;
    return timer;
  }) as typeof setInterval);
  t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => cleared.push(timer));
  const db = openCatalog(":memory:");
  const server = createHub({
    db, webRoot: ".", control: false, health: false, lagLog: (line) => logs.push(line),
    claude: { read: async () => {
      reads++;
      now = reads === 1 ? 1500 : 12_100;
      if (reads === 1) tick();
      throw new Error("process table unavailable");
    } },
  });
  const close = (): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  t.after(async () => { if (server.listening) await close(); db.close(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  assert.equal(unrefs, 1);
  const get = (): Promise<number> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/api/claude?q=private-query" }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
  assert.equal(await get(), 503);
  assert.deepEqual(logs, ["[lag] event loop was blocked about 1250 ms; running now: GET /api/claude (1500 ms)"]);
  now = 12_000;
  tick();
  assert.equal(logs[1], "[lag] event loop was blocked about 10250 ms");
  assert.equal(await get(), 503);
  now = 24_000;
  tick();
  assert.equal(logs[2], "[lag] event loop was blocked about 11750 ms; finished during the stall: GET /api/claude (100 ms)");
  assert.equal(logs.join("\n").includes("?"), false);
  assert.equal(logs.join("\n").includes("private-query"), false);
  await close();
  assert.deepEqual(cleared, [timer]);
});
