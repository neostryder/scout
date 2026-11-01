import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordResearch, recordScan, setJobAttention, setJobPhase, upsertMachine, type Db, type Exec, type ExecHooks } from "@scout/core";
import { planUpdate } from "../src/plan.ts";
import { failure, packageOwnsService, previewUpdate, runJob, Runner, type RunnerDeps, type WindowsService } from "../src/runner.ts";
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
  const runner = new Runner(db, { machines: [{ id: "eru", ...local }], exec, readServices: async () => [], observeIntervalMs: 5, ...extra });
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
  assert.equal(failure(-1978335189, "", ctx), "the new version uses a different installer type than the installed one; uninstall the package and install the newer version");
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

function recoverySeed(key = "Cloudflare.cloudflared", from = "2026.9.0", to = "2026.10.0") {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: "winget", location: "", status: "ok", installs: [{ ecosystem: "winget", key, name: key, kind: "app", version: from, location: "C:/Program Files/Cloudflared" }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
  recordResearch(db, pkg, "winget", "ok", [{ channel: "stable", version: to, installable: true }], null);
  const job = enqueueBatch(db, [{ installId: id, machineId: "eru", from, to }]).jobs[0]!;
  let listed = 0;
  const exec: Exec = async (_transport, argv) => ({ exitCode: 0, stdout: argv[1] === "list" ? `Package ${key} ${++listed === 1 ? from : to}  winget\n` : "updated", stderr: "" });
  return { db, id, job, exec, machines: [{ id: "eru", ...local }] };
}

const CLOUDFLARED: WindowsService = { name: "Cloudflared", state: "Running", startMode: "Auto", pathName: '"C:/Program Files/Cloudflared/cloudflared.exe" tunnel run' };

test("service ownership matches Cloudflared by token or install directory, with directory boundaries", () => {
  const install = { key: "Cloudflare.cloudflared", name: "Cloudflared Windows Desktop App", location: "" };
  assert.equal(packageOwnsService(CLOUDFLARED, install), true);
  assert.equal(packageOwnsService({ ...CLOUDFLARED, name: "Tunnel", pathName: "C:/tools/CLOUDFLARED.exe tunnel run" }, install), true);
  assert.equal(packageOwnsService({ ...CLOUDFLARED, name: "Other", pathName: "C:/tools/other.exe" }, install), false);
  assert.equal(packageOwnsService({ ...CLOUDFLARED, name: "CloudflaredOther", pathName: "C:/tools/cloudflared-other.exe" }, install), false);
  assert.equal(packageOwnsService({ ...CLOUDFLARED, name: "Windows", pathName: "C:/tools/desktop.exe" }, install), false);
  const located = { ...install, location: "C:/Program Files/Cloudflared/" };
  assert.equal(packageOwnsService({ ...CLOUDFLARED, name: "Helper", pathName: '"c:/program files/cloudflared/bin/helper.exe" --service' }, located), true);
  assert.equal(packageOwnsService({ ...CLOUDFLARED, name: "Other", pathName: '"C:/Program Files/Cloudflared-other/helper.exe"' }, located), false);
});

for (const scenario of ["still running", "restored", "denied"]) {
  test(`service recovery records a package service that is ${scenario}`, async (t) => {
    const f = recoverySeed();
    t.after(() => f.db.close());
    let reads = 0;
    const started: string[] = [];
    const readServices = async () => {
      const state = ++reads === 1 || scenario === "still running" ? "Running" : "Stopped";
      return [{ ...CLOUDFLARED, state }, { ...CLOUDFLARED, name: "Other", pathName: "C:/Other/other.exe" }, { ...CLOUDFLARED, name: "ManualHelper", startMode: "Manual" }, { ...CLOUDFLARED, name: "StoppedHelper", state: "Stopped" }];
    };
    await runJob(f.db, f.job, { machines: f.machines, exec: f.exec, readServices, startService: async (name) => { started.push(name); if (scenario === "denied") throw new Error("Access is denied"); } }, new AbortController().signal);
    const job = jobById(f.db, f.job.id)!;
    assert.equal(job.state, "done");
    assert.deepEqual(started, scenario === "still running" ? [] : ["Cloudflared"]);
    assert.deepEqual(job.steps.map((step) => step.name), ["preflight", "services-before", "services-restore", "update", "verify"]);
    assert.match(job.steps[1]!.output!, /Cloudflared: Running \(Auto\)/);
    if (scenario === "denied") {
      assert.equal(job.attention?.kind, "service");
      assert.equal(job.attention?.detail, "service Cloudflared could not be restored; run Start-Service -Name 'Cloudflared' in an elevated PowerShell");
      assert.equal(job.message, job.attention?.detail);
      assert.equal(job.steps[2]?.state, "failed");
      assert.match(job.steps[2]!.output!, /Access is denied/);
    } else {
      assert.equal(job.attention, null);
      assert.equal(job.steps[2]?.state, "done");
    }
  });
}

test("service recovery also runs after failed, timed-out, and throwing installers", async (t) => {
  for (const exitCode of [1, -1, null]) {
    const f = recoverySeed();
    t.after(() => f.db.close());
    let reads = 0;
    const started: string[] = [];
    const exec: Exec = async (...args) => {
      if (args[1][1] !== "upgrade") return f.exec(...args);
      if (exitCode === null) throw new Error("the installer could not start");
      return { exitCode, stdout: "installer stopped the service", stderr: "" };
    };
    await runJob(f.db, f.job, { machines: f.machines, exec, readServices: async () => [{ ...CLOUDFLARED, state: ++reads === 1 ? "Running" : "Stopped" }], startService: async (name) => { started.push(name); } }, new AbortController().signal);
    assert.equal(jobById(f.db, f.job.id)?.state, "failed");
    assert.deepEqual(started, ["Cloudflared"]);
    assert.equal(jobById(f.db, f.job.id)?.steps.find((step) => step.name === "services-restore")?.state, "done");
  }
});

test("service recovery keeps its own signal after the user stops an installer", async (t) => {
  const f = recoverySeed();
  t.after(() => f.db.close());
  const controller = new AbortController();
  let reads = 0;
  let restored = false;
  const exec: Exec = async (...args) => {
    if (args[1][1] !== "upgrade") return f.exec(...args);
    controller.abort();
    return { exitCode: -1, stdout: "", stderr: "stopped" };
  };
  await runJob(f.db, f.job, { machines: f.machines, exec, readServices: async () => [{ ...CLOUDFLARED, state: ++reads === 1 ? "Running" : "Stopped" }], startService: async (_name, signal) => { assert.equal(signal.aborted, false); restored = true; } }, controller.signal);
  assert.equal(restored, true);
  assert.equal(jobById(f.db, f.job.id)?.state, "stopped");
});

test("a service starter that never settles cannot hold the queue beyond sixty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = recoverySeed();
  t.after(() => f.db.close());
  let reads = 0;
  let started!: () => void;
  let startSignal: AbortSignal | undefined;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const running = runJob(f.db, f.job, { machines: f.machines, exec: f.exec, readServices: async () => [{ ...CLOUDFLARED, state: ++reads === 1 ? "Running" : "Stopped" }], startService: async (_name, signal) => { startSignal = signal; started(); return new Promise(() => undefined); } }, new AbortController().signal);
  await starting;
  t.mock.timers.tick(60_000);
  await running;
  assert.equal(startSignal?.aborted, true);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "done");
  assert.equal(job.attention?.kind, "service");
  assert.match(job.steps.find((step) => step.name === "services-restore")!.output!, /timed out/);
});

