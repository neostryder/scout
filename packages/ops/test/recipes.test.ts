import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideRecipe, listActions, openCatalog, recipeById, recipesResponse, scanRecipes, upsertMachine, type ActionRecord, type Exec } from "@scout/core";
import { ControlRunner, WINDOWS_RECIPE, WINDOWS_RECIPE_PID, type ControlRunnerDeps } from "../src/control.ts";

function fixture(t: TestContext, port: number | null = null) {
  const root = mkdtempSync(resolve("recipe-ops-")).replace(/\\/g, "/");
  mkdirSync(`${root}/.claude`);
  const put = (arg = "distinct-app.js") => writeFileSync(`${root}/.claude/launch.json`, JSON.stringify({ configurations: [{ name: "distinct-launch", runtimeExecutable: "node", runtimeArgs: [arg], port }] }));
  put();
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const project = { machineId: "hub", name: "fixture", root };
  scanRecipes(db, [project]);
  const recipe = recipesResponse(db).recipes[0]!;
  const approve = () => decideRecipe(db, { id: recipe.id, hash: recipeById(db, recipe.id)!.hash, decision: "approve", confirm: true });
  let time = 0;
  const sleeps: number[] = [];
  const clock = { now: () => time, sleep: async (ms: number) => { sleeps.push(ms); time += ms; } };
  const runner = (deps: Partial<ControlRunnerDeps> = {}) => {
    const control = new ControlRunner(db, { machines: [{ id: "hub", os: "windows", transport: { type: "local" } }], protectedPath: `${root}/protected.json`, clock, exec: async () => { throw new Error("A real process must never start."); }, ...deps });
    t.after(() => control.close());
    return control;
  };
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, project, recipe, put, approve, sleeps, clock, runner, advance: (ms: number) => { time += ms; } };
}

test("recipe plans refuse missing approval, gone sources, hash drift and non-Windows machines", async (t) => {
  const f = fixture(t);
  const control = f.runner();
  assert.equal((await control.plan("recipe", f.recipe.id, "start"))!.refusalKind, "unavailable");
  f.approve();
  const allowed = await control.plan("recipe", f.recipe.id, "start");
  assert.equal(allowed!.allowed, true);
  assert.equal(allowed!.mechanism, "recipe");
  assert.equal(allowed!.command, "node distinct-app.js");
  assert.deepEqual(allowed!.effects, [`Runs in ${f.root}`]);
  assert.equal(allowed!.admin, "none");
  assert.equal(allowed!.graceful, true);
  assert.equal("env" in allowed! || "argv" in allowed!, false);
  assert.equal((await control.plan("recipe", f.recipe.id, "stop"))!.allowed, false);
  assert.equal((await control.plan("recipe", f.recipe.id, "start", true))!.allowed, false);
  const mac = f.runner({ machines: [{ id: "hub", os: "macos", transport: { type: "local" } }] });
  assert.equal((await mac.plan("recipe", f.recipe.id, "start"))!.allowed, false);
  f.put("changed.js");
  assert.equal((await control.plan("recipe", f.recipe.id, "start"))!.refusalKind, "unavailable");
  f.put();
  rmSync(`${f.root}/.claude/launch.json`);
  scanRecipes(f.db, [f.project]);
  assert.match((await control.plan("recipe", f.recipe.id, "start"))!.refusal!, /gone/);
});

test("recipe confirmation refuses drift and changed decisions before executing", async (t) => {
  const f = fixture(t); f.approve();
  let calls = 0;
  const control = f.runner({ exec: async () => { calls++; throw new Error("Execution is forbidden."); } });
  const plan = (await control.plan("recipe", f.recipe.id, "start"))!;
  f.put("changed.js");
  await assert.rejects(control.run(plan.id!, plan.token!), { status: 409 });
  f.put();
  const second = (await control.plan("recipe", f.recipe.id, "start"))!;
  decideRecipe(f.db, { id: f.recipe.id, hash: f.recipe.hash, decision: "reject", confirm: true });
  await assert.rejects(control.run(second.id!, second.token!), { status: 409 });
  assert.equal(calls, 0);
  assert.deepEqual(listActions(f.db), []);
});

