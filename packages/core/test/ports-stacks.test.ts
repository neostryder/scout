import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { acknowledgeAlerts, actionById, alertsResponse, createAction, decideRecipe, evaluateAlerts, openCatalog, portsFileReader, portsResponse, recipeById, recipesResponse, recordListeners, recordServices, resolveStack, scanRecipes, SCHEMA_SQL, setAlertMute, stacksFileReader, stacksResponse, upsertMachine, validatePorts, validateStacks, type ListenerFact, type ServiceFact, type Stack } from "../src/index.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve("ports-core-")).replace(/\\/g, "/");
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  let stamp = 100;
  const put = (file: string, data: unknown, raw = false): void => {
    mkdirSync(resolve(root, file, ".."), { recursive: true });
    writeFileSync(`${root}/${file}`, raw ? String(data) : JSON.stringify(data));
    utimesSync(`${root}/${file}`, stamp, ++stamp);
  };
  const listeners = (facts: ListenerFact[], machine = "hub") => recordListeners(db, machine, { origin: "listeners", status: "ok", facts }, new Date(stamp * 1000).toISOString());
  return { db, root, put, listeners };
}
const listener = (port: number, processName = "node", container: ListenerFact["container"] = null): ListenerFact => ({ port, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 100, processName, processPath: `C:/Tools/${processName}.exe`, container });
const service: ServiceFact = { kind: "scheduled-task", name: "Task", displayName: null, domain: "gui", program: "C:/Tools/node.exe", state: "stopped", startMode: "manual", enabled: true, pid: null, runAs: null, triggers: null, lastRun: null, lastResult: null };
const stack: Stack = { name: "dev", label: "Development", members: [{ type: "service", machine: "hub", kind: "scheduled-task", name: "Task", waitSeconds: 30 }] };

for (const [entry, reason] of [
  [null, /object/], [{ name: "BAD", from: 1, to: 2 }, /name must/], [{ name: "x", from: 0, to: 2 }, /bounds/], [{ name: "x", from: 3, to: 2 }, /bounds/], [{ name: "x", from: 1.5, to: 2 }, /bounds/], [{ name: "x", from: 1, to: 65536 }, /bounds/], [{ name: "x", from: 1, to: 2, note: 5 }, /note/], [{ name: "x", from: 1, to: 2, note: "x".repeat(201) }, /note/],
] as const) test(`the port validator drops a range for ${reason.source} with ${JSON.stringify(entry)}`, () => {
  const result = validatePorts({ ranges: [entry] });
  assert.deepEqual(result.config.ranges, []);
  assert.match(result.fileError!, reason);
  assert.equal(result.fileError!.split(". ").length, 1);
});

for (const [entry, reason] of [
  [null, /object/], [{ port: 0, name: "hub" }, /port must/], [{ port: 65536, name: "hub" }, /port must/], [{ port: 1.5, name: "hub" }, /port must/], [{ port: 1 }, /name/], [{ port: 1, name: "" }, /name/], [{ port: 1, name: "hub", match: false }, /match/], [{ port: 1, name: "hub", note: "x".repeat(201) }, /note/],
] as const) test(`the port validator drops a reservation for ${reason.source} with ${JSON.stringify(entry)}`, () => {
  const result = validatePorts({ reserved: [entry] });
  assert.deepEqual(result.config.reserved, []);
  assert.match(result.fileError!, reason);
});

test("the port validator drops duplicate names, overlapping bounds and duplicate reserved ports", () => {
  const result = validatePorts({ ranges: [{ name: "dev", from: 10, to: 20 }, { name: "dev", from: 30, to: 40 }, { name: "overlap", from: 20, to: 25 }, { name: "adjacent", from: 21, to: 30 }], reserved: [{ port: 10, name: "one" }, { port: 10, name: "two" }] });
  assert.deepEqual(result.config.ranges.map((row) => row.name), ["dev", "adjacent"]);
  assert.equal(result.config.reserved.length, 1);
  assert.match(result.fileError!, /name is duplicated.*overlaps.*port is duplicated/);
});

test("registry validation enforces both entry limits without dropping valid earlier entries", () => {
  const result = validatePorts({ ranges: Array.from({ length: 33 }, (_, index) => ({ name: `range-${index}`, from: index + 1, to: index + 1 })), reserved: Array.from({ length: 257 }, (_, index) => ({ name: "port", port: index + 1 })) });
  assert.equal(result.config.ranges.length, 32);
  assert.equal(result.config.reserved.length, 256);
  assert.match(result.fileError!, /32 ranges.*256 reserved/);
  const stacks = validateStacks({ stacks: Array.from({ length: 33 }, (_, index) => ({ ...stack, name: `stack-${index}` })) });
  assert.equal(stacks.config.length, 32);
  assert.match(stacks.fileError!, /32 stacks/);
});

