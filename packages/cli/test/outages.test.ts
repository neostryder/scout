import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, recordObservations, upsertMachine, type Observation } from "@scout/core";
import { outagesCommand } from "../src/outages.ts";

function seed(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "scout-cli-outages-"));
  const db = openCatalog(":memory:");
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  upsertMachine(db, { id: "gm", name: "Gamemaster", os: "macos", kind: "host" });
  const fail = (at: string): Observation => ({ kind: "machine", key: "machine:gm", machineId: "gm", label: "Gamemaster", ok: false, state: "hung", detail: "No SSH greeting.", at });
  recordObservations(db, [fail("2026-10-10T08:00:00.000Z")]);
  recordObservations(db, [fail("2026-10-10T08:02:00.000Z")]);
  const lines: string[] = [];
  const watchPath = join(dir, "watch.json");
  const options = { write: (line: string) => { lines.push(line); }, watchPath, now: () => Date.parse("2026-10-10T08:10:00.000Z") };
  return { db, lines, options, watchPath };
}

test("the outages CLI lists the log with the open count and the watched items", (t) => {
  const { db, lines, options } = seed(t);
  outagesCommand(db, ["--state", "open"], options);
  const listing = JSON.parse(lines[0]!);
  assert.equal(listing.open, 1);
  assert.equal(listing.outages[0].state, "hung");
  assert.equal(listing.outages[0].startedAt, "2026-10-10T08:00:00.000Z");
  assert.equal(listing.items[0].key, "machine:gm");
  assert.throws(() => outagesCommand(db, ["--state", "bogus"], options), /invalid state/);
  assert.throws(() => outagesCommand(db, ["--limit"], options), /--limit requires a value/);
});

test("pause, resume and watch switches are written to the watch file", (t) => {
  const { db, lines, options, watchPath } = seed(t);
  outagesCommand(db, ["pause", "90"], options);
  assert.equal(JSON.parse(lines[0]!).pausedUntil, "2026-10-10T09:40:00.000Z");
  assert.equal(JSON.parse(readFileSync(watchPath, "utf8")).pausedUntil, "2026-10-10T09:40:00.000Z");
  outagesCommand(db, ["resume"], options);
  assert.equal(JSON.parse(lines[1]!).pausedUntil, null);
  outagesCommand(db, ["unwatch", "machine", "gm"], options);
  assert.deepEqual(JSON.parse(lines[2]!).machines, { gm: false });
  outagesCommand(db, ["watch", "machine", "gm"], options);
  assert.deepEqual(JSON.parse(lines[3]!).machines, {}, "switching a machine back on removes its entry, since everything is watched by default");
  outagesCommand(db, ["unwatch", "check", "url"], options);
  assert.equal(JSON.parse(lines[4]!).checks.url, false);
  assert.throws(() => outagesCommand(db, ["pause", "0"], options), /pause requires/);
  assert.throws(() => outagesCommand(db, ["watch", "everything", "x"], options), /outages requires/);
  assert.throws(() => outagesCommand(db, ["bogus"], options), /outages requires/);
});
