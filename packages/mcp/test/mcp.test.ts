import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { hubMachineId, listServices, openCatalog, recordServices, upsertMachine, type ServiceFact } from "@scout/core";
import { localPaths, type ControlRunnerDeps } from "@scout/ops";
import { McpServer, createTools, type Tool } from "../src/index.ts";

const AT = "2026-10-10T12:00:00.000Z";
const svc = (over: Partial<ServiceFact>): ServiceFact => ({ kind: "windows-service", name: "worker", displayName: "Worker", domain: "gui", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null, ...over });

function seed(t: TestContext, control: Partial<ControlRunnerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = localPaths(dir);
  mkdirSync(dirname(paths.db), { recursive: true });
  const db = openCatalog(paths.db);
  const machine = hubMachineId();
  upsertMachine(db, { id: machine, name: "Hub", os: "windows", kind: "host" });
  db.prepare("UPDATE machines SET state = 'reachable' WHERE kind = 'host'").run();
  recordServices(db, machine, { origin: "services", status: "ok", facts: [svc({ name: "Distinct", displayName: "Distinct Thing" }), svc({ name: "Sleeper", displayName: "Sleeper", state: "stopped" })] }, AT);
  const ids = Object.fromEntries(listServices(db).map((s) => [s.name, s.id]));
  db.close();
  const tools = createTools({ paths, now: () => AT, control: { machines: [{ id: machine, transport: { type: "local" } }], ...control } });
  const tool = (name: string): Tool => tools.find((item) => item.name === name)!;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => JSON.parse(JSON.stringify(await tool(name).run(args)));
  return { paths, ids, tools, tool, call, machine };
}

test("the server answers initialize, ping and tools/list, and ignores notifications", async (t) => {
  const { tools } = seed(t);
  const server = new McpServer({ name: "scout", version: "9.9.9", instructions: "hello" }, tools);
  const init: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.version, "9.9.9");
  assert.deepEqual(Object.keys(init.result.capabilities), ["tools"]);
  assert.equal(((await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any).result.protocolVersion, "2025-11-25");
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual(((await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" })) as any).result, {});
  const list: any = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const names = list.result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes("scout_status") && names.includes("scout_start_service") && names.includes("scout_plan_action"));
  assert.ok(["scout_competitors", "scout_competitor_queue", "scout_competitor_claim", "scout_competitor_complete", "scout_competitor_fail"].every((name) => names.includes(name)));
  assert.equal(list.result.tools.find((tool: { name: string }) => tool.name === "scout_competitors").annotations.readOnlyHint, true);
  assert.equal(list.result.tools.find((tool: { name: string }) => tool.name === "scout_competitor_claim").annotations.readOnlyHint, false);
  assert.ok(!names.some((name: string) => /stop|restart/.test(name)), "no tool carries out a stop or restart");
  assert.equal(list.result.tools.find((tool: { name: string }) => tool.name === "scout_start_service").annotations.readOnlyHint, false);
  assert.equal(list.result.tools.find((tool: { name: string }) => tool.name === "scout_status").annotations.readOnlyHint, true);
  assert.equal(((await server.handle({ jsonrpc: "2.0", id: 5, method: "nope" })) as any).error.code, -32601);
  assert.equal(((await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })) as any).error.code, -32602);
  assert.equal(((await server.handle({ nope: true })) as any).error.code, -32600);
});

