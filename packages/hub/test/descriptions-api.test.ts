import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { listListeners, listServices, ModelCapError, openCatalog, recordCloudflare, recordListeners, recordServices, setHandDescription, upsertMachine, type Description, type DescriptionProgress, type ModelRunner } from "@scout/core";
import { DescriptionRun } from "../src/descriptions.ts";
import { createAiModelRunner } from "../src/models.ts";
import { createHub } from "../src/server.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CogitatorError } from "@scout/ops";
import { createProjectDescriptionSource, type ProjectDescriptionSource } from "../src/descriptions-project.ts";
import { fakeGateway } from "../../ops/test/cogitator-gateway.ts";

const AT = "2026-10-07T17:00:00.000Z";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function setup(t: TestContext, model?: ModelRunner, project?: ProjectDescriptionSource) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "m", name: "Machine", os: "windows", kind: "host" });
  upsertMachine(db, { id: "other", name: "Other", os: "windows", kind: "host" });
  const fact = { kind: "windows-service" as const, name: "DemoService", displayName: "Demo background service", domain: "system" as const, program: "C:/Tools/demo.exe", state: "running" as const, startMode: "auto" as const, enabled: true, pid: 10, runAs: null, triggers: null, lastRun: null, lastResult: null };
  recordServices(db, "m", { origin: "services", status: "ok", facts: [fact, { ...fact, name: "OtherService", displayName: "OtherService", pid: 20, program: "C:/Tools/other.exe" }] }, AT);
  recordServices(db, "other", { origin: "services", status: "ok", facts: [fact] }, AT);
  recordListeners(db, "m", { origin: "listeners", status: "ok", facts: [
    { port: 8181, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 10, processName: "demo", processPath: "C:/Tools/demo.exe", container: null },
    { port: 8182, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 30, processName: "unjoined", processPath: "C:/Tools/unjoined.exe", container: null },
  ] }, AT);
  const descriptions = model || project ? new DescriptionRun(db, { model: model ?? (async () => "[]"), modelLabel: "internal-only-label", project }) : undefined;
  const server = createHub({ db, webRoot: "packages/hub/test", descriptions, streamHeartbeatMs: 20 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    db.close();
  });
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { db, descriptions, call, port };
}

test("hand edit POST returns effective descriptions and shared service edits apply across machines", async (t) => {
  const { db, call } = await setup(t);
  const id = listServices(db).find((row) => row.name === "DemoService")!.id;
  const edit = await call("POST", "/api/services/description", { target: "service", id, text: "The service keeps the shared cache up to date." });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.description.source, "hand");
  assert.equal(edit.body.description.hasHandEdit, true);
  assert.equal(listServices(db).filter((row) => row.name === "DemoService").every((row) => row.description?.source === "hand"), true);
  const listener = listListeners(db)[0]!;
  assert.equal(listener.description?.source, "hand");
  const clear = await call("POST", "/api/services/description", { target: "listener", id: listener.id, text: null });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.description.source, "os");
  assert.equal(clear.body.description.hasHandEdit, false);
  const unjoined = listListeners(db)[1]!;
  assert.equal((await call("POST", "/api/services/description", { target: "listener", id: unjoined.id, text: "The service runs the independent local endpoint." })).body.description.subject, "process:m:c:/tools/unjoined.exe");
  assert.equal((await call("POST", "/api/services/description", { target: "listener", id: unjoined.id, text: "" })).body.description, null);
});

