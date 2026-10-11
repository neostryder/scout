import { test } from "node:test";
import assert from "node:assert/strict";

const { bytesText, rateText, pctText, meterTone, toneWord, ageText, isStale, sparkSegments, meterRows, topRows, summaryText, machineTone, pollMs, alertRows, alertEdit, activeAlertText } = await import(new URL("../public/resources-model.js", import.meta.url).href);

const GIB = 1_073_741_824;
const machine = {
  machineId: "hub", name: "Eru", os: "windows", at: "2026-10-11T00:00:00.000Z", ageSeconds: 8, cpuPct: 12,
  mem: { usedBytes: 24 * GIB, totalBytes: 64 * GIB, pct: 37.5 },
  disks: [{ mount: "C:", usedBytes: 600 * GIB, totalBytes: 1000 * GIB, pct: 60 }, { mount: "D:", usedBytes: 900 * GIB, totalBytes: 1000 * GIB, pct: 90 }],
  gpus: [{ name: "RTX 5080", utilPct: 31, vramUsedBytes: 7 * GIB, vramTotalBytes: 16 * GIB, vramPct: 43.8 }],
  net: { rxBps: 2_000_000, txBps: 500_000 },
  top: { cpu: [{ pid: 1, name: "node", cpuPct: 20, memBytes: 1 }, { pid: 2, name: "x", label: "Cogitator", kind: "service", cpuPct: 5, memBytes: 2 }], mem: [{ pid: 2, name: "x", label: "Cogitator", kind: "service", cpuPct: 5, memBytes: 8 * GIB }] },
  series: [{ at: "a", cpuPct: 10, memPct: 30, rxBps: 100, txBps: 100 }, { at: "b", cpuPct: null, memPct: 31, rxBps: null, txBps: null }, { at: "c", cpuPct: 50, memPct: 32, rxBps: 300, txBps: 100 }],
};

test("bytes, rates, and percentages read as short plain numbers", () => {
  assert.deepEqual([0, 512, 1536, 5 * 1024 * 1024, 24 * GIB, 1000 * GIB].map(bytesText), ["0 B", "512 B", "1.5 KB", "5.0 MB", "24.0 GB", "1.0 TB"]);
  assert.equal(bytesText(null), "None");
  assert.equal(rateText(2_000_000), "1.9 MB/s");
  assert.equal(rateText(null), "None");
  assert.deepEqual([12.4, 37.5, null].map(pctText), ["12%", "38%", "None"]);
});

test("a meter turns amber at 70 percent and red at 85, and every tone has a word so color is never the only cue", () => {
  assert.deepEqual([0, 69.9, 70, 84.9, 85, 100, null].map(meterTone), ["ok", "ok", "warn", "warn", "danger", "danger", "quiet"]);
  assert.deepEqual(["ok", "warn", "danger", "quiet"].map(toneWord), ["Normal", "High", "Very high", "No reading"]);
});

test("age text and staleness follow the reading's age", () => {
  assert.deepEqual([2, 8, 120, 3600, 7200].map(ageText), ["Updated just now", "Updated 8 s ago", "Updated 2 min ago", "Updated 60 min ago", "Updated 2 h ago"]);
  assert.equal(ageText(Number.NaN), "No reading yet");
  assert.equal(isStale({ ageSeconds: 100 }), false);
  assert.equal(isStale({ ageSeconds: 151 }), true);
  assert.equal(isStale(undefined), true);
});

test("a sparkline breaks at a missing reading and clamps to the box", () => {
  const segments = sparkSegments([10, null, 150, 50], 90, 22, 100);
  assert.equal(segments.length, 2);
  assert.equal(segments[0], "0.0,19.0");
  assert.equal(segments[1], "60.0,1.0 90.0,11.0");
  assert.deepEqual(sparkSegments([]), []);
  assert.deepEqual(sparkSegments([5]), ["96.0,25.7"]);
});