test("the fixed recipe script receives data through environment variables and confirms a pid after three seconds", async (t) => {
  const f = fixture(t); f.approve();
  const events: ActionRecord[] = [];
  const calls: { argv: string[]; env: unknown }[] = [];
  const exec: Exec = async (transport, argv, timeout, _signal, env) => {
    assert.deepEqual(transport, { type: "local" });
    assert.ok(timeout <= 20_000);
    calls.push({ argv, env });
    return { exitCode: 0, stdout: argv[4] === WINDOWS_RECIPE ? "4321" : "alive", stderr: "" };
  };
  const control = f.runner({ exec });
  control.on("action", (event) => events.push(event));
  const plan = (await control.plan("recipe", f.recipe.id, "start"))!;
  await assert.rejects(control.run(plan.id!, "wrong"), { status: 404 });
  const run = await control.run(plan.id!, plan.token!);
  const audit = (await control.wait(run.actionId))!;
  assert.equal(audit.state, "done");
  assert.equal(audit.target, "recipe");
  assert.equal(audit.mechanism, "recipe");
  assert.deepEqual(events.map((event) => event.state), ["running", "done"]);
  assert.deepEqual(f.sleeps, [3000]);
  assert.equal(calls[0]!.argv[4], WINDOWS_RECIPE);
  assert.equal(calls[1]!.argv[4], WINDOWS_RECIPE_PID);
  assert.deepEqual(calls[0]!.env, { SCOUT_RECIPE_EXE: "node", SCOUT_RECIPE_ARGS: '["distinct-app.js"]', SCOUT_RECIPE_CWD: f.root });
  assert.deepEqual(calls[1]!.env, { SCOUT_RECIPE_PID: "4321" });
  for (const call of calls) assert.ok(!call.argv.join(" ").includes(f.root) && !call.argv.join(" ").includes("distinct-app.js"));
  assert.match(WINDOWS_RECIPE, /Start-Process -FilePath \$exe -ArgumentList \$args -WorkingDirectory \$cwd -WindowStyle Hidden -PassThru/);
  assert.doesNotMatch(WINDOWS_RECIPE, /Invoke-Expression/);
  const auditPlan = JSON.parse(String(f.db.prepare("SELECT plan_json FROM actions WHERE id = ?").get(audit.id)!.plan_json));
  assert.equal("token" in auditPlan, false);
  await assert.rejects(control.run(plan.id!, plan.token!), { status: 404 });
});

for (const opens of [true, false]) test(`recipe port confirmation ends ${opens ? "done" : "failed"} after fresh listener reads`, async (t) => {
  const f = fixture(t, 4876); f.approve();
  let reads = 0;
  const control = f.runner({ exec: async (_transport, argv) => {
    if (argv[4] === WINDOWS_RECIPE) return { exitCode: 0, stdout: "4321", stderr: "" };
    reads++;
    return { exitCode: 0, stdout: JSON.stringify(opens && reads >= 3 ? [{ port: 4876, pid: 4321, address: "127.0.0.1", name: "node", path: "C:/Tools/node.exe" }] : []), stderr: "" };
  } });
  const plan = (await control.plan("recipe", f.recipe.id, "start"))!;
  const run = await control.run(plan.id!, plan.token!);
  const audit = (await control.wait(run.actionId))!;
  assert.equal(audit.state, opens ? "done" : "failed");
  assert.equal(f.sleeps.reduce((a, b) => a + b, 0), opens ? 4000 : 20_000);
  assert.equal(recipeById(f.db, f.recipe.id)!.running, opens);
  assert.match(audit.message!, opens ? /4876 is listening/ : /4876 did not open within 20 s/);
});

for (const result of [{ exitCode: 1, stdout: "", stderr: "private-output" }, { exitCode: 0, stdout: "invalid pid", stderr: "" }]) test(`recipe launch failure with exit code ${result.exitCode} records no private output`, async (t) => {
  const f = fixture(t); f.approve();
  const control = f.runner({ exec: async () => result });
  const plan = (await control.plan("recipe", f.recipe.id, "start"))!;
  const run = await control.run(plan.id!, plan.token!);
  const audit = (await control.wait(run.actionId))!;
  assert.equal(audit.state, "failed");
  assert.ok(!JSON.stringify(audit).includes("private-output"));
});

test("recipe confirmation fails when the launched pid exits and expired plans execute nothing", async (t) => {
  const f = fixture(t); f.approve();
  let calls = 0;
  const control = f.runner({ exec: async () => { calls++; return { exitCode: 0, stdout: "4321", stderr: "" }; }, recipeReader: async () => false });
  const plan = (await control.plan("recipe", f.recipe.id, "start"))!;
  const run = await control.run(plan.id!, plan.token!);
  assert.match((await control.wait(run.actionId))!.message!, /exited before confirmation/);
  const expired = (await control.plan("recipe", f.recipe.id, "start"))!;
  f.advance(120_000);
  await assert.rejects(control.run(expired.id!, expired.token!), { status: 404 });
  assert.equal(calls, 1);
});
