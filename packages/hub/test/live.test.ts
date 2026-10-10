import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, type Transport } from "@scout/core";
import { LiveSchedule, type LiveClock, type LiveMachineConfig, type LiveNotice, type LiveReader } from "../src/live.ts";

const START = Date.parse("2026-10-06T00:00:00.000Z");
const FAST_WINDOWS_MS = 3_000;
const FAST_OTHER_MS = 20_000;
const SLOW_MS = 120_000;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const local: Transport = { type: "local" };
const ok = { changed: false, tables: [] as ("services" | "listeners")[], status: "ok" as const, error: null };

class FakeClock implements LiveClock {
  time = START;
  timers = new Map<number, { at: number; callback: () => void }>();
  private serial = 0;

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

function machine(id: string, name: string, os: LiveMachineConfig["os"]): LiveMachineConfig {
  return { id, name, os, transport: local };
}

function schedule(machines: LiveMachineConfig[], reader: LiveReader, clock: FakeClock): LiveSchedule {
  return new LiveSchedule(openCatalog(":memory:"), { machines, reader, clock });
}

test("fast cadence follows watchers and a mac stays on the slower fast cadence", async () => {
  const clock = new FakeClock();
  const calls: { id: string; slow: boolean; at: number }[] = [];
  const live = schedule([machine("hub", "Hub", "windows")], async (host, options) => {
    calls.push({ id: host.id, slow: options.slow, at: clock.now() });
    return ok;
  }, clock);
  const macClock = new FakeClock();
  const macCalls: number[] = [];
  const mac = schedule([machine("mini", "Mini", "macos")], async () => {
    macCalls.push(macClock.now());
    return ok;
  }, macClock);
  try {
    assert.equal(live.status()[0]?.cadenceMs, SLOW_MS);
    assert.equal(live.status()[0]?.state, "never");
    live.start();
    live.start();
    await settle();
    assert.deepEqual(calls.map((call) => call.slow), [true]);
    assert.equal(live.status()[0]?.state, "fresh");
    assert.equal(live.status()[0]?.error, null);
    await clock.advance(SLOW_MS - 1);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.deepEqual(calls.map((call) => call.slow), [true, false]);
    const unwatch = live.watch();
    assert.equal(live.watcherCount(), 1);
    assert.equal(live.status()[0]?.cadenceMs, FAST_WINDOWS_MS);
    await clock.advance(FAST_WINDOWS_MS - 1);
    assert.equal(calls.length, 2);
    await clock.advance(1);
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.slow, false);
    unwatch();
    unwatch();
    assert.equal(live.watcherCount(), 0);
    assert.equal(live.status()[0]?.cadenceMs, SLOW_MS);
    await clock.advance(FAST_WINDOWS_MS);
    assert.equal(calls.length, 3);
    await clock.advance(SLOW_MS);
    assert.equal(calls.length, 4);
    live.stop();
    assert.equal(clock.timers.size, 0);
    await clock.advance(SLOW_MS);
    assert.equal(calls.length, 4);

    mac.watch();
    mac.start();
    await settle();
    await macClock.advance(FAST_WINDOWS_MS);
    assert.equal(macCalls.length, 1);
    await macClock.advance(FAST_OTHER_MS - FAST_WINDOWS_MS);
    assert.equal(macCalls.length, 2);
  } finally {
    live.stop();
    mac.stop();
  }
});

test("a machine never overlaps itself and a long read starts the next when it ends", async () => {
  const clock = new FakeClock();
  let release: (() => void) | undefined;
  let calls = 0;
  const live = schedule([machine("hub", "Hub", "windows")], async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return ok;
  }, clock);
  try {
    live.watch();
    live.start();
    await settle();
    assert.equal(calls, 1);
    assert.deepEqual(live.refresh("hub"), { started: false, reason: "running" });
    await clock.advance(10_000);
    assert.equal(calls, 1);
    assert.equal(live.status()[0]?.state, "stale");
    release?.();
    await settle();
    assert.equal(calls, 2);
    assert.equal(live.status()[0]?.state, "fresh");
    assert.deepEqual(live.refresh("hub"), { started: false, reason: "running" });
  } finally {
    release?.();
    await settle();
    live.stop();
  }
});

