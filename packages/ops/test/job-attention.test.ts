import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordResearch, recordScan, setJobAttention, setJobPhase, upsertMachine, type Db, type Exec, type ExecHooks } from "@scout/core";
import { planUpdate } from "../src/plan.ts";
import { failure, previewUpdate, Runner, type RunnerDeps } from "../src/runner.ts";
import type { Observation } from "../src/observe.ts";

const local = { transport: { type: "local" as const } };

function seeded(details?: Record<string, unknown>): { db: Db; id: number } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: "winget", location: "", status: "ok", installs: [{ ecosystem: "winget", key: "Obsidian.Obsidian", name: "Obsidian", kind: "package", version: "1.12.7", location: "", ...(details ? { details } : {}) }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  recordResearch(db, pkg, "winget", "ok", [{ channel: "stable", version: "1.14.4", installable: true }], null);
  return { db, id: (db.prepare("SELECT id FROM installs").get() as { id: number }).id };
}

const LIST = (version: string) => `Name     Id                Version Source\n------------------------------------------\nObsidian Obsidian.Obsidian ${version}  winget\n`;
const OUTPUT = ["Found Obsidian [Obsidian.Obsidian] Version 1.14.4\n", "Downloading https://example.test/Obsidian-1.14.4.exe\n", "Successfully verified installer hash\n", "Starting package install...\n", "The installer will request to run as administrator. Expect a prompt.\n"];
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 400 && !check(); n++) await tick(); assert.ok(check(), "condition was not reached in time"); }

function setup(id: number, db: Db, extra: Partial<RunnerDeps>, update: (hooks: ExecHooks, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string }>): { runner: Runner; jobId: number } {
  let listed = 0;
  const exec: Exec = async (_t, argv, _timeout, signal, _env, hooks) => {
    if (argv[1] === "list") return { exitCode: 0, stdout: LIST(++listed === 1 ? "1.12.7" : "1.14.4"), stderr: "" };
    return update(hooks ?? {}, signal);
  };
  const runner = new Runner(db, { machines: [{ id: "eru", ...local }], exec, observeIntervalMs: 5, ...extra });
  const jobId = enqueueBatch(db, [{ installId: id, machineId: "eru", from: "1.12.7", to: "1.14.4" }]).jobs[0]!.id;
  runner.wake();
  return { runner, jobId };
}

test("the job records each winget stage as it arrives and the administrator prompt while it is up", async () => {
  const { db, id } = seeded();
  let promptUp = false;
  let finish!: () => void;
  const { jobId } = setup(id, db, { observe: async () => ({ uac: promptUp, windows: [] }) }, async (hooks) => {
    hooks.onSpawn?.(4242);
    for (const chunk of OUTPUT) { hooks.onOutput?.(chunk); await tick(); }
    promptUp = true;
    await new Promise<void>((resolve) => { finish = resolve; });
    hooks.onOutput?.("Successfully installed\n");
    return { exitCode: 0, stdout: OUTPUT.join("") + "Successfully installed\n", stderr: "" };
  });
  try {
    await until(() => jobById(db, jobId)?.phase === "install" && jobById(db, jobId)?.attention?.kind === "uac");
    await tick(40);
    promptUp = false;
    await until(() => jobById(db, jobId)?.attention === null);
    assert.equal(jobById(db, jobId)?.state, "running", "the job is still installing after the prompt closes");
  } finally { finish?.(); }
  await until(() => jobById(db, jobId)?.state === "done");
  const done = jobById(db, jobId)!;
  assert.equal(done.phase, "finish");
  assert.equal(done.attention, null);
  assert.equal((db.prepare("SELECT version FROM installs WHERE id = ?").get(id) as { version: string }).version, "1.14.4");
  db.close();
});

