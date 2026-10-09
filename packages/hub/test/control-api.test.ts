import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listServices, openCatalog, recordListeners, recordServices, upsertMachine, type ControlRow, type ServiceFact } from "@scout/core";
import type { ControlPlan, ControlRunnerDeps } from "@scout/ops";
import { createHub } from "../src/server.ts";

const T = "2026-10-07T00:00:00Z";
const fact: ServiceFact = { kind: "windows-service", name: "DistinctService", displayName: "Distinct service", domain: "gui", program: "C:/Tools/distinct.exe", state: "running", startMode: "manual", enabled: true, pid: 734, runAs: null, triggers: null, lastRun: null, lastResult: null };
type Reply = { status: number; body: Record<string, any> };

async function app(t: TestContext, options: { off?: boolean; sudo?: boolean; deps?: Partial<ControlRunnerDeps> } = {}) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordServices(db, "hub", { origin: "services", status: "ok", facts: [fact, { ...fact, name: "cloudflared", pid: 735 }] }, T);
  recordServices(db, "mini", { origin: "services", status: "ok", facts: [{ ...fact, kind: "launchd", name: "com.example.worker", domain: "system", program: "/opt/worker", pid: 40 }] }, T);
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 8800, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 734, processName: "distinct", processPath: "C:/Tools/distinct.exe", container: null }, { port: 8801, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 900, processName: "bare", processPath: "C:/Tools/bare.exe", container: null }] }, T);
  const root = mkdtempSync(join(tmpdir(), "scout-control-api-"));
  const protectedPath = join(root, "protected.json");
  let time = Date.parse(T);
  let calls = 0;
  let sudoReads = 0;
  const deps: ControlRunnerDeps = {
    machines: [{ id: "hub", os: "windows", transport: { type: "local" } }, { id: "mini", os: "macos", transport: { type: "ssh", target: "fixture-host" } }],
    protectedPath,
    clock: { now: () => time, sleep: async (ms) => { time += ms; } },
    exec: async (_transport, _argv, _timeout, _signal, env) => { calls++; db.prepare("UPDATE services SET state = 'stopped' WHERE name = ?").run(env!.SCOUT_NAME!); return { exitCode: 0, stdout: "", stderr: "" }; },
    reader: async (_machine, row) => {
      if (options.sudo && row.machineId === "mini") { sudoReads++; return { ...row, state: sudoReads > 2 ? "stopped" : "running" }; }
      const stored = listServices(db).find((s) => s.id === (row.serviceId ?? row.id));
      return stored ? { ...row, state: stored.state } : row;
    },
    ...options.deps,
  };
  const server = createHub({ db, webRoot: root, control: options.off ? false : deps, streamHeartbeatMs: 20 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); db.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<Reply> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => resolve({ status: res.statusCode!, body: raw.startsWith("{") ? JSON.parse(raw) : { text: raw } }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { db, port, protectedPath, call, calls: () => calls, id: listServices(db).find((s) => s.name === "DistinctService")!.id, macId: listServices(db).find((s) => s.kind === "launchd")!.id };
}
const planPath = "/api/services/actions/plan";
const runPath = "/api/services/actions/run";
function planOf(reply: Reply): ControlPlan & { id: string; token: string } {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.plan.allowed, true);
  assert.equal(typeof reply.body.plan.id, "string");
  assert.equal(typeof reply.body.plan.token, "string");
  return reply.body.plan;
}

