import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { listActions, openCatalog, recordServices, upsertMachine, type ServiceFact } from "@scout/core";
import { notifyServiceRead } from "@scout/ops";
import { createHub } from "../src/server.ts";

async function app(t: TestContext, off = false) {
  const root = mkdtempSync(resolve("ports-stack-hub-")).replace(/\\/g, "/");
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const facts: ServiceFact[] = ["First", "Last"].map((name) => ({ kind: "scheduled-task", name, displayName: null, domain: "gui", program: "C:/Tools/node.exe", state: "stopped", startMode: "manual", enabled: true, pid: null, runAs: null, triggers: null, lastRun: null, lastResult: null }));
  recordServices(db, "hub", { origin: "services", status: "ok", facts }, "2026-10-07T00:00:00Z");
  writeFileSync(`${root}/ports.json`, JSON.stringify({ ranges: [{ name: "dev", from: 4870, to: 4872 }, { name: "full", from: 1, to: 1 }], reserved: [{ port: 1, name: "fixture" }] }));
  writeFileSync(`${root}/stacks.json`, JSON.stringify({ stacks: [{ name: "dev", label: "Development", members: facts.map((fact) => ({ type: "service", machine: "hub", kind: fact.kind, name: fact.name })) }] }));
  let time = 0;
  const calls: string[] = [];
  const server = createHub({ db, webRoot: root, health: false, portsPath: `${root}/ports.json`, stacksPath: `${root}/stacks.json`, alerts: { alertsPath: `${root}/alerts.json` }, streamHeartbeatMs: 20,
    control: off ? false : {
      machines: [{ id: "hub", os: "windows", transport: { type: "local" } }], protectedPath: `${root}/protected.json`,
      clock: { now: () => time, sleep: async (ms) => { time += ms; } },
      exec: async (_transport, _argv, _timeout, _signal, env) => { calls.push(env!.SCOUT_NAME!); facts.find((fact) => fact.name === env!.SCOUT_NAME)!.state = "running"; return { exitCode: 0, stdout: "", stderr: "" }; },
      reader: async (_machine, row) => {
        recordServices(db, "hub", { origin: "services", status: "ok", facts }, new Date(time).toISOString());
        notifyServiceRead(db, "hub", new Date(time).toISOString());
        return { ...row, state: facts.find((fact) => fact.name === row.name)!.state };
      },
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); db.close(); rmSync(root, { recursive: true, force: true }); });
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { db, root, base, calls, call };
}

test("port and stack endpoints return contract fields, unknown ranges and full ranges", async (t) => {
  const f = await app(t);
  const ports = await f.call("/api/services/ports");
  assert.equal(ports.status, 200);
  assert.deepEqual(ports.body.ranges[0], { name: "dev", from: 4870, to: 4872, size: 3, usedCount: 0, freeCount: 3, used: [], next: 4870 });
  assert.deepEqual(ports.body.file, { path: ".scout-data/ports.json", exists: true, error: null });
  assert.deepEqual((await f.call("/api/services/ports/next?range=dev")).body, { range: "dev", port: 4870 });
  assert.deepEqual(await f.call("/api/services/ports/next?range=missing"), { status: 404, body: { error: "unknown range" } });
  assert.deepEqual(await f.call("/api/services/ports/next?range=full"), { status: 409, body: { error: "range is full" } });
  const stacks = await f.call("/api/services/stacks");
  assert.equal(stacks.status, 200);
  assert.equal(stacks.body.stacks[0].state, "ready");
  assert.deepEqual(stacks.body.stacks[0].members[0], { order: 1, type: "service", label: "First", machineId: "hub", detail: "scheduled task First", waitPort: null, waitSeconds: 30, running: false, available: true, reason: null });
  for (const path of ["/api/services/ports", "/api/services/ports/next", "/api/services/stacks"]) assert.equal((await f.call(path, {})).status, 405);
  writeFileSync(`${f.root}/ports.json`, "{broken");
  utimesSync(`${f.root}/ports.json`, 100, 100);
  const malformed = await f.call("/api/services/ports");
  assert.equal(malformed.body.ranges.length, 2);
  assert.match(malformed.body.file.error, /last good copy/);
});