test("hand edit POST rejects bad bodies and unknown ids", async (t) => {
  const { db, call } = await setup(t);
  const id = listServices(db)[0]!.id;
  const valid = { target: "service", id, text: "The service runs the independent local endpoint." };
  for (const body of [null, [], {}, { ...valid, target: "route" }, { ...valid, id: "1" }, { ...valid, id: -1 }, { ...valid, id: 1.2 }, { ...valid, text: 123 }, { ...valid, text: "short" }, { ...valid, text: "x".repeat(401) }, { ...valid, text: "line one\nline two" }, { target: "service", id }]) {
    assert.equal((await call("POST", "/api/services/description", body)).status, 400);
  }
  for (const target of ["service", "listener"]) {
    assert.deepEqual(await call("POST", "/api/services/description", { ...valid, target, id: 99999 }), { status: 404, body: { error: "not found" } });
  }
  assert.equal((await call("POST", "/api/services/description", valid, { origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await call("POST", "/api/services/description", valid, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("POST", "/api/services/description", { ...valid, text: "x".repeat(5000) })).status, 413);
  assert.equal((await call("GET", "/api/services/description")).status, 405);
});

test("description filters, comma lists, facets and text search apply on both lists", async (t) => {
  const { db, call } = await setup(t);
  setHandDescription(db, "service:windows-service:DemoService", "The service keeps the special cache up to date.");
  for (const [path, handCount, noneCount] of [["/api/services", 2, 1], ["/api/listeners", 1, 1]] as const) {
    const hand = await call("GET", `${path}?desc=hand`);
    assert.equal(hand.status, 200);
    assert.equal(hand.body.total, handCount);
    assert.ok(hand.body.facets.description.some((facet: { value: string; count: number; label: string }) => facet.value === "none" && facet.count === noneCount && facet.label === "none"));
    assert.equal((await call("GET", `${path}?desc=none`)).body.total, noneCount);
    assert.equal((await call("GET", `${path}?desc=hand,none`)).body.total, handCount + noneCount);
    assert.equal((await call("GET", `${path}?q=SPECIAL`)).body.total, handCount);
    assert.equal((await call("GET", `${path}?desc=public&q=SPECIAL`)).body.total, 0);
    assert.equal((await call("GET", `${path}?machine=m&desc=hand`)).body.total, 1);
  }
});

test("overview counts visible subjects once and reports the project scope as off", async (t) => {
  const { call } = await setup(t);
  const response = await call("GET", "/api/services/descriptions/overview");
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 3);
  assert.equal(response.body.described, 1);
  assert.deepEqual(response.body.bySource, { hand: 0, project: 0, install: 0, public: 0, os: 1, none: 2 });
  assert.deepEqual(response.body.public, { todo: 3, lastRunAt: null });
  assert.deepEqual(response.body.project, { state: "off", todo: 0, reason: "not configured", roots: 0, lastRunAt: null });
  assert.ok(Number.isFinite(Date.parse(response.body.generatedAt)));
});

test("refresh returns 202 on start, 200 while running and 404 for off scopes", async (t) => {
  let finish: (answer: string) => void = () => {};
  const { call, descriptions } = await setup(t, async () => new Promise<string>((resolve) => { finish = resolve; }));
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "public" }), { status: 202, body: { started: true } });
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "public" }), { status: 200, body: { started: false, reason: "running" } });
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "project" }), { status: 404, body: { error: "project descriptions are off" } });
  assert.equal((await call("POST", "/api/services/descriptions/refresh", { scope: "invalid" })).status, 400);
  assert.equal((await call("POST", "/api/services/descriptions/refresh", { scope: "public" }, { origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await call("GET", "/api/services/descriptions/refresh")).status, 405);
  finish(JSON.stringify([{ id: 0, description: "The service runs the public background data server.", confidence: 0.8 }]));
  await settle();
  assert.equal(descriptions!.status().state, "done");
  assert.equal(descriptions!.status().applied, 1);
  const overview = await call("GET", "/api/services/descriptions/overview");
  assert.ok(overview.body.public.lastRunAt);
  assert.equal(overview.body.public.todo, 2);
  const off = await setup(t);
  assert.deepEqual(await off.call("POST", "/api/services/descriptions/refresh", { scope: "public" }), { status: 404, body: { error: "descriptions model is off" } });
});