test("plan routes return allowed plans, protected refusals, validation errors and unknown rows", async (t) => {
  const { call, id, db } = await app(t);
  const plan = planOf(await call(planPath, { target: "service", id, action: "stop", hard: false }));
  assert.equal(plan.mechanism, "windows-service");
  assert.equal("argv" in plan || "env" in plan || "transport" in plan, false);
  assert.ok(plan.effects.includes("Stops the listener on port 8800"));
  const protectedId = listServices(db).find((s) => s.name === "cloudflared")!.id;
  const refusal = await call(planPath, { target: "service", id: protectedId, action: "restart" });
  assert.equal(refusal.status, 200);
  assert.equal(refusal.body.plan.refusalKind, "protected");
  assert.equal(refusal.body.plan.token, null);
  for (const body of [{ target: "bad", id, action: "stop" }, { target: "service", id: "1", action: "stop" }, { target: "service", id: -1, action: "stop" }, { target: "service", id, action: "bad" }, { target: "service", id, action: "start", hard: true }, { target: "service", id, action: "stop", hard: "yes" }]) assert.equal((await call(planPath, body)).status, 400);
  assert.equal((await call(planPath, { target: "service", id: 999, action: "stop" })).status, 404);
  assert.equal((await call(planPath, "[]")).status, 400);
  assert.equal((await call(planPath, "{")).status, 400);
  assert.equal((await call(planPath)).status, 405);
});

test("run routes require confirmation, return 202, reject reuse and list audit rows without tokens", async (t) => {
  const { call, id, calls } = await app(t);
  const plan = planOf(await call(planPath, { target: "service", id, action: "stop" }));
  assert.equal((await call(runPath, { planId: plan.id, token: plan.token, confirm: false })).status, 400);
  assert.equal((await call(runPath, { planId: plan.id, token: "wrong", confirm: true })).status, 404);
  assert.equal((await call(runPath, { planId: "missing", token: "wrong", confirm: true })).status, 404);
  const run = await call(runPath, { planId: plan.id, token: plan.token, confirm: true });
  assert.equal(run.status, 202);
  assert.equal(run.body.state, "running");
  assert.equal(calls(), 1);
  assert.equal((await call(runPath, { planId: plan.id, token: plan.token, confirm: true })).status, 404);
  const log = await call("/api/services/actions?machine=hub&limit=1");
  assert.equal(log.status, 200);
  assert.equal(log.body.items.length, 1);
  assert.equal(log.body.items[0].state, "done");
  assert.equal(log.body.items[0].id, run.body.actionId);
  assert.equal("token" in log.body.items[0], false);
  assert.equal((await call("/api/services/actions?machine=mini")).body.items.length, 0);
  for (const limit of ["0", "201", "1.5", "bad"]) assert.equal((await call(`/api/services/actions?limit=${limit}`)).status, 400);
});

test("run returns 409 when the catalog identity or protected file changes", async (t) => {
  const { call, id, db, calls, protectedPath } = await app(t);
  const plan = planOf(await call(planPath, { target: "service", id, action: "stop" }));
  db.prepare("UPDATE services SET pid = 998 WHERE id = ?").run(id);
  const changed = await call(runPath, { planId: plan.id, token: plan.token, confirm: true });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "changed since the plan");
  const next = planOf(await call(planPath, { target: "service", id, action: "stop" }));
  writeFileSync(protectedPath, JSON.stringify({ disable: [], names: [{ machine: "hub", match: "Distinct*", reason: "This workload needs the service." }] }));
  utimesSync(protectedPath, new Date(1000), new Date(1000));
  assert.equal((await call(runPath, { planId: next.id, token: next.token, confirm: true })).status, 409);
  assert.equal(calls(), 0);
});

test("sudo run returns 200 waiting and its audit confirms without execution", async (t) => {
  const { call, macId, calls } = await app(t, { sudo: true });
  const plan = planOf(await call(planPath, { target: "service", id: macId, action: "stop" }));
  const run = await call(runPath, { planId: plan.id, token: plan.token, confirm: true });
  assert.equal(run.status, 200);
  assert.equal(run.body.state, "waiting");
  assert.equal(run.body.sudoCommand, "sudo launchctl kill SIGTERM system/com.example.worker");
  assert.equal(calls(), 0);
  assert.equal((await call("/api/services/actions?machine=mini")).body.items[0].state, "confirmed");
});