test("service recovery skips Windows over SSH and local non-Windows machines", async (t) => {
  for (const os of ["windows", "macos", "linux"]) {
    const f = recoverySeed();
    t.after(() => f.db.close());
    f.db.prepare("UPDATE machines SET os = ?").run(os);
    const transport = os === "windows" ? { type: "ssh" as const, target: "fixture" } : local.transport;
    await runJob(f.db, f.job, { machines: [{ id: "eru", transport }], exec: f.exec, readServices: async () => assert.fail("unexpected service read"), startService: async () => assert.fail("unexpected service start") }, new AbortController().signal);
    const job = jobById(f.db, f.job.id)!;
    assert.equal(job.state, "done");
    assert.equal(job.steps.some((step) => step.name.startsWith("services-")), false);
  }
});

test("the Windows service commands use the existing exec with argument arrays", async (t) => {
  const f = recoverySeed();
  t.after(() => f.db.close());
  let reads = 0;
  let started = false;
  const exec: Exec = async (...args) => {
    const [transport, argv, timeout, signal] = args;
    if (argv[0] !== "pwsh") return f.exec(...args);
    assert.equal(transport.type, "local");
    assert.ok(signal);
    assert.ok(timeout <= 60_000);
    if (argv[4]!.includes("Get-CimInstance Win32_Service")) {
      assert.doesNotMatch(argv[4]!, /Start-Service|Stop-Service/);
      return { exitCode: 0, stdout: JSON.stringify([{ ...CLOUDFLARED, state: ++reads === 1 ? "Running" : "Stopped" }]), stderr: "" };
    }
    assert.match(argv[4]!, /Start-Service -Name \$args\[0\]/);
    assert.equal(argv[5], "Cloudflared");
    started = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await runJob(f.db, f.job, { machines: f.machines, exec }, new AbortController().signal);
  assert.equal(started, true);
  assert.equal(jobById(f.db, f.job.id)?.state, "done");
});

test("Zoom reaches its exact parenthesized target through plan, run, and verify", async (t) => {
  const f = recoverySeed("Zoom.Zoom", "7.2.1 (48556)", "7.2.5 (51704)");
  t.after(() => f.db.close());
  assert.equal(previewUpdate(f.db, f.id, f.machines)?.preview.allowed, true);
  await runJob(f.db, f.job, { machines: f.machines, exec: f.exec, readServices: async () => [] }, new AbortController().signal);
  assert.equal(jobById(f.db, f.job.id)?.state, "done");
  assert.equal((f.db.prepare("SELECT version FROM installs WHERE id = ?").get(f.id) as { version: string }).version, "7.2.5 (51704)");
});

test("a successful update followed by an unreadable winget reports a manual check", async (t) => {
  const f = recoverySeed("Microsoft.AppInstaller");
  t.after(() => f.db.close());
  let updated = false;
  const exec: Exec = async (...args) => {
    if (args[1][1] === "upgrade") updated = true;
    else if (updated) return { exitCode: 127, stdout: "", stderr: "spawn winget EACCES" };
    return f.exec(...args);
  };
  await runJob(f.db, f.job, { machines: f.machines, exec, readServices: async () => [], checkTimeoutMs: 1 }, new AbortController().signal);
  assert.equal(jobById(f.db, f.job.id)?.message, "could not read the installed version after the update; check it with winget list");
  assert.equal(jobById(f.db, f.job.id)?.steps.at(-1)?.name, "verify");
});

test("winget verification recovers from temporary spawn locks after an update", async (t) => {
  const f = recoverySeed("Microsoft.AppInstaller");
  t.after(() => f.db.close());
  let updated = false;
  let checks = 0;
  const exec: Exec = async (...args) => {
    if (args[1][1] === "upgrade") updated = true;
    else if (updated && ++checks < 3) return { exitCode: 127, stdout: "", stderr: "spawn winget EACCES", spawnError: "EACCES" };
    return f.exec(...args);
  };
  await runJob(f.db, f.job, { machines: f.machines, exec, readServices: async () => [] }, new AbortController().signal);
  assert.equal(checks, 3);
  assert.equal(jobById(f.db, f.job.id)?.state, "done");
});

test("a late desktop observation cannot clear service recovery attention", async (t) => {
  const f = recoverySeed();
  t.after(() => f.db.close());
  let finish!: () => void;
  let looked!: () => void;
  let observed!: (value: Observation) => void;
  let reads = 0;
  const looking = new Promise<void>((resolve) => { looked = resolve; });
  const observation = new Promise<Observation>((resolve) => { observed = resolve; });
  const exec: Exec = async (...args) => {
    if (args[1][1] !== "upgrade") return f.exec(...args);
    args[5]?.onSpawn?.(4242);
    await new Promise<void>((resolve) => { finish = resolve; });
    return { exitCode: 0, stdout: "updated", stderr: "" };
  };
  const running = runJob(f.db, f.job, { machines: f.machines, exec, observe: async () => { looked(); return observation; }, observeIntervalMs: 1, readServices: async () => [{ ...CLOUDFLARED, state: ++reads === 1 ? "Running" : "Stopped" }], startService: async () => { throw new Error("Access is denied"); } }, new AbortController().signal);
  await looking;
  finish();
  await running;
  observed({ uac: false, windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobById(f.db, f.job.id)?.state, "done");
  assert.equal(jobById(f.db, f.job.id)?.attention?.kind, "service");
});

test("unchanged self-updating apps retain the failure and add an open-app hint", async (t) => {
  for (const key of ["EpicGames.EpicGamesLauncher", "Zoom.Zoom"]) {
    const f = recoverySeed(key, "1.0", "2.0");
    t.after(() => f.db.close());
    const exec: Exec = async (_transport, argv) => ({ exitCode: 0, stdout: argv[1] === "list" ? `Package ${key} 1.0  winget` : "updated", stderr: "" });
    await runJob(f.db, f.job, { machines: f.machines, exec, readServices: async () => [] }, new AbortController().signal);
    const message = jobById(f.db, f.job.id)?.message;
    assert.equal(message, `installed version did not reach the target${key === "Zoom.Zoom" ? "" : "; the app may update itself; open it and let it finish"}`);
  }
});

test("winget recovery messages accept the catalog's unsigned codes and signed HRESULTs", () => {
  for (const code of [2316632107, 0x8A15008E]) {
    for (const value of [code, code | 0]) assert.equal(failure(value, ""), "the new version uses a different installer type than the installed one; uninstall the package and install the newer version");
  }
  for (const code of [2316632340, 2316632340 | 0]) assert.equal(failure(code, ""), "winget cannot upgrade this package; use the publisher's own update method (for MSYS2, run pacman -Syu inside MSYS2)");
  for (const code of [2316632137, 2316632137 | 0]) {
    assert.equal(failure(code, "Installer failed with exit code: 1603"), "the installer failed with MSI error 1603; it needs an administrator prompt or the app closed");
    assert.equal(failure(code, "Installer failed with exit code: 1618"), `command exited with code ${code}`);
  }
});