function stream(port: number, onEvent: (kind: string, body: any) => void) {
  const req = request({ host: "127.0.0.1", port, path: "/api/services/live" }, (res) => {
    let pending = "";
    res.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\n\n");
      while (end >= 0) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const kind = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (kind && data) onEvent(kind, JSON.parse(data));
        end = pending.indexOf("\n\n");
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return req;
}

test("the services stream adds hello.describe and emits description progress through completion", { timeout: 5000 }, async (t) => {
  const { call, port } = await setup(t, async () => JSON.stringify([{ id: 0, description: "The service runs the public background data server.", confidence: 0.8 }]));
  let helloResolve: (hello: any) => void = () => {};
  let doneResolve: () => void = () => {};
  const hello = new Promise<any>((resolve) => { helloResolve = resolve; });
  const done = new Promise<void>((resolve) => { doneResolve = resolve; });
  const events: DescriptionProgress[] = [];
  const req = stream(port, (kind, body) => {
    if (kind === "hello") helloResolve(body);
    if (kind === "describe") { events.push(body); if (body.state === "done") doneResolve(); }
  });
  t.after(() => req.destroy());
  assert.deepEqual((await hello).describe, { scope: "public", state: "idle", done: 0, total: 0, applied: 0, error: null, at: null });
  await call("POST", "/api/services/descriptions/refresh", { scope: "public" });
  await done;
  assert.deepEqual(events.map((event) => event.state), ["running", "running", "done"]);
  assert.deepEqual(Object.keys(events[0]!), ["scope", "state", "done", "total", "applied", "error", "at"]);
  assert.equal(events.at(-1)!.done, 3);
  assert.equal(events.at(-1)!.applied, 1);
  assert.equal(JSON.stringify(events).includes("internal-only-label"), false);
  req.destroy();
  let resolveLater: (hello: any) => void = () => {};
  const later = new Promise<any>((resolve) => { resolveLater = resolve; });
  const second = stream(port, (kind, body) => { if (kind === "hello") resolveLater(body); });
  t.after(() => second.destroy());
  assert.equal((await later).describe.state, "done");
  second.destroy();
});

test("hello.describe stays idle when no runner is configured", { timeout: 5000 }, async (t) => {
  const { port } = await setup(t);
  let finish: (hello: any) => void = () => {};
  const hello = new Promise<any>((resolve) => { finish = resolve; });
  const req = stream(port, (kind, body) => { if (kind === "hello") finish(body); });
  t.after(() => req.destroy());
  assert.equal((await hello).describe.state, "idle");
  req.destroy();
});

test("DescriptionRun emits failed progress when the real runner seam reaches its cap", async (t) => {
  const { db } = await setup(t);
  let calls = 0;
  const model = createAiModelRunner({ maxCallsPerHour: 0, toolkit: "fake-toolkit", routes: { public: "fake-public", internal: "fake-internal" }, spawnAi: async () => { calls++; return { exitCode: 0, stdout: "[]" }; } });
  const run = new DescriptionRun(db, { model });
  const events: DescriptionProgress[] = [];
  run.subscribe((event) => events.push(event));
  assert.equal(run.start("public").started, true);
  await settle();
  assert.equal(calls, 0);
  assert.equal(run.status().state, "failed");
  assert.match(run.status().error!, /hourly cap of 0/);
  assert.deepEqual(events.map((event) => event.state), ["running", "failed"]);
  assert.equal(await model({ task: "test", dataClass: "public", prompt: "public names" }), null);
  await assert.rejects(model({ task: "test", dataClass: "public", prompt: "public names", failOnCap: true }), ModelCapError);
});

test("route API rows carry the listener description and never serve a model label", async (t) => {
  const { db, call } = await setup(t);
  setHandDescription(db, "service:windows-service:DemoService", "The service keeps the shared cache up to date.");
  recordCloudflare(db, { tunnels: [{ id: "tunnel", name: "Machine", status: "healthy", connections: 1, remoteManaged: true }], ingress: [{ tunnelId: "tunnel", position: 0, hostname: "app.example.test", path: null, service: "http://localhost:8181" }], dns: [{ zone: "example.test", name: "other.example.test", type: "A", content: "203.0.113.1", proxied: false }] }, AT, null);
  const response = await call("GET", "/api/services/routes");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rows.find((row: { hostname: string }) => row.hostname === "app.example.test").description as Description, listListeners(db)[0]!.description);
  assert.equal(response.body.rows.find((row: { hostname: string }) => row.hostname === "other.example.test").description, null);
  assert.equal(JSON.stringify(response.body).includes("modelLabel"), false);
});

function projectFixture(t: TestContext) {
  const folder = mkdtempSync(join(process.cwd(), ".project-api-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const root = join(folder, "demo").replace(/\\/g, "/");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "Demo tracks installed versions.");
  const machinesPath = join(folder, "machines.json");
  writeFileSync(machinesPath, JSON.stringify({ machines: [{ id: "hub", transport: { type: "local" }, projectRoots: [root] }, { id: "other", transport: { type: "ssh", target: "unused" }, projectRoots: [root] }] }));
  return { folder, root, machinesPath };
}

test("project refresh returns 202, shares the run lock, sends project progress and keeps provenance internal", { timeout: 5000 }, async (t) => {
  const { folder, root, machinesPath } = projectFixture(t);
  const fake = fakeGateway();
  let finish: (response: Response) => void = () => {};
  fake.chat = () => new Promise<Response>((resolve) => { finish = resolve; });
  const project = await createProjectDescriptionSource({ dataDir: folder, machinesPath, key: async () => "fixture-client-credential", fetch: fake.fetch });
  const { db, call, port, descriptions } = await setup(t, undefined, project);
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordServices(db, "hub", { origin: "services", status: "ok", facts: [{ kind: "windows-service", name: "ProjectService", displayName: null, domain: "system", program: `${root}/run.exe`, state: "running", startMode: "auto", enabled: true, pid: 99, runAs: null, triggers: null, lastRun: null, lastResult: null }] }, AT);
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "project" }), { status: 202, body: { started: true } });
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "project" }), { status: 200, body: { started: false, reason: "running" } });
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "public" }), { status: 200, body: { started: false, reason: "running" } });
  let helloResolve: (value: any) => void = () => {};
  let doneResolve: () => void = () => {};
  const hello = new Promise<any>((resolve) => { helloResolve = resolve; });
  const done = new Promise<void>((resolve) => { doneResolve = resolve; });
  const events: DescriptionProgress[] = [];
  const req = stream(port, (kind, body) => {
    if (kind === "hello") helloResolve(body);
    if (kind === "describe") { events.push(body); if (body.state === "done") doneResolve(); }
  });
  t.after(() => req.destroy());
  const status = (await hello).describe;
  assert.equal(status.scope, "project");
  assert.equal(status.state, "running");
  assert.deepEqual(Object.keys(status), ["scope", "state", "done", "total", "applied", "error", "at"]);
  finish(Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Demo is a tool that tracks installed versions.", evidence: ["Demo tracks installed versions."], kind: "tool", confidence: 0, maker: "ignored" }) } }] }, { headers: { "x-cogitator-model": "internal-project-model" } }));
  await done;
  assert.equal(descriptions!.status().scope, "project");
  assert.equal(descriptions!.status().done, 1);
  assert.equal(descriptions!.status().applied, 1);
  assert.ok(events.every((event) => event.scope === "project"));
  const rows = (await call("GET", "/api/services?desc=project")).body;
  assert.equal(rows.total, 1);
  assert.equal(rows.rows[0].description.source, "project");
  assert.equal(rows.rows[0].description.confidence, 0.9);
  assert.deepEqual(rows.rows[0].description.evidence, ["Demo tracks installed versions."]);
  const overview = (await call("GET", "/api/services/descriptions/overview")).body;
  assert.equal(overview.bySource.project, 1);
  assert.equal(overview.project.state, "ready");
  assert.equal(overview.project.roots, 1);
  assert.equal(overview.project.todo, 0);
  assert.ok(overview.project.lastRunAt);
  const serialized = JSON.stringify({ rows, overview, events, status });
  assert.equal(serialized.includes("internal-project-model"), false);
  assert.equal(serialized.includes("fixture-client-credential"), false);
  req.destroy();
});

