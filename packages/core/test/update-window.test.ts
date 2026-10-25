import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyGroups, dependencyPairs, openCatalog, orderByDependencies, quietWindow, recordDependencies, recordScan, upsertMachine } from "../src/index.ts";

const T = "2026-10-20T00:00:00.000Z";
const DAY = 86_400_000;

const at = (iso: string, offsetMinutes = 0) => quietWindow(new Date(iso), offsetMinutes);

test("the quiet window is 03:30 to 05:30 local time", () => {
  assert.deepEqual(at("2026-10-20T12:00:00.000Z"), { startMinute: 210, lengthMinutes: 120, startsAt: "2026-10-21T03:30:00.000Z", endsAt: "2026-10-21T05:30:00.000Z", inWindow: false });
  assert.deepEqual(at("2026-10-20T03:00:00.000Z"), { startMinute: 210, lengthMinutes: 120, startsAt: "2026-10-20T03:30:00.000Z", endsAt: "2026-10-20T05:30:00.000Z", inWindow: false });
});

test("inside the window the start is the window under way, and the edges are exact", () => {
  assert.equal(at("2026-10-20T03:30:00.000Z").inWindow, true);
  assert.equal(at("2026-10-20T03:30:00.000Z").startsAt, "2026-10-20T03:30:00.000Z");
  assert.equal(at("2026-10-20T04:30:45.000Z").startsAt, "2026-10-20T03:30:00.000Z");
  assert.equal(at("2026-10-20T05:29:59.000Z").inWindow, true);
  assert.deepEqual([at("2026-10-20T05:30:00.000Z").inWindow, at("2026-10-20T05:30:00.000Z").startsAt], [false, "2026-10-21T03:30:00.000Z"]);
});

test("the offset moves the window to the local clock", () => {
  const phoenix = at("2026-10-20T11:00:00.000Z", -420);
  assert.equal(phoenix.inWindow, true);
  assert.equal(phoenix.startsAt, "2026-10-20T10:30:00.000Z");
  assert.equal(at("2026-10-20T20:00:00.000Z", -420).startsAt, "2026-10-21T10:30:00.000Z");
  assert.equal(at("2026-10-20T12:00:00.000Z", 330).startsAt, "2026-10-20T22:00:00.000Z");
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
