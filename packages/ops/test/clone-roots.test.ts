import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCloneRoots, cloneRootsFor, loadAllMachines } from "../src/index.ts";

const defaults = ["~/Repositories", "~/repos", "~/src", "~/code", "~/git", "~/Projects", "~/projects", "~/dev"];

test("clone roots default to home folders plus project roots", () => {
  assert.deepEqual(cloneRootsFor({}), defaults);
  assert.deepEqual(cloneRootsFor({ projectRoots: ["~/src/*", "C:/Projects/*", "~/dev"] }), [...defaults, "C:/Projects"]);
});

test("an explicit cloneRoots list replaces the defaults", () => {
  assert.deepEqual(cloneRootsFor({ cloneRoots: [], projectRoots: ["~/src"] }), []);
  assert.deepEqual(cloneRootsFor({ cloneRoots: ["~/_resources"] }), ["~/_resources"]);
});

test("cloneRoots must be an array of strings", () => {
  assert.doesNotThrow(() => assertCloneRoots({}));
  assert.doesNotThrow(() => assertCloneRoots({ cloneRoots: ["~/src"] }));
  assert.throws(() => assertCloneRoots({ cloneRoots: "~/src" }), /cloneRoots must be an array of strings/);
  assert.throws(() => assertCloneRoots({ cloneRoots: [1] }), /cloneRoots must be an array of strings/);
  const dir = mkdtempSync(join(tmpdir(), "scout-clone-roots-"));
  try {
    const path = join(dir, "machines.json");
    writeFileSync(path, JSON.stringify({ machines: [{ id: "a", transport: { type: "local" }, cloneRoots: [true] }] }));
    assert.throws(() => loadAllMachines(path), /cloneRoots must be an array of strings/);
    writeFileSync(path, JSON.stringify({ machines: [{ id: "a", transport: { type: "local" } }] }));
    assert.equal(loadAllMachines(path)[0]?.cloneRoots, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