test("project refresh returns busy and overview uses the same cached probe", async (t) => {
  const { folder, machinesPath } = projectFixture(t);
  const fake = fakeGateway();
  fake.probe = () => Response.json({ state: "busy" }, { status: 503 });
  const project = await createProjectDescriptionSource({ dataDir: folder, machinesPath, key: async () => "fixture-client-credential", fetch: fake.fetch });
  const { call } = await setup(t, undefined, project);
  assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "project" }), { status: 200, body: { started: false, reason: "busy" } });
  for (let count = 0; count < 3; count++) {
    const overview = (await call("GET", "/api/services/descriptions/overview")).body;
    assert.deepEqual(overview.project, { state: "busy", todo: 1, reason: null, roots: 1, lastRunAt: null });
  }
  assert.equal(fake.calls.filter((call) => call.url.includes("/load?")).length, 1);
});

test("cached probes coalesce requests and refresh only after 30 seconds", async (t) => {
  const { root } = projectFixture(t);
  const { db } = await setup(t);
  let now = 1000;
  let calls = 0;
  let state = "ready";
  const project: ProjectDescriptionSource = { reason: null, projects: () => [{ machineId: "hub", name: "demo", root }], client: {
    role: "scout-describe", generate: async () => ({ answer: {}, servedBy: null }),
    probe: async () => { calls++; await settle(); if (state === "busy") throw new CogitatorError("busy", "Cogitator is busy"); if (state === "off") throw new Error("fixture-client-credential"); return {}; },
  } };
  const run = new DescriptionRun(db, { model: async () => "[]", project, now: () => now });
  const first = await Promise.all([run.overview(), run.overview(), run.overview()]);
  assert.equal(calls, 1);
  assert.equal(first[0]!.project.state, "ready");
  state = "busy";
  now += 29_999;
  assert.equal((await run.overview()).project.state, "ready");
  assert.equal(calls, 1);
  now++;
  assert.equal((await run.overview()).project.state, "busy");
  assert.equal(calls, 2);
  state = "off";
  now += 30_000;
  const off = (await run.overview()).project;
  assert.equal(off.state, "off");
  assert.equal(off.reason, "Cogitator is not running");
  await assert.rejects(run.start("project"), /project descriptions are off/);
  state = "ready";
  now += 30_000;
  assert.equal((await run.overview()).project.reason, null);
});