for (const type of ["ports", "stacks"] as const) test(`${type} file reads cache, retain the last good copy and reset after removal`, (t) => {
  const f = fixture(t);
  const file = `${type}.json`;
  const read = type === "ports" ? portsFileReader(`${f.root}/${file}`) : stacksFileReader(`${f.root}/${file}`);
  assert.equal(read().exists, false);
  assert.equal(read().fileError, null);
  f.put(file, type === "ports" ? { ranges: [{ name: "dev", from: 1, to: 2 }] } : { stacks: [stack] });
  const good = read();
  assert.equal(read(), good);
  f.put(file, "{broken", true);
  assert.deepEqual(read().config, good.config);
  assert.match(read().fileError!, /last good copy/);
  f.put(file, []);
  assert.deepEqual(read().config, good.config);
  assert.ok(read().fileError);
  rmSync(`${f.root}/${file}`);
  assert.equal(read().exists, false);
  assert.equal(read().fileError, null);
});

test("port responses count distinct Hub listeners and exclude reservations and recipe claims from next", (t) => {
  const f = fixture(t);
  f.put("ports.json", { ranges: [{ name: "dev", from: 4870, to: 4875, note: "fixture" }], reserved: [{ port: 4870, name: "hub", match: "NODE" }, { port: 4875, name: "free" }] });
  f.put(".claude/launch.json", { configurations: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: ["app.js"], port: 4872 }] });
  scanRecipes(f.db, [{ machineId: "hub", name: "fixture", root: f.root }]);
  f.listeners([listener(4870), { ...listener(4870), address: "0.0.0.0", bind: "all" }, listener(4871)]);
  f.listeners([listener(4873)], "mini");
  const read = portsFileReader(`${f.root}/ports.json`);
  const response = portsResponse(f.db, read(), "fixture-time");
  assert.deepEqual(response.ranges[0], { name: "dev", from: 4870, to: 4875, note: "fixture", size: 6, usedCount: 2, freeCount: 4, used: [4870, 4871], next: 4873 });
  assert.equal(response.reserved[0]!.state, "listening");
  assert.equal(response.reserved[1]!.state, "free");
  assert.equal(response.reserved[1]!.match, null);
  assert.equal(response.generatedAt, "fixture-time");
  f.listeners([listener(4870), listener(4871), listener(4873), listener(4874)]);
  assert.equal(portsResponse(f.db, read()).ranges[0]!.next, null);
  const recipe = recipesResponse(f.db).recipes[0]!;
  decideRecipe(f.db, { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true });
  assert.equal(portsResponse(f.db, read()).ranges[0]!.next, null);
  decideRecipe(f.db, { id: recipe.id, hash: recipe.hash, decision: "reject", confirm: true });
  assert.equal(portsResponse(f.db, read()).ranges[0]!.next, 4872);
});

test("clashes use process and container matches, ignore gone recipes and resolve acknowledged or muted alerts", (t) => {
  const f = fixture(t);
  f.put("ports.json", { reserved: [{ port: 4870, name: "hub", match: "node" }] });
  for (const folder of ["one", "two"]) f.put(`${folder}/.claude/launch.json`, { configurations: [{ name: "dev", runtimeExecutable: "node.exe", runtimeArgs: ["app.js"], port: 4870 }] });
  scanRecipes(f.db, ["one", "two"].map((name) => ({ machineId: "hub", name, root: `${f.root}/${name}` })));
  const recipes = recipesResponse(f.db).recipes;
  decideRecipe(f.db, { id: recipes[0]!.id, hash: recipes[0]!.hash, decision: "approve", confirm: true });
  f.listeners([listener(4870, "python")]);
  const read = portsFileReader(`${f.root}/ports.json`);
  const response = portsResponse(f.db, read());
  assert.equal(response.reserved[0]!.state, "clash");
  assert.deepEqual(response.clashes.map((row) => row.kind), ["reserved-taken", "recipe-port-taken", "recipe-port-shared"]);
  assert.equal(response.clashes[0]!.key, "reserved:4870");
  const options = { loadPorts: read };
  evaluateAlerts(f.db, "2026-10-07T00:00:00Z", options);
  const alerts = alertsResponse(f.db, new URLSearchParams("kind=port-clash")).alerts;
  assert.equal(alerts.length, 3);
  assert.ok(alerts.every((row) => row.key.startsWith("port-clash:") && row.title === "Port clash: 4870"));
  assert.equal(alerts.find((row) => row.key === "port-clash:shared:4870")!.severity, "warn");
  assert.equal(alerts.find((row) => row.key === "port-clash:reserved:4870")!.severity, "high");
  acknowledgeAlerts(f.db, { all: true, kind: "port-clash" });
  setAlertMute(f.db, { key: "port-clash:shared:4870" });
  evaluateAlerts(f.db, "2026-10-07T00:01:00Z", options);
  assert.equal(alertsResponse(f.db, new URLSearchParams("kind=port-clash&state=all&include=muted")).alerts.length, 3);
  f.listeners([listener(4870, "python", { name: "NODE-container", image: "fixture", containerPort: 80 })]);
  assert.deepEqual(portsResponse(f.db, read()).clashes.map((row) => row.kind), ["recipe-port-shared"]);
  decideRecipe(f.db, { id: recipes[1]!.id, hash: recipes[1]!.hash, decision: "reject", confirm: true });
  evaluateAlerts(f.db, "2026-10-07T00:02:00Z", options);
  assert.ok(alertsResponse(f.db, new URLSearchParams("kind=port-clash&state=all&include=muted")).alerts.every((row) => row.state === "resolved"));
  f.listeners([listener(4870, "node")]);
  assert.equal(portsResponse(f.db, read()).clashes.length, 0);
  f.listeners([listener(4870, "two-worker")]);
  assert.deepEqual(portsResponse(f.db, read()).clashes.map((row) => row.kind), ["reserved-taken"]);
  f.db.prepare("UPDATE launch_recipes SET gone_at = 'fixture'").run();
  f.listeners([]);
  assert.equal(portsResponse(f.db, read()).clashes.length, 0);
});

