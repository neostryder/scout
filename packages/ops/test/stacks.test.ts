import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideRecipe, listActions, openCatalog, recipesResponse, recordListeners, recordServices, scanRecipes, upsertMachine, type ActionRecord, type ServiceFact, type Stack } from "@scout/core";
import { ControlRunner, type ControlRunnerDeps } from "../src/control.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve("stack-ops-")).replace(/\\/g, "/");
  mkdirSync(`${root}/.claude`);
  const putRecipe = (arg = "app.js") => writeFileSync(`${root}/.claude/launch.json`, JSON.stringify({ configurations: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: [arg] }] }));
  putRecipe();
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  scanRecipes(db, [{ machineId: "hub", name: "fixture", root }]);
  const recipe = recipesResponse(db).recipes[0]!;
  decideRecipe(db, { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true });
  const facts: ServiceFact[] = ["First", "Last"].map((name) => ({ kind: "scheduled-task", name, displayName: null, domain: "gui", program: "C:/Tools/node.exe", state: "stopped", startMode: "manual", enabled: true, pid: null, runAs: null, triggers: null, lastRun: null, lastResult: null }));
  const store = () => recordServices(db, "hub", { origin: "services", status: "ok", facts }, "2026-10-07T00:00:00Z");
  store();
  const stack: Stack = { name: "dev", label: "Development", members: [{ type: "service", machine: "hub", kind: "scheduled-task", name: "First", waitPort: 8470, waitSeconds: 5 }, { type: "recipe", project: recipe.project, source: "launch-json", name: "dev", waitPort: 8471, waitSeconds: 5 }, { type: "service", machine: "hub", kind: "scheduled-task", name: "Last", waitSeconds: 30 }] };
  let stamp = 100;
  const putStack = () => { writeFileSync(`${root}/stacks.json`, JSON.stringify({ stacks: [stack] })); utimesSync(`${root}/stacks.json`, stamp, ++stamp); };
  putStack();
  let time = 0;
  const calls: string[] = [];
  const running = new Set<string>();
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const deps: ControlRunnerDeps = {
    machines: [{ id: "hub", os: "windows", transport: { type: "local" } }], clock,
    stacksPath: `${root}/stacks.json`, protectedPath: `${root}/protected.json`,
    reader: async (_machine, row) => ({ ...row, state: running.has(row.name) ? "running" : row.state }),
    recipeReader: async () => true,
    portReader: async (_machine, port) => { calls.push(`port:${port}`); return true; },
    exec: async (_transport, _argv, _timeout, _signal, env) => { const name = env!.SCOUT_NAME ?? "dev"; calls.push(`start:${name}`); running.add(name); return { exitCode: 0, stdout: "4321", stderr: "" }; },
  };
  const runner = (overrides: Partial<ControlRunnerDeps> = {}) => { const control = new ControlRunner(db, { ...deps, ...overrides }); t.after(() => control.close()); return control; };
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, recipe, facts, stack, deps, store, putStack, putRecipe, calls, running, runner, time: () => time };
}
async function start(control: ControlRunner) {
  const plan = (await control.plan("stack", "dev", "start"))!;
  assert.equal(plan.allowed, true, plan.refusal ?? "The stack must allow Start.");
  const run = await control.run(plan.id!, plan.token!);
  return control.wait(run.actionId);
}

test("stack plans join commands and effects, skip running members and propagate UAC", async (t) => {
  const f = fixture(t);
  f.running.add("First");
  f.facts[1]!.kind = "windows-service";
  f.facts[1]!.domain = "system";
  f.stack.members[2] = { type: "service", machine: "hub", kind: "windows-service", name: "Last", waitSeconds: 30 };
  f.store(); f.putStack();
  const plan = (await f.runner().plan("stack", "dev", "start"))!;
  assert.equal(plan.target, "stack");
  assert.equal(plan.mechanism, "stack");
  assert.equal(plan.admin, "uac");
  assert.equal(plan.graceful, true);
  assert.equal(plan.steps!.length, 3);
  assert.equal(plan.steps![0]!.skipped, true);
  assert.equal(plan.steps![0]!.refusal, "Already running");
  assert.match(plan.effects[1]!, /2\. Start .* dev \(node app.js\), then wait for port 8471/);
  assert.match(plan.command, /node app.js\nStart-Service -Name Last/);
  assert.equal("stackMembers" in plan || "env" in plan, false);
});

