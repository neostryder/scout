import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordResearch, recordScan, upsertMachine, type Exec } from "@scout/core";
import { Runner } from "@scout/ops";
import { createJobsResponse, planResponse } from "../src/jobs-api.ts";

test("a machine-scope winget update on this computer needs the administrator-prompt confirmation, and the plan says so", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: "winget", location: "", status: "ok", installs: [{ ecosystem: "winget", key: "Obsidian.Obsidian", name: "Obsidian", kind: "package", version: "1.12.7", location: "", details: { scope: "machine" } }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
  recordResearch(db, pkg, "winget", "ok", [{ channel: "stable", version: "1.14.4", installable: true }], null);
  const exec: Exec = async () => new Promise(() => undefined);
  const runner = new Runner(db, { machines: [{ id: "eru", transport: { type: "local" } }], exec });
  const plan = planResponse(db, runner, id) as { allowed: boolean; needsAdmin: boolean; refusal: string | null };
  assert.equal(plan.allowed, true);
  assert.equal(plan.needsAdmin, true);
  const refused = createJobsResponse(db, runner, { installIds: [id], confirm: true });
  assert.equal(refused.status, 400);
  assert.deepEqual((refused.body as { refused: { reason: string }[] }).refused.map((r) => r.reason), ["administrator prompt needs confirmation"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
  const queued = createJobsResponse(db, runner, { installIds: [id], confirm: true, allowAdmin: true });
  assert.equal(queued.status, 202);
  assert.equal((queued.body as { jobs: unknown[] }).jobs.length, 1);
});
