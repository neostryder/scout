import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeterAlertTracker, defaultMeterAlerts, meterAlertsFileReader, parseMeterAlerts, updateMeterAlertsFile, type MeterSample } from "../src/index.ts";

const GIB = 1_073_741_824;
const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const MIN = 60_000;
const names = new Map([["hub", "Eru"]]);

function sample(at: number, over: { disk?: number; memory?: number; vram?: number } = {}): MeterSample {
  return {
    machineId: "hub", at: new Date(at).toISOString(), cpuPct: 10, netRxBps: null, netTxBps: null, netRxBytes: null, netTxBytes: null, processes: [],
    memUsedBytes: (over.memory ?? 40) / 100 * 64 * GIB, memTotalBytes: 64 * GIB,
    disks: [{ mount: "C:", usedBytes: (over.disk ?? 50) / 100 * 1000 * GIB, totalBytes: 1000 * GIB }],
    gpus: [{ name: "RTX 5080", utilPct: 5, vramUsedBytes: (over.vram ?? 20) / 100 * 16 * GIB, vramTotalBytes: 16 * GIB }],
  };
}

test("an alert waits for the minutes in its rule, then sends one notice and no more while the meter stays high", () => {
  const tracker = new MeterAlertTracker();
  const settings = defaultMeterAlerts();
  assert.deepEqual(tracker.evaluate([sample(T0, { memory: 95 })], names, settings, T0), []);
  assert.deepEqual(tracker.evaluate([sample(T0 + 5 * MIN, { memory: 96 })], names, settings, T0 + 5 * MIN), []);
  const sent = tracker.evaluate([sample(T0 + 10 * MIN, { memory: 96 })], names, settings, T0 + 10 * MIN);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.title, "Eru: memory is at 96%");
  assert.equal(sent[0]!.severity, "high");
  assert.match(sent[0]!.body, /at or over 92% for 10 minutes/);
  assert.deepEqual(tracker.evaluate([sample(T0 + 20 * MIN, { memory: 97 })], names, settings, T0 + 20 * MIN), []);
  assert.deepEqual(tracker.active().map((a) => [a.kind, a.label, a.pct]), [["memory", "memory", 97]]);
});

test("a dip that stays inside the clear margin neither clears the alert nor restarts the count", () => {
  const tracker = new MeterAlertTracker();
  const settings = defaultMeterAlerts();
  tracker.evaluate([sample(T0, { vram: 97 })], names, settings, T0);
  assert.equal(tracker.evaluate([sample(T0 + 10 * MIN, { vram: 97 })], names, settings, T0 + 10 * MIN).length, 1);
  assert.deepEqual(tracker.evaluate([sample(T0 + 11 * MIN, { vram: 92 })], names, settings, T0 + 11 * MIN), []);
  assert.equal(tracker.active().length, 1);
  const cleared = tracker.evaluate([sample(T0 + 12 * MIN, { vram: 60 })], names, settings, T0 + 12 * MIN);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.title, "Eru: video memory is back to normal");
  assert.equal(cleared[0]!.severity, "info");
  assert.deepEqual(tracker.active(), []);
});

test("a reading that falls under the threshold before the minutes pass resets the count", () => {
  const tracker = new MeterAlertTracker();
  const settings = defaultMeterAlerts();
  tracker.evaluate([sample(T0, { memory: 95 })], names, settings, T0);
  tracker.evaluate([sample(T0 + 6 * MIN, { memory: 50 })], names, settings, T0 + 6 * MIN);
  assert.deepEqual(tracker.evaluate([sample(T0 + 12 * MIN, { memory: 95 })], names, settings, T0 + 12 * MIN), []);
  assert.equal(tracker.evaluate([sample(T0 + 22 * MIN, { memory: 95 })], names, settings, T0 + 22 * MIN).length, 1);
});

test("a rule with zero minutes alerts on the first reading, and each disk is its own alert", () => {
  const tracker = new MeterAlertTracker();
  const settings = parseMeterAlerts({ disk: { minutes: 0 } });
  const two: MeterSample = { ...sample(T0, { disk: 95 }), disks: [{ mount: "C:", usedBytes: 950 * GIB, totalBytes: 1000 * GIB }, { mount: "D:", usedBytes: 920 * GIB, totalBytes: 1000 * GIB }, { mount: "E:", usedBytes: 10 * GIB, totalBytes: 1000 * GIB }] };
  const sent = tracker.evaluate([two], names, settings, T0);
  assert.deepEqual(sent.map((n) => n.title), ["Eru: disk C: is at 95%", "Eru: disk D: is at 92%"]);
});

test("turning a rule off sends one closing notice for an alert that is up and nothing after", () => {
  const tracker = new MeterAlertTracker();
  const settings = defaultMeterAlerts();
  tracker.evaluate([sample(T0, { memory: 95 })], names, settings, T0);
  tracker.evaluate([sample(T0 + 10 * MIN, { memory: 95 })], names, settings, T0 + 10 * MIN);
  const off = parseMeterAlerts({ memory: { enabled: false } });
  const closed = tracker.evaluate([sample(T0 + 11 * MIN, { memory: 95 })], names, off, T0 + 11 * MIN);
  assert.equal(closed.length, 1);
  assert.match(closed[0]!.body, /no longer watched/);
  assert.deepEqual(tracker.evaluate([sample(T0 + 30 * MIN, { memory: 99 })], names, off, T0 + 30 * MIN), []);
});

test("a stale reading is ignored, so a machine that cannot be read raises and clears nothing", () => {
  const tracker = new MeterAlertTracker();
  const settings = parseMeterAlerts({ memory: { minutes: 0 } });
  assert.deepEqual(tracker.evaluate([sample(T0, { memory: 99 })], names, settings, T0 + 10 * MIN), []);
  assert.deepEqual(tracker.active(), []);
});

test("settings are checked, partial edits keep the other rules, and the file round trips", () => {
  assert.throws(() => parseMeterAlerts({ disk: { pct: 30 } }), /disk.pct/);
  assert.throws(() => parseMeterAlerts({ disk: { minutes: 1.5 } }), /disk.minutes/);
  assert.throws(() => parseMeterAlerts({ cpu: {} }), /unknown field cpu/);
  assert.throws(() => parseMeterAlerts({ disk: { color: "red" } }), /unknown field disk.color/);
  assert.throws(() => parseMeterAlerts([]), /invalid/);
  const dir = mkdtempSync(join(tmpdir(), "scout-meter-alerts-"));
  try {
    const path = join(dir, "meter-alerts.json");
    const read = meterAlertsFileReader(path);
    assert.deepEqual(read(), defaultMeterAlerts());
    const next = updateMeterAlertsFile(path, read(), { memory: { pct: 88, minutes: 3 } });
    assert.deepEqual([next.memory, next.disk.pct], [{ enabled: true, pct: 88, minutes: 3 }, 90]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).memory, { enabled: true, pct: 88, minutes: 3 });
    assert.equal(meterAlertsFileReader(path)().memory.pct, 88);
    writeFileSync(path, "{ not json", "utf8");
    const damaged = meterAlertsFileReader(path)();
    assert.equal(damaged.memory.pct, 92);
    assert.match(damaged.fileError ?? "", /malformed/);
    assert.throws(() => updateMeterAlertsFile(path, defaultMeterAlerts(), { vram: { pct: 101 } }), /vram.pct/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