test("a machine's rows run processor, memory, disks, video memory, graphics, then network, each with a tone and a number", () => {
  const rows = meterRows(machine);
  assert.deepEqual(rows.map((r: any) => r.key), ["cpu", "mem", "disk:C:", "disk:D:", "vram:0", "gpu:0", "net"]);
  assert.deepEqual(rows.map((r: any) => r.tone), ["ok", "ok", "ok", "danger", "ok", "ok", "quiet"]);
  assert.deepEqual(rows.map((r: any) => r.value), ["12%", "38%", "60%", "90%", "44%", "31%", "2.4 MB/s"]);
  assert.equal(rows[1].detail, "24.0 GB of 64.0 GB");
  assert.equal(rows[4].detail, "7.0 GB of 16.0 GB, RTX 5080");
  assert.equal(rows[6].detail, "Down 1.9 MB/s, up 488 KB/s");
  assert.equal(rows[0].top, "cpu");
  assert.equal(rows[1].top, "mem");
  assert.equal(rows[2].top, null);
  assert.deepEqual(rows[0].spark, [10, null, 50]);
});

test("a machine with no memory reading, no disks, and no network yet still gives a processor and network row", () => {
  const rows = meterRows({ ...machine, mem: null, disks: [], gpus: [], net: { rxBps: null, txBps: null }, series: [] });
  assert.deepEqual(rows.map((r: any) => r.key), ["cpu", "net"]);
  assert.equal(rows[1].value, "None");
});

test("top users show the catalog name and kind when the hub has one, else the process name", () => {
  assert.deepEqual(topRows(machine, "cpu"), [{ name: "node", kind: "", value: "20%", pid: 1 }, { name: "Cogitator", kind: "service", value: "5%", pid: 2 }]);
  assert.deepEqual(topRows(machine, "mem"), [{ name: "Cogitator", kind: "service", value: "8.0 GB", pid: 2 }]);
  assert.deepEqual(topRows(machine, null), []);
});

test("the summary and machine tone name the numbers and the worst meter", () => {
  assert.equal(summaryText(machine), "Processor 12%, Memory 38%, Video memory 44%");
  assert.equal(summaryText({ cpuPct: null, mem: null, gpus: [] }), "No reading yet");
  assert.equal(machineTone(machine), "danger");
  assert.equal(machineTone({ ...machine, disks: [] }), "ok");
});

test("polling follows the hub's cadence and never runs faster than every 5 seconds", () => {
  assert.deepEqual([10, 60, 1, undefined].map(pollMs), [10_000, 60_000, 5_000, 10_000]);
});

test("alert rows list the three meters with the saved rule, and an edit sends numbers or null", () => {
  const rows = alertRows({ disk: { enabled: true, pct: 90, minutes: 5 }, memory: { enabled: false, pct: 88, minutes: 3 }, vram: { enabled: true, pct: 95, minutes: 10 } });
  assert.deepEqual(rows.map((r: any) => [r.key, r.label, r.enabled, r.pct, r.minutes]), [["disk", "Disk", true, 90, 5], ["memory", "Memory", false, 88, 3], ["vram", "Video memory", true, 95, 10]]);
  assert.equal(alertRows(undefined).length, 3);
  assert.deepEqual(alertEdit([{ key: "disk", enabled: true, pct: "85", minutes: "0" }, { key: "memory", enabled: false, pct: "abc", minutes: "" }]), { disk: { enabled: true, pct: 85, minutes: 0 }, memory: { enabled: false, pct: null, minutes: null } });
});

test("an alert that is up reads as machine, meter, level, and how long", () => {
  const now = Date.parse("2026-10-11T12:30:00.000Z");
  assert.equal(activeAlertText({ label: "disk D:", pct: 93, since: "2026-10-11T12:18:00.000Z" }, "Eru", now), "Eru: disk D: at 93%, for 12 min");
  assert.equal(activeAlertText({ label: "memory", pct: 95, since: "2026-10-11T12:29:50.000Z" }, "Bilbo", now), "Bilbo: memory at 95%, just now");
});