test("stack refusals name an unapproved recipe, missing service, unsupported action and mixed machine", async (t) => {
  const f = fixture(t);
  const control = f.runner();
  decideRecipe(f.db, { id: f.recipe.id, hash: f.recipe.hash, decision: "reject", confirm: true });
  const refused = (await control.plan("stack", "dev", "start"))!;
  assert.equal(refused.allowed, false);
  assert.equal(refused.refusal, `${f.recipe.project} dev: The recipe needs approval.`);
  assert.equal((await control.plan("stack", "dev", "stop"))!.refusalKind, "unsupported");
  assert.equal((await control.plan("stack", "dev", "restart"))!.refusalKind, "unsupported");
  assert.equal((await control.plan("stack", "dev", "start", true))!.refusalKind, "unsupported");
  assert.equal((await control.plan("stack", "missing", "start"))!.refusalKind, "unknown");
  f.stack.members = [{ type: "service", machine: "hub", kind: "scheduled-task", name: "Missing", waitSeconds: 30 }]; f.putStack();
  assert.equal((await control.plan("stack", "dev", "start"))!.refusal, "Missing: No such service.");
  f.stack.members.push({ type: "service", machine: "mini", kind: "launchd", name: "Other", waitSeconds: 30 }); f.putStack();
  assert.match((await control.plan("stack", "dev", "start"))!.refusal!, /same machine/);
});

test("a stack refuses when every member already runs and never executes skipped members", async (t) => {
  const f = fixture(t);
  f.stack.members = [f.stack.members[0]!, f.stack.members[2]!]; f.putStack();
  f.running.add("First"); f.running.add("Last");
  const control = f.runner();
  assert.equal((await control.plan("stack", "dev", "start"))!.refusal, "Everything in this stack is already running.");
  f.running.delete("Last");
  const audit = await start(control);
  assert.equal(audit!.state, "done");
  assert.deepEqual(f.calls, ["start:Last"]);
  assert.equal(listActions(f.db).filter((row) => row.target === "service").length, 1);
});

for (const change of ["member", "recipe", "file", "wait", "decision"] as const) test(`the joined fingerprint refuses a changed ${change} before auditing or execution`, async (t) => {
  const f = fixture(t);
  const control = f.runner();
  const plan = (await control.plan("stack", "dev", "start"))!;
  if (change === "member") { f.facts[0]!.program = "C:/Tools/changed.exe"; f.store(); }
  if (change === "recipe") f.putRecipe("changed.js");
  if (change === "file") { f.stack.members.reverse(); f.putStack(); }
  if (change === "wait") { f.stack.members[0]!.waitSeconds = 6; f.putStack(); }
  if (change === "decision") decideRecipe(f.db, { id: f.recipe.id, hash: f.recipe.hash, decision: "reject", confirm: true });
  await assert.rejects(control.run(plan.id!, plan.token!), { status: 409 });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(listActions(f.db), []);
});

test("stack execution starts each member in order, waits for fresh ports and audits each member", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const control = f.runner({ portReader: async (_machine, port, timeout) => { assert.ok(timeout <= 5000); f.calls.push(`port:${port}`); return ++attempts > 1; } });
  const events: ActionRecord[] = [];
  control.on("action", (row) => events.push(row));
  const audit = await start(control);
  assert.equal(audit!.state, "done");
  assert.equal(audit!.message, "Started 3 of 3 members");
  assert.equal(audit!.rowId, 0);
  assert.deepEqual(f.calls, ["start:First", "port:8470", "port:8470", "start:dev", "port:8471", "start:Last"]);
  assert.equal(f.time(), 10_000);
  const rows = listActions(f.db);
  assert.deepEqual(rows.map((row) => row.target), ["service", "recipe", "service", "stack"]);
  assert.ok(rows.every((row) => row.state === "done"));
  assert.equal(events.filter((row) => row.state === "done").length, 4);
  const stored = f.db.prepare("SELECT plan_json FROM actions WHERE target = 'stack'").get()!.plan_json as string;
  assert.equal(/token|stackMembers|SCOUT_RECIPE/.test(stored), false);
  assert.equal(control.running(), 0);
});