test("failures back off and a later success recovers", async () => {
  const clock = new FakeClock();
  const notices: LiveNotice[] = [];
  let calls = 0;
  const live = schedule([machine("hub", "Hub", "windows")], async () => {
    calls += 1;
    if (calls < 3) return { changed: false, tables: [], status: "failed", error: "ssh timed out" };
    return ok;
  }, clock);
  live.subscribe((notice) => notices.push(notice));
  try {
    live.watch();
    live.start();
    await settle();
    assert.equal(live.status()[0]?.state, "unreachable");
    assert.equal(live.status()[0]?.error, "ssh timed out");
    assert.equal(live.status()[0]?.lastLiveAt, null);
    assert.equal(live.status()[0]?.cadenceMs, FAST_WINDOWS_MS * 2);
    await clock.advance(FAST_WINDOWS_MS * 2 - 1);
    assert.equal(calls, 1);
    await clock.advance(1);
    assert.equal(calls, 2);
    assert.equal(notices.filter((notice) => notice.kind === "machine").length, 1);
    await clock.advance(FAST_WINDOWS_MS * 4);
    assert.equal(calls, 3);
    assert.equal(live.status()[0]?.state, "fresh");
    assert.equal(live.status()[0]?.error, null);
    assert.equal(live.status()[0]?.cadenceMs, FAST_WINDOWS_MS);
    assert.ok(live.status()[0]?.lastLiveAt);
    const machineNotices = notices.filter((notice) => notice.kind === "machine");
    assert.equal(machineNotices.at(-1)?.kind === "machine" && machineNotices.at(-1)?.data.state, "fresh");
  } finally {
    live.stop();
  }
});

test("the slow probe runs at start and on refresh, with progress every 2 seconds", async () => {
  const clock = new FakeClock();
  const slow: boolean[] = [];
  const notices: LiveNotice[] = [];
  let release: (() => void) | undefined;
  let held = true;
  const live = schedule([machine("hub", "Hub", "windows"), machine("laptop", "Laptop", "macos")], async (host, options) => {
    slow.push(options.slow);
    if (host.id !== "hub" || !options.slow) return ok;
    options.onProbe?.({ probe: "win-tasks", label: "Scheduled tasks", phase: "start", message: null });
    if (held) await new Promise<void>((resolve) => { release = resolve; });
    options.onProbe?.({ probe: "win-tasks", label: "Scheduled tasks", phase: "done", message: null });
    return ok;
  }, clock);
  live.subscribe((notice) => notices.push(notice));
  try {
    live.start();
    await settle();
    assert.deepEqual(slow, [true, true]);
    const probes = (): Extract<LiveNotice, { kind: "probe" }>[] => notices.filter((notice): notice is Extract<LiveNotice, { kind: "probe" }> => notice.kind === "probe" && notice.data.machineId === "hub");
    assert.equal(probes().length, 1);
    assert.equal(probes()[0]?.data.phase, "start");
    assert.equal(probes()[0]?.data.elapsedMs, 0);
    await clock.advance(2_000);
    await clock.advance(2_000);
    assert.deepEqual(probes().map((notice) => notice.data.elapsedMs), [0, 2_000, 4_000]);
    release?.();
    await settle();
    const done = probes().at(-1);
    assert.equal(done?.data.phase, "done");
    assert.equal(done?.data.label, "Scheduled tasks");
    assert.equal(notices.filter((notice) => notice.kind === "probe" && notice.data.machineId === "laptop").length, 0);
    held = false;
    await clock.advance(SLOW_MS);
    assert.equal(slow.at(-1), false);
    assert.deepEqual(live.refresh(undefined, true), { started: true, machines: ["hub", "laptop"] });
    await settle();
    assert.equal(slow.at(-1), true);
    const again = live.refresh();
    assert.equal(again.started, true);
    await settle();
    assert.equal(slow.at(-1), false);
    assert.throws(() => live.refresh("missing"), /no such machine/);
  } finally {
    release?.();
    await settle();
    live.stop();
  }
});

