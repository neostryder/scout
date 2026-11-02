import { test } from "node:test";
import assert from "node:assert/strict";
import { claimNext, enqueueBatch, failInterruptedJobs, jobById, jobForInstall, openCatalog, recordScan, setJobAttention, setJobPhase, setJobState, stopBatch, upsertMachine, type ConfirmedDownload } from "../src/index.ts";

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

test("restart queues an interrupted update again", () => {
  const { db, ids } = seed();
  const first = ids[0] as number;
  const second = ids[1] as number;
  const batch = enqueueBatch(db, [{ installId: first, machineId: "mini", from: "1.0", to: "2.0" }, { installId: second, machineId: "mini", from: "1.0", to: "2.0" }]);
  const job = batch.jobs[0]!;
  claimNext(db, "mini");
  setJobAttention(db, job.id, { kind: "uac" });
  failInterruptedJobs(db);
  const requeued = jobById(db, job.id)!;
  assert.equal(requeued.state, "queued");
  assert.equal(requeued.message, null);
  assert.equal(requeued.attention, null);
  assert.equal(requeued.startedAt, null);
  assert.equal(requeued.phase, null);
  assert.equal(requeued.finishedAt, null);
  assert.deepEqual(requeued.steps.map((step) => step.name), ["requeued"]);
  assert.equal(requeued.steps[0]?.state, "done");
  assert.equal(requeued.steps[0]?.output, "interrupted by a restart during preflight; queued again");
  assert.equal(jobById(db, batch.jobs[1]!.id)?.state, "queued");
  assert.throws(() => enqueueBatch(db, [{ installId: first, machineId: "mini", from: "1.0", to: "2.0" }]), /an update for this install is already queued/);
  db.close();
});

test("a second interruption fails the update and stops queued batch partners", () => {
  const { db, ids } = seed();
  const batch = enqueueBatch(db, ids.map((id) => ({ installId: id, machineId: "mini", from: "1.0", to: "2.0" })));
  const job = batch.jobs[0]!;
  claimNext(db, "mini");
  failInterruptedJobs(db);
  assert.equal(jobById(db, job.id)?.state, "queued");
  assert.equal(claimNext(db, "mini")?.id, job.id);
  setJobState(db, job.id, "running");
  setJobPhase(db, job.id, "install");
  setJobAttention(db, job.id, { kind: "uac" });
  failInterruptedJobs(db);
  assert.equal(jobById(db, job.id)?.state, "failed");
  assert.equal(jobById(db, job.id)?.message, "interrupted by a restart during install; check the installed version, then retry the update");
  assert.equal(jobById(db, job.id)?.attention, null);
  assert.ok(jobById(db, job.id)?.finishedAt);
  assert.equal(jobById(db, batch.jobs[1]!.id)?.state, "stopped");
  db.close();
});

test("a download job interrupted by a restart fails", () => {
  const { db, ids } = seed();
  const download: ConfirmedDownload = { url: "https://vendor.example.test/Demo.dmg", fileName: "Demo.dmg", size: 123, sha256: "a".repeat(64), source: "github", platform: "macos", arch: "x64", version: "2.0", installed: "1.0" };
  const job = enqueueBatch(db, [{ installId: ids[0]!, machineId: "mini", from: "1.0", to: "2.0", download }]).jobs[0]!;
  claimNext(db, "mini");
  failInterruptedJobs(db);
  assert.deepEqual([jobById(db, job.id)?.state, jobById(db, job.id)?.message], ["failed", "interrupted by a restart during preflight; check the installed version, then retry the update"]);
  assert.equal(jobById(db, job.id)?.steps.length, 0);
  db.close();
});
