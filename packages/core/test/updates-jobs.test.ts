import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, openCatalog, queryUpdates, recordResearch, recordScan, setJobState, upsertMachine } from "../src/index.ts";

const T = "2026-09-30T00:00:00Z";

test("an update row carries the install's unfinished or recently finished job", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "/b", status: "ok", installs: [{ ecosystem: "brew", key: "jq", name: "jq", kind: "package", version: "1.7", location: "/b/jq", details: { tap: "homebrew/core" } }] }, T);
  const pkg = (db.prepare("SELECT id FROM packages WHERE key = 'jq'").get() as { id: number }).id;
  const install = (db.prepare("SELECT id FROM installs WHERE package_id = ?").get(pkg) as { id: number }).id;
  recordResearch(db, pkg, "brew-api", "ok", [{ channel: "stable", version: "1.8", installable: true }], null, T);
  assert.equal(queryUpdates(db).rows[0]?.job, null);
  const { batchId, jobs } = enqueueBatch(db, [{ installId: install, machineId: "mini", from: "1.7", to: "1.8" }]);
  assert.deepEqual(queryUpdates(db).rows[0]?.job, { id: jobs[0]?.id, state: "queued", batchId });
  setJobState(db, jobs[0]!.id, "done");
  assert.equal(queryUpdates(db).rows[0]?.job?.state, "done");
});