test("protected and uninstall GET routes return contract fields and unknown targets return 404", async (t) => {
  const { call, id } = await app(t);
  const protection = await call("/api/services/protected");
  assert.equal(protection.status, 200);
  assert.equal(protection.body.file, ".scout-data/protected.json");
  assert.equal(protection.body.groups.length, 8);
  assert.ok(protection.body.fileError);
  const uninstall = await call(`/api/services/uninstall?target=service&id=${id}`);
  assert.equal(uninstall.status, 200);
  assert.equal(uninstall.body.note, "Scout never runs an uninstall.");
  assert.equal(uninstall.body.command, "sc.exe delete DistinctService");
  const bare = await call("/api/services/uninstall?target=listener&id=2");
  assert.equal(bare.status, 200);
  assert.equal(bare.body.available, false);
  assert.deepEqual(bare.body.steps, []);
  assert.equal((await call("/api/services/uninstall?target=service&id=999")).status, 404);
  assert.equal((await call("/api/services/uninstall?target=bad&id=1")).status, 400);
});

test("lists add control for services, joined listeners and bare processes without executing planners", async (t) => {
  const { call, calls } = await app(t, { deps: { reader: async () => { throw new Error("A list must not read live state."); } } });
  const services = await call("/api/services?all=1");
  assert.equal(services.status, 200);
  assert.ok(services.body.rows.every((r: { control: unknown }) => r.control));
  assert.equal(services.body.rows.find((r: { name: string }) => r.name === "cloudflared").control.protected.group, "cloudflared");
  const listeners = await call("/api/listeners?all=1");
  assert.equal(listeners.body.rows[0].control.mechanism, "windows-service");
  assert.equal(listeners.body.rows[1].control.mechanism, "process");
  assert.equal(listeners.body.rows[1].control.actions[0].available, false);
  assert.equal(calls(), 0);
});

test("disabled control refuses both POST routes and marks every row action off", async (t) => {
  const { call, id, calls } = await app(t, { off: true });
  for (const path of [planPath, runPath]) {
    const reply = await call(path, { target: "service", id, action: "stop" });
    assert.equal(reply.status, 404);
    assert.equal(reply.body.error, "control is off");
  }
  for (const path of ["/api/services?all=1", "/api/listeners?all=1"]) {
    const list = await call(path);
    assert.ok(list.body.rows.every((r: { control: { actions: { available: boolean; reason: string }[] } }) => r.control.actions.every((a) => !a.available && a.reason === "Control is off.")));
  }
  assert.equal((await call("/api/services/actions")).status, 200);
  assert.equal(calls(), 0);
  const entry = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(entry, /args.includes\("--no-control"\) \? false/);
});

test("control POST routes use the existing host, origin, JSON and body limits", async (t) => {
  const { call, id } = await app(t);
  const body = { target: "service", id, action: "stop" };
  assert.equal((await call(planPath, body, { origin: "https://outside.test" })).status, 403);
  assert.equal((await call(planPath, body, { host: "outside.test" })).status, 421);
  assert.equal((await call(planPath, body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call(planPath, { ...body, padding: "x".repeat(5000) })).status, 413);
});

test("the services stream adds hello.actions and ordered action records", async (t) => {
  const { call, id, port } = await app(t);
  const events: { kind: string; data: Record<string, any> }[] = [];
  let buffer = "";
  let notify: (() => void) | null = null;
  const stream = request({ hostname: "127.0.0.1", port, path: "/api/services/live" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (part: string) => {
      buffer += part;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const kind = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (kind && data) events.push({ kind, data: JSON.parse(data) });
      }
      notify?.();
    });
  });
  stream.on("error", () => undefined);
  stream.end();
  t.after(() => stream.destroy());
  const until = (predicate: () => boolean): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { notify = null; reject(new Error("The test stream timed out.")); }, 2000);
    notify = () => { if (predicate()) { clearTimeout(timer); notify = null; resolve(); } };
    notify();
  });
  await until(() => events.some((e) => e.kind === "hello"));
  assert.deepEqual(events.find((e) => e.kind === "hello")!.data.actions, { running: 0 });
  const plan = planOf(await call(planPath, { target: "service", id, action: "stop" }));
  await call(runPath, { planId: plan.id, token: plan.token, confirm: true });
  await until(() => events.filter((e) => e.kind === "action").length === 2);
  assert.deepEqual(events.filter((e) => e.kind === "action").map((e) => e.data.state), ["running", "done"]);
  stream.destroy();
});