test("a failed member stops subsequent starts and lists earlier members left running", async (t) => {
  const f = fixture(t);
  const control = f.runner({ exec: async (_transport, _argv, _timeout, _signal, env) => {
    const name = env!.SCOUT_NAME ?? "dev";
    f.calls.push(`start:${name}`);
    if (name === "dev") return { exitCode: 7, stdout: "", stderr: "fixture" };
    f.running.add(name);
    return { exitCode: 0, stdout: "4321", stderr: "" };
  } });
  const audit = await start(control);
  assert.equal(audit!.state, "failed");
  assert.match(audit!.message!, /Started 1 of 3; stopped at .* dev: The launch command exited with code 7\.; members left running: First/);
  assert.ok(f.running.has("First"));
  assert.equal(f.calls.includes("start:Last"), false);
  assert.deepEqual(listActions(f.db).map((row) => row.state), ["failed", "done", "failed"]);
});

test("a port that never opens stops a stack at its deadline despite stale catalog listeners", async (t) => {
  const f = fixture(t);
  recordListeners(f.db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 8470, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 500, processName: "old", processPath: "C:/Tools/old.exe", container: null }] }, "2026-10-07T00:00:00Z");
  let reads = 0;
  const control = f.runner({ portReader: async () => { reads++; return false; } });
  const audit = await start(control);
  assert.equal(audit!.state, "failed");
  assert.equal(f.time(), 5000);
  assert.equal(reads, 3);
  assert.match(audit!.message!, /Started 0 of 3; stopped at First: Port 8470 did not open within 5 s; members left running: First/);
  assert.deepEqual(f.calls, ["start:First"]);
});

test("a service confirmation failure retains the existing 20 second member window", async (t) => {
  const f = fixture(t);
  const control = f.runner({ reader: async (_machine, row) => row });
  const audit = await start(control);
  assert.equal(audit!.state, "failed");
  assert.equal(f.time(), 20_000);
  assert.match(audit!.message!, /expected running state did not appear after 20 s/);
  assert.deepEqual(f.calls, ["start:First"]);
});

test("a later member repeats its own checks after earlier members finish", async (t) => {
  const f = fixture(t);
  const control = f.runner({ portReader: async () => { f.putRecipe("changed.js"); return true; } });
  const audit = await start(control);
  assert.equal(audit!.state, "failed");
  assert.match(audit!.message!, /Started 1 of 3; stopped at .* dev: The recipe changed since approval/);
  assert.deepEqual(f.calls, ["start:First"]);
  assert.equal(listActions(f.db).length, 2);
});

test("stack port waits use fresh listener probes separately from recipe confirmation", async (t) => {
  const f = fixture(t);
  f.stack.members = [f.stack.members[0]!]; f.putStack();
  let reads = 0;
  const control = f.runner({ portReader: undefined, exec: async (_transport, _argv, _timeout, _signal, env) => {
    if (env?.SCOUT_NAME) { f.running.add("First"); return { exitCode: 0, stdout: "", stderr: "" }; }
    reads++;
    return { exitCode: 0, stdout: JSON.stringify(reads >= 2 ? [{ port: 8470, pid: 4321, address: "127.0.0.1", name: "node", path: "C:/Tools/node.exe" }] : []), stderr: "" };
  } });
  const audit = await start(control);
  assert.equal(audit!.state, "done");
  assert.equal(reads, 2);
  assert.equal(f.time(), 2000);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM listeners WHERE port = 8470 AND gone_at IS NULL").get()!.count, 1);
});

test("stack confirmations enforce the existing single-use token and expiry", async (t) => {
  const f = fixture(t);
  const control = f.runner();
  const plan = (await control.plan("stack", "dev", "start"))!;
  await assert.rejects(control.run(plan.id!, "wrong"), { status: 404 });
  const run = await control.run(plan.id!, plan.token!);
  await control.wait(run.actionId);
  await assert.rejects(control.run(plan.id!, plan.token!), { status: 404 });
  const next = (await control.plan("stack", "dev", "start"))!;
  await f.deps.clock!.sleep(120_001);
  await assert.rejects(control.run(next.id!, next.token!), { status: 404 });
});