test("an installer window shows as attention and clears when it closes", async () => {
  const { db, id } = seeded();
  const looks: Observation[] = [{ uac: false, windows: [{ pid: 9, process: "setup", title: "Setup Wizard" }] }];
  let finish!: () => void;
  const { jobId } = setup(id, db, { observe: async () => looks.shift() ?? { uac: false, windows: [] } }, async (hooks) => {
    hooks.onSpawn?.(4242);
    hooks.onOutput?.("Starting package install...\n");
    await new Promise<void>((resolve) => { finish = resolve; });
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  await until(() => jobById(db, jobId)?.attention?.kind === "window");
  assert.equal(jobById(db, jobId)?.attention?.detail, "Setup Wizard (setup)");
  await until(() => jobById(db, jobId)?.attention === null);
  finish();
  await until(() => jobById(db, jobId)?.state === "done");
  db.close();
});

test("a declined administrator prompt fails the job with that reason", async () => {
  const { db, id } = seeded();
  const { jobId } = setup(id, db, { observe: async () => ({ uac: true, windows: [] }) }, async (hooks) => {
    hooks.onSpawn?.(4242);
    for (const chunk of OUTPUT) hooks.onOutput?.(chunk);
    await tick(30);
    return { exitCode: 1223, stdout: OUTPUT.join(""), stderr: "" };
  });
  await until(() => jobById(db, jobId)?.state === "failed");
  assert.equal(jobById(db, jobId)?.message, "the Windows administrator prompt was declined");
  assert.equal(jobById(db, jobId)?.attention, null);
  db.close();
});

test("a prompt left unanswered stops the update instead of holding the machine", async () => {
  const { db, id } = seeded();
  const { jobId } = setup(id, db, { observe: async () => ({ uac: true, windows: [] }), promptTimeoutMs: 40 }, async (hooks, signal) => {
    hooks.onSpawn?.(4242);
    for (const chunk of OUTPUT) hooks.onOutput?.(chunk);
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { exitCode: -1, stdout: "", stderr: "" };
  });
  await until(() => jobById(db, jobId)?.state === "failed");
  assert.match(jobById(db, jobId)?.message ?? "", /no one answered the Windows administrator prompt/);
  db.close();
});

test("a Stop while the prompt is up still reads as stopped by the user", async () => {
  const { db, id } = seeded();
  const { runner, jobId } = setup(id, db, { observe: async () => ({ uac: true, windows: [] }), promptTimeoutMs: 60_000 }, async (hooks, signal) => {
    hooks.onSpawn?.(4242);
    for (const chunk of OUTPUT) hooks.onOutput?.(chunk);
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { exitCode: -1, stdout: "", stderr: "stopped" };
  });
  await until(() => jobById(db, jobId)?.attention?.kind === "uac");
  assert.equal(runner.stop(jobId), true);
  await until(() => jobById(db, jobId)?.state === "stopped");
  assert.equal(jobById(db, jobId)?.message, "stopped by user");
  await tick(80); // the runner is still winding the stopped job down
  db.close();
});

test("failure words cover the documented winget codes and a stalled installer", () => {
  const ctx = { promptSeen: false, windowSeen: false, timeoutMs: 1_200_000 };
  assert.equal(failure(-1978334964, "", ctx), "the installation was cancelled");
  assert.equal(failure(-1978334964, "", { ...ctx, promptSeen: true }), "the Windows administrator prompt was declined");
  assert.equal(failure(-1978334975, "", ctx), "the app is running; close it and try again");
  assert.equal(failure(-1978334974, "", ctx), "another installation is in progress; try again when it finishes");
  assert.equal(failure(-1978334967, "", ctx), "restart the computer to finish the update");
  assert.equal(failure(-1978335189, "", ctx), "no applicable update is available");
  assert.equal(failure(-1, "", ctx), "did not finish in 20 minutes");
  assert.equal(failure(-1, "", { ...ctx, windowSeen: true }), "did not finish in 20 minutes; the installer opened a window and may have been waiting for you");
  assert.equal(failure(5, "", ctx), "command exited with code 5");
});

test("a machine-scope winget update on this computer is allowed and flagged for the prompt, and elsewhere it stays refused", () => {
  const scope = { scope: "machine" };
  const here = planUpdate({ ecosystem: "winget", key: "Obsidian.Obsidian", kind: "app", details: scope }, "1.14.4", local);
  assert.equal(here.allowed, true);
  assert.equal(here.needsAdmin, true);
  assert.equal(planUpdate({ ecosystem: "msstore", key: "9WZDNCRFJ3Q8", kind: "package", details: scope }, "2.0", local).allowed, true);
  const remote = planUpdate({ ecosystem: "winget", key: "Obsidian.Obsidian", kind: "app", details: scope }, "1.14.4", { transport: { type: "ssh", target: "eru" } });
  assert.equal(remote.refusal, "needs admin; Scout cannot elevate yet");
  assert.equal(planUpdate({ ecosystem: "brew", key: "git", kind: "package", details: { requiresSudo: true } }, "2.0", local).refusal, "needs admin; Scout cannot elevate yet");
});

test("phase and attention writes keep their first time, ignore finished jobs, and clear when the job ends", () => {
  const { db, id } = seeded();
  const jobId = enqueueBatch(db, [{ installId: id, machineId: "eru", from: "1.12.7", to: "1.14.4" }]).jobs[0]!.id;
  setJobPhase(db, jobId, "download", "2026-01-01T00:00:00.000Z");
  assert.equal(jobById(db, jobId)?.phase, null, "a queued job takes no stage");
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId);
  setJobPhase(db, jobId, "download", "2026-01-01T00:00:00.000Z");
  setJobPhase(db, jobId, "download", "2026-01-01T00:00:09.000Z");
  assert.equal(jobById(db, jobId)?.phaseAt, "2026-01-01T00:00:00.000Z");
  setJobAttention(db, jobId, { kind: "window", detail: "A" }, "2026-01-01T00:00:01.000Z");
  setJobAttention(db, jobId, { kind: "window", detail: "B" }, "2026-01-01T00:00:08.000Z");
  assert.deepEqual(jobById(db, jobId)?.attention, { kind: "window", detail: "B", since: "2026-01-01T00:00:01.000Z" });
  db.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(jobId);
  setJobAttention(db, jobId, { kind: "uac" });
  assert.deepEqual(jobById(db, jobId)?.attention?.kind, "window", "a finished job cannot start waiting");
  db.close();
});

test("a winget update is flagged for the prompt when the registry lists the same app as installed for the whole machine", () => {
  const { db, id } = seeded();
  const machines = [{ id: "eru", ...local }];
  assert.equal(previewUpdate(db, id, machines)!.plan.needsAdmin, false, "with no registry entry nothing says the install is machine-wide");
  recordScan(db, "eru", { sourceKind: "registry", location: "", status: "ok", installs: [{ ecosystem: "arp", key: "Obsidian", name: "Obsidian 1.12.7 x64", kind: "app", version: "1.12.7", location: "", details: { scope: "machine" } }] }, new Date().toISOString());
  assert.equal(previewUpdate(db, id, machines)!.plan.needsAdmin, true);
  db.prepare("UPDATE installs SET details_json = json_set(details_json, '$.scope', 'user') WHERE package_id IN (SELECT id FROM packages WHERE ecosystem = 'arp')").run();
  assert.equal(previewUpdate(db, id, machines)!.plan.needsAdmin, false, "a per-user registry entry raises no prompt");
  recordScan(db, "eru", { sourceKind: "registry", location: "", status: "ok", installs: [{ ecosystem: "arp", key: "Obsidianite", name: "Obsidianite 2", kind: "app", version: "2", location: "", details: { scope: "machine" } }] }, new Date().toISOString());
  assert.equal(previewUpdate(db, id, machines)!.plan.needsAdmin, false, "a different app whose name merely starts the same is not a match");
  db.close();
});