test("project descriptions are off for missing keys, missing discovery, non-local gateways and disabled models", async (t) => {
  const { folder, machinesPath } = projectFixture(t);
  for (const reason of ["no key", "gateway is not local", "Cogitator is not running", "not configured"] as const) {
    const fake = fakeGateway();
    writeFileSync(join(folder, "cogitator.json"), JSON.stringify(reason === "gateway is not local" ? { gateway: "https://outside.example" } : reason === "Cogitator is not running" ? { discoveryFile: "missing.json" } : reason === "not configured" ? { role: 5 } : {}));
    const project = await createProjectDescriptionSource({ dataDir: folder, machinesPath, key: async () => reason === "no key" ? null : "fixture-client-credential", fetch: fake.fetch });
    assert.equal(project.reason, reason);
    assert.equal(project.client, null);
    const { call } = await setup(t, undefined, project);
    assert.deepEqual(await call("POST", "/api/services/descriptions/refresh", { scope: "project" }), { status: 404, body: { error: "project descriptions are off" } });
    const overview = (await call("GET", "/api/services/descriptions/overview")).body;
    assert.equal(overview.project.reason, reason);
    assert.equal(overview.project.state, "off");
    assert.equal(overview.project.roots, 1);
    assert.equal(overview.project.todo, 1);
    assert.equal(JSON.stringify(overview).includes("fixture-client-credential"), false);
    assert.equal(fake.calls.length, 0);
  }
  const disabled = await setup(t);
  assert.equal((await disabled.call("POST", "/api/services/descriptions/refresh", { scope: "project" })).status, 404);
});

test("a project run emits failed status after three busy jobs with bounded waits", async (t) => {
  const { root } = projectFixture(t);
  const { db } = await setup(t);
  let probes = 0;
  const waits: number[] = [];
  const events: DescriptionProgress[] = [];
  const project: ProjectDescriptionSource = { reason: null, projects: () => [{ machineId: "hub", name: "demo", root }], client: {
    role: "scout-describe", generate: async () => ({ answer: {}, servedBy: null }), probe: async () => { if (++probes > 1) throw new CogitatorError("busy", "Cogitator is busy"); return {}; },
  } };
  const run = new DescriptionRun(db, { model: async () => "[]", project, wait: async (ms) => { waits.push(ms); } });
  run.subscribe((event) => events.push(event));
  assert.equal((await run.start("project")).started, true);
  await settle();
  assert.equal(run.status().state, "failed");
  assert.equal(run.status().error, "Cogitator is busy");
  assert.equal(probes, 4);
  assert.deepEqual(waits, [30_000, 30_000]);
  assert.deepEqual(events.map((event) => event.state), ["running", "failed"]);
});
