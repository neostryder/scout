import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "@scout/core";
import {
  CLOUDFLARE_INTERVAL_MS,
  CLOUDFLARE_MAX_BACKOFF_MS,
  CLOUDFLARE_START_DELAY_MS,
  CloudflareSchedule,
  type CloudflareClock,
  type CloudflareReadResult,
  type EdgeEvent,
} from "../src/cloudflare.ts";

const AT = "2026-01-01T00:00:00.000Z";

class FakeClock implements CloudflareClock {
  time = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  private serial = 0;
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at);
      const next = due[0];
      if (!next) break;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function fresh(changed: boolean): CloudflareReadResult {
  return { changed, state: "fresh", error: null, lastReadAt: AT };
}

test("the first read waits five seconds and the next waits thirty minutes", async () => {
  const clock = new FakeClock();
  const events: EdgeEvent[] = [];
  let calls = 0;
  const db = openCatalog(":memory:");
  const schedule = new CloudflareSchedule(db, {
    clock,
    read: async () => {
      calls += 1;
      return fresh(calls === 1);
    },
  });
  schedule.subscribe((event) => events.push(event));
  try {
    assert.equal(schedule.hello().state, "never");
    schedule.start();
    clock.advance(CLOUDFLARE_START_DELAY_MS - 1);
    await settle();
    assert.equal(calls, 0);
    clock.advance(1);
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(events[0], { state: "fresh", lastReadAt: AT, error: null, changed: true });
    clock.advance(CLOUDFLARE_INTERVAL_MS - 1);
    await settle();
    assert.equal(calls, 1);
    clock.advance(1);
    await settle();
    assert.equal(calls, 2);
    assert.equal(events[1]?.changed, false);
    schedule.stop();
    clock.advance(CLOUDFLARE_INTERVAL_MS);
    await settle();
    assert.equal(calls, 2);
  } finally {
    schedule.stop();
    db.close();
  }
});

test("repeated failures back off to two hours and a success recovers", async () => {
  const clock = new FakeClock();
  let mode: CloudflareReadResult["state"] = "failed";
  let calls = 0;
  const db = openCatalog(":memory:");
  const schedule = new CloudflareSchedule(db, {
    clock,
    read: async () => {
      calls += 1;
      return { changed: true, state: mode, error: mode === "fresh" ? null : "Cloudflare request failed", lastReadAt: mode === "fresh" ? AT : null };
    },
  });
  try {
    schedule.start();
    clock.advance(CLOUDFLARE_START_DELAY_MS);
    await settle();
    assert.equal(calls, 1);
    clock.advance(CLOUDFLARE_INTERVAL_MS * 2);
    await settle();
    assert.equal(calls, 2);
    clock.advance(CLOUDFLARE_MAX_BACKOFF_MS);
    await settle();
    assert.equal(calls, 3);
    clock.advance(CLOUDFLARE_MAX_BACKOFF_MS - 1);
    await settle();
    assert.equal(calls, 3);
    mode = "fresh";
    clock.advance(1);
    await settle();
    assert.equal(calls, 4);
    clock.advance(CLOUDFLARE_INTERVAL_MS);
    await settle();
    assert.equal(calls, 5);
  } finally {
    schedule.stop();
    db.close();
  }
});

test("refresh runs one read at a time", async () => {
  const clock = new FakeClock();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  const db = openCatalog(":memory:");
  const schedule = new CloudflareSchedule(db, {
    clock,
    read: async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return fresh(false);
    },
  });
  try {
    assert.deepEqual(schedule.refresh(), { started: true });
    await opened;
    assert.equal(schedule.status().running, true);
    assert.deepEqual(schedule.refresh(), { started: false, reason: "running" });
    release();
    await settle();
    assert.equal(schedule.status().running, false);
  } finally {
    release();
    schedule.stop();
    db.close();
  }
});

test("a thrown read scrubs a bearer token from the edge event", async () => {
  const clock = new FakeClock();
  const token = "super-secret-token";
  const events: EdgeEvent[] = [];
  const db = openCatalog(":memory:");
  const schedule = new CloudflareSchedule(db, {
    clock,
    read: async () => { throw new Error(`Authorization Bearer ${token}`); },
  });
  schedule.subscribe((event) => events.push(event));
  schedule.subscribe(() => { throw new Error("listener failed"); });
  try {
    schedule.refresh();
    await settle();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { state: "failed", lastReadAt: null, error: "cloudflare read failed", changed: false });
    assert.equal(JSON.stringify(events[0]).includes(token), false);
  } finally {
    schedule.stop();
    db.close();
  }
});

test("a bearer string in a failed result is replaced", async () => {
  const clock = new FakeClock();
  const token = "super-secret-token";
  const events: EdgeEvent[] = [];
  const db = openCatalog(":memory:");
  const schedule = new CloudflareSchedule(db, {
    clock,
    read: async () => ({ changed: true, state: "stale", error: `Bearer ${token}`, lastReadAt: AT }),
  });
  schedule.subscribe((event) => events.push(event));
  try {
    schedule.refresh();
    await settle();
    assert.equal(events[0]?.state, "failed");
    assert.equal(events[0]?.error, "cloudflare read failed");
    assert.equal(events[0]?.changed, true);
    assert.equal(events[0]?.lastReadAt, AT);
    assert.equal(JSON.stringify(events).includes(token), false);
  } finally {
    schedule.stop();
    db.close();
  }
});