for (const [entry, reason] of [
  [null, /object/], [{ ...stack, name: "BAD" }, /name/], [{ ...stack, label: null }, /label/], [{ ...stack, members: [] }, /1 to 12/], [{ ...stack, members: Array(13).fill(stack.members[0]) }, /1 to 12/], [{ ...stack, members: [null] }, /member 1.*object/], [{ ...stack, members: [{ ...stack.members[0], waitPort: 65536 }] }, /waitPort/], [{ ...stack, members: [{ ...stack.members[0], waitSeconds: 4 }] }, /waitSeconds/], [{ ...stack, members: [{ ...stack.members[0], waitSeconds: 121 }] }, /waitSeconds/], [{ ...stack, members: [{ ...stack.members[0], waitSeconds: 5.5 }] }, /waitSeconds/], [{ ...stack, members: [{ ...stack.members[0], name: "" }] }, /name/], [{ ...stack, members: [{ ...stack.members[0], kind: "unknown" }] }, /service kind/], [{ ...stack, members: [{ ...stack.members[0], machine: null }] }, /machine/], [{ ...stack, members: [{ type: "recipe", project: "one", source: "bad", name: "dev" }] }, /recipe source/], [{ ...stack, members: [{ type: "recipe", source: "package-json", name: "dev" }] }, /project/], [{ ...stack, members: [{ type: "other", name: "dev" }] }, /type/],
] as const) test(`the stack validator drops an entry for ${reason.source} with ${JSON.stringify(entry)}`, () => {
  const result = validateStacks({ stacks: [entry] });
  assert.deepEqual(result.config, []);
  assert.match(result.fileError!, reason);
});

test("stack validation preserves wait bounds, defaults and exact identities and drops duplicate names", () => {
  const result = validateStacks({ stacks: [{ ...stack, members: [{ type: "recipe", project: "one", source: "compose", name: "compose.yaml" }, { ...stack.members[0], waitPort: 1, waitSeconds: 5 }, { ...stack.members[0], waitPort: 65535, waitSeconds: 120 }] }, stack] });
  assert.equal(result.config.length, 1);
  assert.equal(result.config[0]!.members[0]!.waitSeconds, 30);
  assert.match(result.fileError!, /duplicated/);
  assert.throws(() => validateStacks({ stacks: {} }));
  for (const invalid of [null, [], { ranges: {} }, { reserved: false }]) assert.throws(() => validatePorts(invalid));
});

