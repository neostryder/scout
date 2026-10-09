import { test } from "node:test";
import assert from "node:assert/strict";
import { claimNext, enqueueBatch, failInterruptedJobs, jobById, jobForInstall, openCatalog, recordScan, setJobState, stopBatch, upsertMachine } from "../src/index.ts";

function seed() {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.0", location: "" },
    { ecosystem: "brew", key: "jq", name: "jq", kind: "package", version: "1.0", location: "" },
  ] }, new Date().toISOString());
  const ids = db.prepare("SELECT id FROM installs ORDER BY id").all() as { id: number }[];
  return { db, ids: ids.map((r) => r.id) };
}

test("jobs claim one per machine and stop the rest of a failed batch", () => {
  const { db, ids } = seed();
  const first = ids[0] as number;
  const second = ids[1] as number;
  const batch = enqueueBatch(db, [{ installId: first, machineId: "mini", from: "1.0", to: "2.0" }, { installId: second, machineId: "mini", from: "1.0", to: "2.0" }]);
  assert.equal(claimNext(db, "mini")?.id, batch.jobs[0]?.id);
  assert.equal(claimNext(db, "mini"), null);
  setJobState(db, batch.jobs[0]!.id, "failed", "bad update");
  stopBatch(db, batch.batchId);
  assert.equal(jobById(db, batch.jobs[1]!.id)?.state, "stopped");
  assert.equal(jobForInstall(db, first)?.id, batch.jobs[0]?.id);
  db.close();
});

test("restart fails interrupted jobs", () => {
  const { db, ids } = seed();
  const job = enqueueBatch(db, [{ installId: ids[0]!, machineId: "mini", from: "1.0", to: "2.0" }]).jobs[0]!;
  claimNext(db, "mini");
  failInterruptedJobs(db);
  assert.deepEqual([jobById(db, job.id)?.state, jobById(db, job.id)?.message], ["failed", "interrupted by a restart"]);
  db.close();
});