test("stack control endpoints plan, validate, run and reject changed fingerprints", async (t) => {
  const f = await app(t);
  const body = { target: "stack", name: "dev", action: "start" };
  const planned = await f.call("/api/services/actions/plan", body);
  assert.equal(planned.status, 200);
  assert.equal(planned.body.plan.allowed, true);
  assert.equal(planned.body.plan.steps.length, 2);
  for (const action of ["stop", "restart", "unknown"]) assert.equal((await f.call("/api/services/actions/plan", { ...body, action })).body.plan.refusalKind, "unsupported");
  const unknown = await f.call("/api/services/actions/plan", { ...body, name: "unknown" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.plan.allowed, false);
  assert.equal(unknown.body.plan.refusalKind, "unknown");
  for (const invalid of [{ target: "stack", action: "start" }, { ...body, name: "BAD" }, { ...body, action: null }, { ...body, hard: "yes" }]) assert.equal((await f.call("/api/services/actions/plan", invalid)).status, 400);
  assert.equal((await f.call("/api/services/actions/plan", body, { origin: "https://outside.example" })).status, 403);
  f.db.prepare("UPDATE services SET program = 'C:/Tools/changed.exe' WHERE name = 'First'").run();
  assert.equal((await f.call("/api/services/actions/run", { planId: planned.body.plan.id, token: planned.body.plan.token, confirm: true })).status, 409);
  const plan = (await f.call("/api/services/actions/plan", body)).body.plan;
  const runBody = { planId: plan.id, token: plan.token, confirm: true };
  assert.equal((await f.call("/api/services/actions/run", { ...runBody, confirm: false })).status, 400);
  assert.equal((await f.call("/api/services/actions/run", runBody)).status, 202);
  for (let count = 0; count < 20 && listActions(f.db).some((row) => row.state === "running"); count++) await new Promise<void>((done) => setImmediate(done));
  const stack = listActions(f.db).find((row) => row.target === "stack")!;
  assert.equal(stack.state, "done");
  assert.equal(stack.message, "Started 2 of 2 members");
  assert.deepEqual(f.calls, ["First", "Last"]);
  assert.equal((await f.call("/api/services/actions/run", runBody)).status, 404);
});

test("the stack stream sends hello counts and changed states after live reads", async (t) => {
  const f = await app(t);
  const abort = new AbortController();
  const response = await fetch(`${f.base}/api/services/live`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
  const reader = response.body!.getReader();
  t.after(() => abort.abort());
  let text = "";
  const until = async (pattern: RegExp) => {
    while (!pattern.test(text)) { const part = await reader.read(); assert.equal(part.done, false); text += new TextDecoder().decode(part.value); }
  };
  await until(/event: hello/);
  assert.match(text, /"stacks":\{"total":1,"running":0\}/);
  const plan = (await f.call("/api/services/actions/plan", { target: "stack", name: "dev", action: "start" })).body.plan;
  await f.call("/api/services/actions/run", { planId: plan.id, token: plan.token, confirm: true });
  await until(/event: stack\ndata: \{"name":"dev","state":"running"\}/);
  assert.match(text, /event: stack\ndata: \{"name":"dev","state":"partial"\}/);
  assert.equal((text.match(/event: stack/g) ?? []).length, 2);
  abort.abort();
});

test("no-control keeps registry GET routes and stack stream counts while disabling plans", async (t) => {
  const f = await app(t, true);
  for (const path of ["/api/services/ports", "/api/services/stacks"]) assert.equal((await f.call(path)).status, 200);
  assert.equal((await f.call("/api/services/ports/next?range=dev")).status, 200);
  assert.deepEqual(await f.call("/api/services/actions/plan", { target: "stack", name: "dev", action: "start" }), { status: 404, body: { error: "control is off" } });
  assert.deepEqual(f.calls, []);
  const abort = new AbortController();
  const response = await fetch(`${f.base}/api/services/live`, { signal: abort.signal });
  const part = await response.body!.getReader().read();
  assert.match(new TextDecoder().decode(part.value), /"stacks":\{"total":1,"running":0\}/);
  abort.abort();
});