test("stack responses resolve exact service and recipe identities and every state", (t) => {
  const f = fixture(t);
  f.put(".claude/launch.json", { configurations: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: ["app.js"], port: 4870 }, { name: "unknown", runtimeExecutable: "node", runtimeArgs: ["app.js"] }] });
  const project = { machineId: "hub", name: "fixture", root: f.root };
  scanRecipes(f.db, [project]);
  const recipes = recipesResponse(f.db).recipes;
  const recipe = recipes.find((row) => row.name === "dev")!;
  const configured: Stack = { ...stack, members: [...stack.members, { type: "recipe", project: recipe.project, source: "launch-json", name: "dev", waitSeconds: 30 }] };
  assert.equal(resolveStack(f.db, configured).state, "blocked");
  recordServices(f.db, "hub", { origin: "services", status: "ok", facts: [service] }, "2026-10-07T00:00:00Z");
  assert.equal(resolveStack(f.db, configured).members[1]!.reason, "The recipe needs approval.");
  decideRecipe(f.db, { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true });
  assert.equal(resolveStack(f.db, configured).state, "ready");
  recordServices(f.db, "hub", { origin: "services", status: "ok", facts: [{ ...service, state: "running" }] }, "2026-10-07T00:01:00Z");
  assert.equal(resolveStack(f.db, configured).state, "partial");
  f.listeners([listener(4870)]);
  assert.equal(resolveStack(f.db, configured).state, "running");
  f.db.prepare("UPDATE launch_recipes SET gone_at = 'fixture' WHERE id = ?").run(recipe.id);
  assert.equal(resolveStack(f.db, configured).state, "blocked");
  assert.equal(resolveStack(f.db, configured).members[1]!.reason, "The recipe source is gone.");
  assert.equal(resolveStack(f.db, { ...stack, members: [{ ...stack.members[0]!, name: "missing" }] }).members[0]!.reason, "No such service.");
  assert.equal(resolveStack(f.db, { ...stack, members: [{ type: "recipe", project: "missing", source: "package-json", name: "dev", waitSeconds: 30 }] }).members[0]!.reason, "No such recipe.");
  const unknown = recipes.find((row) => row.name === "unknown")!;
  decideRecipe(f.db, { id: unknown.id, hash: unknown.hash, decision: "approve", confirm: true });
  const withoutPort = resolveStack(f.db, { ...stack, members: [{ type: "recipe", project: unknown.project, source: "launch-json", name: "unknown", waitSeconds: 30 }] });
  assert.equal(withoutPort.state, "ready");
  assert.equal(withoutPort.members[0]!.running, null);
  f.put("stacks.json", { stacks: [configured] });
  const response = stacksResponse(f.db, stacksFileReader(`${f.root}/stacks.json`)());
  assert.equal("rowId" in response.stacks[0]!.members[0]!, false);
  assert.equal(response.file.path, ".scout-data/stacks.json");
  assert.equal(recipeById(f.db, recipe.id)!.gone, true);
});

test("the stack audit migration preserves recipe and service rows and their plan JSON", (t) => {
  const f = fixture(t);
  const path = `${f.root}/audit.db`;
  const db = openCatalog(path);
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const legacy = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS actions \([\s\S]*?\n\);/)![0].replace("'service','listener','recipe','stack'", "'service','listener','recipe'");
  db.exec("DROP TABLE actions");
  db.exec(legacy);
  const audits = (["service", "recipe"] as const).map((target) => createAction(db, { at: "fixture", finishedAt: null, machineId: "hub", target, rowId: 1, name: "fixture", action: "start", hard: false, mechanism: "recipe", command: "node app.js", admin: "none", state: "done", exitCode: 0, message: "fixture" }, { member: target }));
  db.close();
  const reopened = openCatalog(path);
  try {
    for (const audit of audits) {
      assert.deepEqual(actionById(reopened, audit.id), audit);
      assert.equal(reopened.prepare("SELECT plan_json FROM actions WHERE id = ?").get(audit.id)!.plan_json, JSON.stringify({ member: audit.target }));
    }
    assert.equal(createAction(reopened, { ...audits[0]!, target: "stack", rowId: 0, mechanism: "stack" }, {}).target, "stack");
  } finally { reopened.close(); }
});

test("the disable and enable audit migration keeps older audit rows and accepts the new actions", (t) => {
  const f = fixture(t);
  const path = `${f.root}/audit-startup.db`;
  const db = openCatalog(path);
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const legacy = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS actions \([\s\S]*?\n\);/)![0].replace("CHECK (action IN ('start','stop','restart','disable','enable'))", "CHECK (action IN ('start','stop','restart'))");
  assert.notEqual(legacy, SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS actions \([\s\S]*?\n\);/)![0]);
  db.exec("DROP TABLE actions");
  db.exec(legacy);
  const old = createAction(db, { at: "fixture", finishedAt: null, machineId: "hub", target: "service", rowId: 1, name: "fixture", action: "stop", hard: false, mechanism: "launchd", command: "launchctl kill", admin: "none", state: "done", exitCode: 0, message: "stopped" }, { kept: true });
  assert.throws(() => createAction(db, { ...old, action: "disable" }, {}));
  db.close();
  const reopened = openCatalog(path);
  try {
    assert.deepEqual(actionById(reopened, old.id), old);
    assert.equal(createAction(reopened, { ...old, action: "disable" }, {}).action, "disable");
    assert.equal(createAction(reopened, { ...old, action: "enable" }, {}).action, "enable");
  } finally { reopened.close(); }
});
