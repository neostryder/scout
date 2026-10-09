import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { createDownloadKinds } from "../src/downloads-api.ts";

function seeded(): ReturnType<typeof openCatalog> {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "aa", name: "aa", kind: "package", version: "1.0", location: "" },
    { ecosystem: "brew", key: "bb", name: "bb", kind: "package", version: "1.0", location: "" },
    { ecosystem: "brew", key: "cc", name: "cc", kind: "package", version: "1.0", location: "" },
  ] }, new Date().toISOString());
  const packages = db.prepare("SELECT id, key FROM packages ORDER BY key").all() as { id: number; key: string }[];
  // aa and bb have a newer version only upstream; cc is installable, so it is not a Download row.
  recordResearch(db, packages[0]!.id, "github", "ok", [{ channel: "stable", version: "2.0", installable: false }], null);
  recordResearch(db, packages[1]!.id, "github", "ok", [{ channel: "stable", version: "2.0", installable: false }], null);
  recordResearch(db, packages[2]!.id, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  return db;
}

test("the kinds pass classifies only Download rows, reports pending while it runs, and repeats hourly", async () => {
  const db = seeded();
  const asked: number[] = [];
  let clock = 1_000_000_000;
  const kinds = createDownloadKinds(db, async (installId) => {
    asked.push(installId);
    if (asked.length === 2) throw new Error("lookup failed");
    return { preview: { kind: "file" } } as never;
  }, () => clock);
  const first = kinds.snapshot();
  assert.equal(first.pending, true);
  for (let n = 0; n < 50 && kinds.snapshot().pending; n++) await new Promise((r) => setTimeout(r, 2));
  const done = kinds.snapshot();
  assert.equal(done.pending, false);
  assert.equal(asked.length, 2, "the installable row is not asked about");
  assert.deepEqual(Object.values(done.kinds).sort(), ["file", "none"]);
  assert.equal(asked.length, 2, "a second snapshot inside the hour starts nothing");
  clock += 3_600_001;
  kinds.snapshot();
  for (let n = 0; n < 50 && kinds.snapshot().pending; n++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(asked.length, 4, "after an hour the pass repeats");
  db.close();
});
