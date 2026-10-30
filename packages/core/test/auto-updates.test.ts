import { test } from "node:test";
import assert from "node:assert/strict";
import { autoUpdateAllows, listAutoUpdates, openCatalog, recordScan, setAutoUpdate, upsertMachine } from "../src/index.ts";

const T = "2026-10-20T00:00:00.000Z";

function seed() {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.0", location: "" },
    { ecosystem: "brew", key: "jq", name: "jq", kind: "package", version: "1.0", location: "" },
  ] }, T);
  const id = (key: string) => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ?").get(key) as { id: number }).id;
  return { db, git: id("git"), jq: id("jq") };
}

test("nothing is opted in until a person opts a program in", () => {
  const { db, git } = seed();
  assert.deepEqual(listAutoUpdates(db), []);
  assert.equal(autoUpdateAllows(db, git, "patch"), false);
});

test("an opt-in allows steps up to its limit and nothing bigger", () => {
  const { db, git, jq } = seed();
  const saved = setAutoUpdate(db, git, "minor", new Date(T));
  assert.deepEqual(saved && { machineId: saved.machineId, name: saved.name, maxBump: saved.maxBump, createdAt: saved.createdAt }, { machineId: "mini", name: "git", maxBump: "minor", createdAt: T });
  assert.equal(autoUpdateAllows(db, git, "patch"), true);
  assert.equal(autoUpdateAllows(db, git, "minor"), true);
  assert.equal(autoUpdateAllows(db, git, "major"), false);
  assert.equal(autoUpdateAllows(db, git, "other"), false);
  assert.equal(autoUpdateAllows(db, git, null), false);
  assert.equal(autoUpdateAllows(db, jq, "patch"), false);
});

test("a major limit also allows a step the catalog cannot classify", () => {
  const { db, git } = seed();
  setAutoUpdate(db, git, "major");
  assert.equal(autoUpdateAllows(db, git, "other"), true);
  assert.equal(autoUpdateAllows(db, git, null), true);
});

test("changing the limit keeps one row, and null removes it", () => {
  const { db, git } = seed();
  setAutoUpdate(db, git, "patch");
  setAutoUpdate(db, git, "major");
  assert.deepEqual(listAutoUpdates(db).map((entry) => entry.maxBump), ["major"]);
  assert.equal(setAutoUpdate(db, git, null), null);
  assert.deepEqual(listAutoUpdates(db), []);
});

test("an unknown install and a bad limit are refused", () => {
  const { db, git } = seed();
  assert.throws(() => setAutoUpdate(db, 9999, "minor"), /no such install/);
  assert.throws(() => setAutoUpdate(db, git, "huge" as never), /maxBump must be/);
});

test("the opt-in follows the package when a rescan changes the version", () => {
  const { db, git } = seed();
  setAutoUpdate(db, git, "minor");
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [{ ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.1", location: "" }] }, "2026-10-21T00:00:00.000Z");
  const id = (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = 'git' AND i.removed_at IS NULL").get() as { id: number }).id;
  assert.equal(autoUpdateAllows(db, id, "patch"), true);
});
