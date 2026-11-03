import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordResearch, recordScan, upsertMachine, type Exec } from "@scout/core";
import { Runner } from "@scout/ops";
import { createJobsResponse, createReinstallJobResponse, planResponse } from "../src/jobs-api.ts";

function setup() {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: "winget", location: "", status: "ok", installs: [{ ecosystem: "winget", key: "Audacity.Audacity", name: "Audacity", kind: "app", version: "3.7.9", location: "", details: { scope: "machine" } }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
  recordResearch(db, pkg, "winget", "ok", [{ channel: "stable", version: "4.0.0", installable: true }], null);
  const exec: Exec = async () => new Promise(() => undefined);
  return { db, id, runner: new Runner(db, { machines: [{ id: "eru", transport: { type: "local" } }], exec }) };
}

test("the plan refuses the update, offers the reinstall, and the reinstall plan is allowed and needs the administrator prompt", () => {
  const { db, id, runner } = setup();
  const refused = planResponse(db, runner, id) as { allowed: boolean; reinstall: { warning: string; command: string } | null };
  assert.equal(refused.allowed, false);
  assert.ok(refused.reinstall?.warning);
  const plan = planResponse(db, runner, id, null, true) as { allowed: boolean; needsAdmin: boolean };
  assert.equal(plan.allowed, true);
  assert.equal(plan.needsAdmin, true);
  db.close();
});

test("an ordinary update request cannot queue the refused update, and a reinstall needs both confirmations", () => {
  const { db, id, runner } = setup();
  assert.equal(createJobsResponse(db, runner, { installIds: [id], confirm: true, allowAdmin: true }).status, 400);
  assert.equal(createReinstallJobResponse(db, runner, { installIds: [id], confirm: true, allowAdmin: true }).status, 400);
  assert.equal(createReinstallJobResponse(db, runner, { installIds: [id, id], confirm: true, confirmReinstall: true, allowAdmin: true }).status, 400);
  const noAdmin = createReinstallJobResponse(db, runner, { installIds: [id], confirm: true, confirmReinstall: true });
  assert.equal(noAdmin.status, 400);
  assert.equal((noAdmin.body as { error: string }).error, "administrator prompt needs confirmation");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
  const queued = createReinstallJobResponse(db, runner, { installIds: [id], confirm: true, confirmReinstall: true, allowAdmin: true });
  assert.equal(queued.status, 202);
  assert.equal((db.prepare("SELECT action FROM jobs").get() as { action: string }).action, "reinstall");
  assert.equal(createReinstallJobResponse(db, runner, { installIds: [id], confirm: true, confirmReinstall: true, allowAdmin: true }).status, 400);
  db.close();
});
