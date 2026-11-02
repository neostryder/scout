import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordScan, recordStep, setJobState, upsertMachine, type Db } from "@scout/core";
import { rewriteLegacyFailures } from "../src/legacy-failures.ts";

function seeded(): { db: Db; installIds: number[] } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: "winget", location: "", status: "ok", installs: [
    { ecosystem: "winget", key: "Obsidian.Obsidian", name: "Obsidian", kind: "package", version: "1.12.7", location: "" },
    { ecosystem: "winget", key: "Git.Git", name: "Git", kind: "package", version: "2.45.0", location: "" },
  ] }, new Date().toISOString());
  const installIds = (db.prepare("SELECT id FROM installs ORDER BY id").all() as { id: number }[]).map((row) => row.id);
  return { db, installIds };
}

/** A job that failed with the given message, with the update step the runner left behind. */
function failedJob(db: Db, installId: number, message: string, output = "winget failed"): number {
  const jobId = enqueueBatch(db, [{ installId, machineId: "eru", from: "1.12.7", to: "1.14.4" }]).jobs[0]!.id;
  recordStep(db, jobId, "update", "failed", output);
  setJobState(db, jobId, "failed", message);
  return jobId;
}

test("a failed update with a winget exit code gets the words the runner uses now", () => {
  const { db, installIds } = seeded();
  const jobId = failedJob(db, installIds[0]!, "command exited with code 2316632107");
  assert.equal(rewriteLegacyFailures(db), 1);
  assert.equal(jobById(db, jobId)?.message, "the new version uses a different installer type than the installed one; uninstall the package and install the newer version");
  assert.equal(rewriteLegacyFailures(db), 0, "a second run has nothing left to rewrite");
  const job = jobById(db, jobId)!;
  assert.equal(job.state, "failed", "the job keeps its state");
  assert.deepEqual(job.steps.map((step) => step.name), ["update"], "the steps are untouched");
  db.close();
});

test("the exit code that means winget cannot upgrade gets the publisher message", () => {
  const { db, installIds } = seeded();
  const jobId = failedJob(db, installIds[0]!, "command exited with code 2316632340");
  assert.equal(rewriteLegacyFailures(db), 1);
  assert.equal(jobById(db, jobId)?.message, "winget cannot upgrade this package; use the publisher's own update method (for MSYS2, run pacman -Syu inside MSYS2)");
  db.close();
});

test("a code the runner cannot explain keeps its message, and the newest update step is the one that counts", () => {
  const { db, installIds } = seeded();
  const jobId = enqueueBatch(db, [{ installId: installIds[0]!, machineId: "eru", from: "1.12.7", to: "1.14.4" }]).jobs[0]!.id;
  recordStep(db, jobId, "update", "failed", "the installer requires administrator rights");
  recordStep(db, jobId, "update", "failed", "winget failed");
  setJobState(db, jobId, "failed", "command exited with code 7");
  assert.equal(rewriteLegacyFailures(db), 0);
  assert.equal(jobById(db, jobId)?.message, "command exited with code 7");
  db.close();
});

test("the message about a version that moved since the plan becomes a retry hint", () => {
  const { db, installIds } = seeded();
  const jobId = failedJob(db, installIds[0]!, "installed version changed since the plan");
  assert.equal(rewriteLegacyFailures(db), 1);
  assert.equal(jobById(db, jobId)?.message, "the installed version moved after the last scan; retry the update, which now continues from the version that is installed");
  assert.equal(rewriteLegacyFailures(db), 0);
  db.close();
});

test("jobs that are not failed updates and the restart message stay as they are", () => {
  const { db, installIds } = seeded();
  const doneId = enqueueBatch(db, [{ installId: installIds[0]!, machineId: "eru", from: "1.12.7", to: "1.14.4" }]).jobs[0]!.id;
  setJobState(db, doneId, "done", "command exited with code 2316632107");
  const queuedId = enqueueBatch(db, [{ installId: installIds[1]!, machineId: "eru", from: "2.45.0", to: "2.46.0" }]).jobs[0]!.id;
  db.prepare("UPDATE jobs SET message = ? WHERE id = ?").run("installed version changed since the plan", queuedId);
  const interruptedId = failedJob(db, installIds[0]!, "interrupted by a restart during install; check the installed version, then retry the update");
  assert.equal(rewriteLegacyFailures(db), 0);
  assert.equal(jobById(db, doneId)?.message, "command exited with code 2316632107");
  assert.equal(jobById(db, queuedId)?.message, "installed version changed since the plan");
  assert.equal(jobById(db, interruptedId)?.message, "interrupted by a restart during install; check the installed version, then retry the update");
  db.close();
});
