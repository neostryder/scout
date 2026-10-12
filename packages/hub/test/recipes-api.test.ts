import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openCatalog, recipeById, upsertMachine } from "@scout/core";
import { createHub } from "../src/server.ts";
import { DescriptionRun } from "../src/descriptions.ts";

async function app(t: TestContext, off = false, describe = false) {
  const root = mkdtempSync(join(tmpdir(), "recipe-hub-")).replace(/\\/g, "/");
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { dev: "node app.js" } }));
  mkdirSync(`${root}/.claude`);
  writeFileSync(`${root}/.claude/launch.json`, JSON.stringify({ configurations: [{ name: "bad", runtimeExecutable: "cmd", runtimeArgs: [] }] }));
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  let time = 0;
  let calls = 0;
  const projects = () => [{ machineId: "hub", name: "fixture", root }];
  const descriptions = describe ? new DescriptionRun(db, { model: async () => { throw new Error("The public request is forbidden."); }, project: { reason: null, projects, client: { role: "fixture", probe: async () => null, generate: async () => { writeFileSync(`${root}/compose.yaml`, "services: {}\n"); return { answer: { summary: "This fixture serves a local project page.", evidence: ["node app.js"], kind: "site" }, servedBy: null }; } } } }) : undefined;
  const server = createHub({ db, webRoot: root, recipeProjects: projects, descriptions, control: off ? false : { machines: [{ id: "hub", os: "windows", transport: { type: "local" } }], protectedPath: `${root}/protected.json`, clock: { now: () => time, sleep: async (ms) => { time += ms; } }, exec: async () => { calls++; return { exitCode: 0, stdout: "4321", stderr: "" }; }, recipeReader: async () => true }, streamHeartbeatMs: 20 });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); db.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { db, root, base, call, descriptions, calls: () => calls };
}
const recipesPath = "/api/services/recipes";

test("recipe endpoints scan at startup, list counts, decide with statuses and run audited Start plans", async (t) => {
  const { call, root, calls } = await app(t);
  const listing = await call(recipesPath);
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.counts, { proposed: 1, approved: 0, rejected: 0, unsupported: 1 });
  const recipe = listing.body.recipes.find((item: any) => item.state === "proposed");
  assert.equal(recipe.cwd, root);
  assert.equal(recipe.running, null);
  const unsupported = listing.body.recipes.find((item: any) => item.state === "unsupported");
  const decision = { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true };
  assert.equal((await call(`${recipesPath}/decide`, { ...decision, id: 999 })).status, 404);
  assert.equal((await call(`${recipesPath}/decide`, { ...decision, hash: "a".repeat(64) })).status, 409);
  assert.equal((await call(`${recipesPath}/decide`, { ...decision, id: unsupported.id, hash: unsupported.hash })).status, 409);
  for (const body of [{}, { ...decision, decision: "start" }, { ...decision, confirm: false }, { ...decision, hash: null }]) assert.equal((await call(`${recipesPath}/decide`, body)).status, 400);
  assert.equal((await call(`${recipesPath}?state=bad`)).status, 400);
  assert.equal((await call("/api/services/actions/plan", { target: "recipe", id: recipe.id, action: "start" })).body.plan.refusalKind, "unavailable");
  assert.equal((await call(`${recipesPath}/decide`, decision)).body.recipe.state, "approved");
  assert.equal((await call(`${recipesPath}?state=approved`)).body.recipes.length, 1);
  const plan = (await call("/api/services/actions/plan", { target: "recipe", id: recipe.id, action: "start" })).body.plan;
  assert.equal(plan.allowed, true);
  assert.equal(plan.mechanism, "recipe");
  const run = await call("/api/services/actions/run", { planId: plan.id, token: plan.token, confirm: true });
  assert.equal(run.status, 202);
  const audit = (await call("/api/services/actions")).body.items[0];
  assert.equal(audit.state, "done");
  assert.equal(audit.target, "recipe");
  assert.equal(calls(), 1);
  assert.equal((await call("/api/services/actions/run", { planId: plan.id, token: plan.token, confirm: true })).status, 404);
  assert.deepEqual((await call(`${recipesPath}/scan`, {})).body, { found: 2, proposed: 0 });
  rmSync(`${root}/package.json`);
  assert.equal((await call(`${recipesPath}/decide`, decision)).status, 409);
});

test("recipe stream hello includes counts and approval publishes a recipe event", async (t) => {
  const { call, base } = await app(t);
  const recipe = (await call(`${recipesPath}?state=proposed`)).body.recipes[0];
  const abort = new AbortController();
  const response = await fetch(`${base}/api/services/live`, { signal: abort.signal });
  const reader = response.body!.getReader();
  t.after(() => abort.abort());
  let text = "";
  const until = async (pattern: RegExp) => {
    while (!pattern.test(text)) { const part = await reader.read(); assert.equal(part.done, false); text += new TextDecoder().decode(part.value); }
  };
  await until(/event: hello/);
  assert.match(text, /"recipes":\{"proposed":1,"approved":0\}/);
  await call(`${recipesPath}/decide`, { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true });
  await until(/event: recipe/);
  assert.match(text, /"change":"approved"/);
  abort.abort();
});

test("no-control keeps recipe GET and scan while disabling decisions and plans", async (t) => {
  const { call, db } = await app(t, true);
  const recipe = (await call(`${recipesPath}?state=proposed`)).body.recipes[0];
  for (const [path, body] of [[`${recipesPath}/decide`, { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true }], ["/api/services/actions/plan", { target: "recipe", id: recipe.id, action: "start" }]] as const) {
    const response = await call(path, body);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "control is off");
  }
  assert.equal((await call(`${recipesPath}/scan`, {})).status, 200);
  assert.equal(recipeById(db, recipe.id)!.state, "proposed");
});

test("a project description pass scans recipes after its fake source completes", async (t) => {
  const { call, descriptions } = await app(t, false, true);
  const finished = new Promise<void>((done) => descriptions!.subscribe((event) => { if (event.state === "done" || event.state === "failed") done(); }));
  await descriptions!.start("project");
  await finished;
  const listing = (await call(recipesPath)).body;
  assert.equal(listing.recipes.length, 3);
  assert.ok(listing.recipes.some((recipe: any) => recipe.source === "compose" && recipe.state === "proposed"));
});
