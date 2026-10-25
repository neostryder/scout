import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyGroups, dependencyPairs, nextWindowStart, openCatalog, orderByDependencies, quietHour, recordDependencies, recordScan, upsertMachine, type CpuSample } from "../src/index.ts";

const T = "2026-10-20T00:00:00.000Z";
const DAY = 86_400_000;

/** Four samples an hour for `days` days, with `cpuAt(hour)` as the load. Times are UTC and the offset is zero. */
function history(days: number, cpuAt: (hour: number) => number | null): CpuSample[] {
  const start = Date.parse("2026-10-13T00:00:00.000Z");
  const out: CpuSample[] = [];
  for (let step = 0; step < days * 96; step++) {
    const at = new Date(start + step * 900_000);
    out.push({ at: at.toISOString(), cpuPct: cpuAt(at.getUTCHours()) });
  }
  return out;
}

test("the quiet hour is the start of the least busy two hours", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const result = quietHour(history(7, (hour) => (hour === 5 || hour === 6 ? 2 : 30 + hour)), now, 0);
  assert.equal(result.hour, 5);
  assert.equal(result.basis, "measured");
  assert.equal(result.meanCpuPct, 2);
  assert.equal(result.startsAt, "2026-10-21T05:00:00.000Z");
  assert.equal(result.inWindow, false);
});

test("a quiet window that wraps past midnight is found", () => {
  const result = quietHour(history(7, (hour) => (hour === 23 || hour === 0 ? 1 : 40)), new Date("2026-10-20T12:00:00.000Z"), 0);
  assert.equal(result.hour, 23);
});

test("the offset moves the window to the machine's local clock", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  const result = quietHour(history(7, (hour) => (hour === 10 || hour === 11 ? 1 : 40)), now, -420);
  assert.equal(result.hour, 3);
  assert.equal(result.startsAt, "2026-10-21T10:00:00.000Z");
});

test("too little history falls back to the default night hour", () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  for (const samples of [[], history(7, () => null), history(7, () => 5).slice(0, 12)]) {
    const result = quietHour(samples, now, 0);
    assert.equal(result.basis, "default");
    assert.equal(result.hour, 3);
    assert.equal(result.meanCpuPct, null);
  }
});

test("a tie goes to the hour nearest the default", () => {
  const result = quietHour(history(7, () => 10), new Date("2026-10-20T12:00:00.000Z"), 0);
  assert.equal(result.hour, 3);
  assert.equal(result.basis, "measured");
});

test("inside the window the start is now, and outside it the next start", () => {
  const at = (iso: string) => nextWindowStart(3, 2, new Date(iso), 0);
  assert.deepEqual(at("2026-10-20T03:30:00.000Z"), { startsAt: "2026-10-20T03:30:00.000Z", inWindow: true });
  assert.deepEqual(at("2026-10-20T04:59:00.000Z"), { startsAt: "2026-10-20T04:59:00.000Z", inWindow: true });
  assert.deepEqual(at("2026-10-20T05:00:00.000Z"), { startsAt: "2026-10-21T03:00:00.000Z", inWindow: false });
  assert.deepEqual(at("2026-10-20T02:10:30.000Z"), { startsAt: "2026-10-20T03:00:00.000Z", inWindow: false });
  assert.equal(new Date(Date.parse("2026-10-20T00:00:00.000Z") + DAY).toISOString(), "2026-10-21T00:00:00.000Z");
});

test("what an install uses is updated first, ties keep their order", () => {
  assert.deepEqual(orderByDependencies([1, 2, 3, 4], [{ fromId: 1, toId: 3 }, { fromId: 3, toId: 4 }]), [2, 4, 3, 1]);
  assert.deepEqual(orderByDependencies([5, 6, 7], []), [5, 6, 7]);
  assert.deepEqual(orderByDependencies([], [{ fromId: 1, toId: 2 }]), []);
});

test("a cycle falls back to the input order and ignores ids outside the set", () => {
  assert.deepEqual(orderByDependencies([1, 2, 3], [{ fromId: 1, toId: 2 }, { fromId: 2, toId: 1 }]), [3, 1, 2]);
  assert.deepEqual(orderByDependencies([1, 2], [{ fromId: 1, toId: 99 }]), [1, 2]);
});

test("installs joined by a dependency form one group", () => {
  const groups = dependencyGroups([1, 2, 3, 4, 5], [{ fromId: 1, toId: 2 }, { fromId: 2, toId: 3 }]);
  assert.deepEqual(groups.map((group) => [...group].sort()).sort(), [[1, 2, 3], [4], [5]]);
});

test("only live edges between the asked-for installs are returned", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
    { ecosystem: "brew", key: "eza", name: "eza", kind: "package", version: "1.0.0", location: "" },
    { ecosystem: "brew", key: "bat", name: "bat", kind: "package", version: "1.0.0", location: "" },
  ] }, T);
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [
    { from: { ecosystem: "brew", key: "eza" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "keg" },
    { from: { ecosystem: "brew", key: "bat" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "keg" },
  ] }, T);
  const id = (key: string) => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ?").get(key) as { id: number }).id;
  assert.deepEqual(dependencyPairs(db, [id("eza"), id("llhttp")]), [{ fromId: id("eza"), toId: id("llhttp") }]);
  assert.deepEqual(dependencyPairs(db, [id("eza"), id("bat")]), []);
  assert.deepEqual(dependencyPairs(db, []), []);
  db.close();
});
