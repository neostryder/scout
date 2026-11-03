import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, failInterruptedJobs, jobById, openCatalog, recordResearch, recordScan, upsertMachine, type Db, type Exec, type Job } from "@scout/core";
import { planUpdate, REINSTALL_WARNING } from "../src/plan.ts";
import { previewUpdate, runJob, type RunnerDeps } from "../src/runner.ts";

const machines = [{ id: "eru", transport: { type: "local" as const } }];
const machine = { transport: { type: "local" as const } };
const KEY = "Audacity.Audacity";

function seeded(from = "3.7.9", to = "4.0.0"): { db: Db; id: number; job: Job } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: "winget", location: "", status: "ok", installs: [{ ecosystem: "winget", key: KEY, name: "Audacity", kind: "app", version: from, location: "" }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages WHERE key = ?").get(KEY) as { id: number }).id;
  recordResearch(db, pkg, "winget", "ok", [{ channel: "stable", version: to, installable: true }], null);
  const id = (db.prepare("SELECT id FROM installs WHERE package_id = ?").get(pkg) as { id: number }).id;
  return { db, id, job: enqueueBatch(db, [{ installId: id, machineId: "eru", from, to, reinstall: true }]).jobs[0]! };
}

const deps = (exec: Exec): RunnerDeps => ({ machines, exec, readServices: async () => [], retryDelayMs: 1 });
const list = (version: string): string => `Package ${KEY} ${version}  winget\n`;
const installed = (db: Db, id: number): string => (db.prepare("SELECT version FROM installs WHERE id = ?").get(id) as { version: string }).version;

/** A machine where uninstall removes Audacity and install brings 4.0.0 unless told to fail. */
function box(options: { uninstallExit?: number; installExit?: number } = {}) {
  let version: string | null = "3.7.9";
  const ran: string[] = [];
  const exec: Exec = async (_t, argv) => {
    if (argv[1] === "uninstall") { ran.push("uninstall"); if (options.uninstallExit) return { exitCode: options.uninstallExit, stdout: "", stderr: "" }; version = null; return { exitCode: 0, stdout: "removed", stderr: "" }; }
    if (argv[1] === "install") { ran.push("install"); if (options.installExit) return { exitCode: options.installExit, stdout: "", stderr: "" }; version = "4.0.0"; return { exitCode: 0, stdout: "installed", stderr: "" }; }
    return version === null ? { exitCode: 1, stdout: "No installed package found", stderr: "" } : { exitCode: 0, stdout: list(version), stderr: "" };
  };
  return { exec, ran };
}

test("an Audacity major update is refused with an offer to uninstall and reinstall, and the offer carries the warning", () => {
  const plan = planUpdate({ ecosystem: "winget", key: KEY, version: "3.7.9", kind: "app" }, "4.0.0", machine);
  assert.equal(plan.allowed, false);
  assert.equal(plan.reinstall?.warning, REINSTALL_WARNING);
  assert.equal(plan.uninstall, null);
  assert.equal(planUpdate({ ecosystem: "winget", key: KEY, version: "3.7.9", kind: "app" }, "3.7.10", machine).reinstall, null);
  assert.equal(planUpdate({ ecosystem: "winget", key: "MSYS2.MSYS2", version: "2025.12.13", kind: "app" }, "2026.10.26", machine).reinstall, null);
});

test("a reinstall plan uninstalls the package and then installs the exact target version", () => {
  const plan = planUpdate({ ecosystem: "winget", key: KEY, version: "3.7.9", kind: "app" }, "4.0.0", machine, false, true);
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.uninstall, ["winget", "uninstall", "--id", KEY, "--exact", "--silent"]);
  assert.deepEqual(plan.argv, ["winget", "install", "--id", KEY, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--version", "4.0.0"]);
  assert.equal(plan.command.split("\n").length, 2);
  assert.deepEqual(plan.verify.argv, ["winget", "list", "--id", KEY, "--exact"]);
});

test("a reinstall is only planned for software that needs one, and never over an ordinary update", () => {
  assert.equal(planUpdate({ ecosystem: "winget", key: KEY, version: "3.7.9", kind: "app" }, "3.7.10", machine, false, true).refusal, "Scout cannot reinstall this software");
  assert.equal(planUpdate({ ecosystem: "winget", key: "Obsidian.Obsidian", version: "1.0", kind: "app" }, "2.0", machine, false, true).refusal, "Scout cannot reinstall this software");
  assert.equal(planUpdate({ ecosystem: "npm", key: "left-pad", version: "1.0", kind: "package" }, "2.0", machine, false, true).uninstall, null);
});

test("the preview of a refused update names the reinstall command, and a reinstall preview is allowed", (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  const refused = previewUpdate(f.db, f.id, machines)!.preview;
  assert.equal(refused.allowed, false);
  assert.match(refused.reinstall?.command ?? "", /winget uninstall[^\n]*\nwinget install/);
  const reinstall = previewUpdate(f.db, f.id, machines, { reinstall: true })!.preview;
  assert.equal(reinstall.allowed, true);
  assert.equal(reinstall.reinstall, null);
});

test("a reinstall job uninstalls, installs, verifies the new version, and records each step", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  const m = box();
  await runJob(f.db, f.job, deps(m.exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "done");
  assert.deepEqual(m.ran, ["uninstall", "install"]);
  assert.deepEqual(job.steps.map((step) => `${step.name}:${step.state}`), ["preflight:done", "uninstall:done", "install:done", "verify:done"]);
  assert.equal(installed(f.db, f.id), "4.0.0");
});

test("a failed uninstall stops before anything is installed and says the app was not changed", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  const m = box({ uninstallExit: 1603 });
  await runJob(f.db, f.job, deps(m.exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "failed");
  assert.deepEqual(m.ran, ["uninstall"]);
  assert.match(job.message ?? "", /Could not uninstall Audacity: .*Check whether Audacity is still installed/);
  assert.equal(installed(f.db, f.id), "3.7.9");
});

test("an install that fails after the uninstall says the app is gone and how to bring it back", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  const m = box({ installExit: 1 });
  await runJob(f.db, f.job, deps(m.exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "failed");
  assert.deepEqual(m.ran, ["uninstall", "install"]);
  assert.match(job.message ?? "", /Audacity was uninstalled, but the new version did not install/);
  assert.match(job.message ?? "", new RegExp(`winget install --id ${KEY}`));
});

test("a reinstall refused by the plan runs nothing, and a restart mid-reinstall fails the job without requeueing it", async (t) => {
  const f = seeded("3.7.9", "3.7.10");
  t.after(() => f.db.close());
  const m = box();
  await runJob(f.db, f.job, deps(m.exec), new AbortController().signal);
  assert.deepEqual(m.ran, []);
  assert.equal(jobById(f.db, f.job.id)?.state, "failed");
  const g = seeded();
  t.after(() => g.db.close());
  g.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(g.job.id);
  failInterruptedJobs(g.db);
  const job = jobById(g.db, g.job.id)!;
  assert.equal(job.state, "failed");
  assert.match(job.message ?? "", /may already be uninstalled/);
});