test("changed is emitted only when the reader reports a row change", async () => {
  const clock = new FakeClock();
  const notices: LiveNotice[] = [];
  let changed = false;
  const live = schedule([machine("hub", "Hub", "windows")], async () => ({
    changed, tables: changed ? ["listeners"] : [], status: "ok", error: null,
  }), clock);
  live.subscribe(() => { throw new Error("page broke"); });
  live.subscribe((notice) => notices.push(notice));
  try {
    live.start();
    await settle();
    assert.equal(notices.some((notice) => notice.kind === "changed"), false);
    changed = true;
    assert.deepEqual(live.refresh("hub"), { started: true, machines: ["hub"] });
    await settle();
    const event = notices.find((notice) => notice.kind === "changed");
    assert.equal(event?.kind === "changed" && event.data.machineId, "hub");
    assert.deepEqual(event?.kind === "changed" && event.data.tables, ["listeners"]);
    changed = false;
    live.refresh("hub");
    await settle();
    assert.equal(notices.filter((notice) => notice.kind === "changed").length, 1);
  } finally {
    live.stop();
  }
});

test("a thrown reader marks the machine unreachable and leaves the schedule running", async () => {
  const clock = new FakeClock();
  const notices: LiveNotice[] = [];
  let explode = true;
  const live = schedule([machine("hub", "Hub", "windows")], async () => {
    if (explode) throw new Error("boom");
    return { changed: true, tables: ["services"], status: "failed", error: "partial write" };
  }, clock);
  live.subscribe((notice) => notices.push(notice));
  try {
    live.start();
    await settle();
    assert.equal(live.status()[0]?.state, "unreachable");
    assert.equal(live.status()[0]?.error, "boom");
    explode = false;
    live.refresh("hub");
    await settle();
    assert.equal(live.status()[0]?.state, "unreachable");
    assert.equal(live.status()[0]?.error, "partial write");
    assert.equal(notices.some((notice) => notice.kind === "changed"), true);
  } finally {
    live.stop();
  }
});

test("refresh starts the idle machines when another machine is already reading", async () => {
  const clock = new FakeClock();
  let release: (() => void) | undefined;
  const seen: string[] = [];
  const db = openCatalog(":memory:");
  const live = new LiveSchedule(db, {
    machines: [machine("hub", "Hub", "windows"), machine("laptop", "Laptop", "macos")],
    clock,
    reader: async (host) => {
      seen.push(host.id);
      if (host.id === "hub" && seen.filter((id) => id === "hub").length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return ok;
    },
  });
  try {
    live.start();
    await settle();
    const result = live.refresh();
    assert.deepEqual(result, { started: true, machines: ["laptop"] });
    const row = db.prepare("SELECT name, os, kind FROM machines WHERE id = 'hub'").get() as { name: string; os: string; kind: string };
    assert.equal(row.name, "Hub");
    assert.equal(row.os, "windows");
    assert.equal(row.kind, "host");
  } finally {
    release?.();
    await settle();
    live.stop();
    db.close();
  }
});

test("stop lets the current read finish and does not schedule another", async () => {
  const clock = new FakeClock();
  let release: (() => void) | undefined;
  let calls = 0;
  const live = schedule([machine("hub", "Hub", "windows")], async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return ok;
  }, clock);
  try {
    live.start();
    await settle();
    live.stop();
    assert.equal(clock.timers.size, 0);
    release?.();
    await settle();
    await clock.advance(SLOW_MS);
    assert.equal(calls, 1);
  } finally {
    release?.();
    live.stop();
  }
});