test("the server reads one message per line, writes one reply per line, and survives garbage", async (t) => {
  const { tools } = seed(t);
  const server = new McpServer({ name: "scout", version: "1" }, tools);
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  const done = server.serve(input, output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scout_status", arguments: {} } })}\n`);
  input.write("this is not json\n\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  input.end();
  await done;
  const replies = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies.find((r) => r.id === 1).result.content[0].type, "text");
  assert.equal(replies.find((r) => r.id === null).error.code, -32700);
  assert.deepEqual(replies.find((r) => r.id === 2).result, {});
});

test("a tool that throws comes back as an error result, not a protocol error", async (t) => {
  const { tools } = seed(t);
  const server = new McpServer({ name: "scout", version: "1" }, tools);
  const reply: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scout_whois", arguments: { query: "70000" } } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /1 to 65535/);
  const bad: any = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scout_plan_action", arguments: { target: "service", id: 1, action: "delete" } } });
  assert.equal(bad.result.isError, true);
});

test("the read tools report status, rows, whois matches, outages, ports and the map", async (t) => {
  const { call, tool, machine } = seed(t);
  const status = await call("scout_status");
  assert.equal(status.machines[0].id, machine);
  const services = await call("scout_services", { state: "stopped" });
  assert.equal(services.total, 1);
  assert.equal(services.rows[0].name, "Sleeper");
  assert.deepEqual(services.rows[0].availableActions.includes("start"), true);
  assert.equal((await call("scout_services", { query: "distinct" })).rows[0].name, "Distinct Thing");
  assert.equal((await call("scout_whois", { query: "sleeper" })).matches[0].kind, "service");
  assert.equal((await call("scout_outages", { state: "open" })).open, 0);
  assert.deepEqual((await call("scout_ports")).ranges, []);
  assert.match(String(await tool("scout_systems_map").run({})), /^# Systems map/);
  await assert.rejects(Promise.resolve().then(() => tool("scout_services").run({ limit: 0 })), /limit/);
});

test("plan_action drafts a stop without a token and never carries it out", async (t) => {
  let executed = 0;
  const { call, ids } = seed(t, { exec: async () => { executed++; return { exitCode: 0, stdout: "", stderr: "" }; } });
  const out = await call("scout_plan_action", { target: "service", id: ids.Distinct, action: "stop" });
  assert.equal(out.carriedOut, false);
  assert.equal("token" in out.plan, false);
  assert.match(out.confirmWith, /control run service \d+ stop --yes/);
  assert.equal(executed, 0);
  const hard = await call("scout_plan_action", { target: "service", id: ids.Distinct, action: "stop", hard: true });
  assert.equal(hard.plan.hard, true);
  await assert.rejects(Promise.resolve().then(() => seed(t).tool("scout_plan_action").run({ target: "service", id: 1, action: "restart", hard: true })), /only for stop/);
});

test("start_service plans, runs and reports a start, and the audit log records it", async (t) => {
  let time = Date.parse(AT);
  let calls = 0;
  const { call, ids } = seed(t, {
    clock: { now: () => time, sleep: async (ms) => { time += ms; } },
    reader: async (_m, row) => ({ ...row, state: calls ? "running" : "stopped" }),
    exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  const out = await call("scout_start_service", { target: "service", id: ids.Sleeper });
  assert.equal(calls, 1);
  assert.equal(out.started, true);
  assert.equal(out.result.action, "start");
  assert.equal("token" in out, false);
  const log = await call("scout_action_log");
  assert.equal(log.items.length, 1);
  assert.equal(log.items[0].state, "done");
});

test("start_service refuses a row that is already running without executing anything", async (t) => {
  let calls = 0;
  const { call, ids } = seed(t, { reader: async (_m, row) => row, exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } });
  const out = await call("scout_start_service", { target: "service", id: ids.Distinct });
  assert.equal(out.started, false);
  assert.equal(out.plan.allowed, false);
  assert.equal(calls, 0);
  assert.equal((await call("scout_action_log")).items.length, 0);
  await assert.rejects(Promise.resolve().then(() => seed(t).tool("scout_start_service").run({ target: "service", id: 999999 })), /not found/);
});

test("plan_action drafts a disable for a person to confirm and start_service stays the only tool that acts", async (t) => {
  let executed = 0;
  const { call, ids, tool } = seed(t, { exec: async () => { executed++; return { exitCode: 0, stdout: "", stderr: "" }; } });
  const out = await call("scout_plan_action", { target: "service", id: ids.Distinct, action: "disable" });
  assert.equal(out.carriedOut, false);
  assert.equal("token" in out.plan, false);
  assert.equal(out.plan.action, "disable");
  assert.match(out.confirmWith, /control run service \d+ disable --yes/);
  assert.equal(executed, 0);
  assert.deepEqual((tool("scout_plan_action").inputSchema as any).properties.action.enum, ["start", "stop", "restart", "disable", "enable"]);
  assert.equal(tool("scout_start_service").readOnly, false);
  assert.equal(["scout_plan_action", "scout_start_service"].filter((name) => !tool(name).readOnly).length, 1);
});
