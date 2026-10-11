import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listServices, openCatalog, recordListeners, recordServices, upsertMachine, type ServiceFact } from "@scout/core";
import type { ControlRunnerDeps } from "@scout/ops";
import { controlCommand } from "../src/control.ts";

function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const fact: ServiceFact = { kind: "windows-service", name: "DistinctService", displayName: null, domain: "gui", program: "C:/Tools/distinct.exe", state: "running", startMode: "manual", enabled: true, pid: 734, runAs: null, triggers: null, lastRun: null, lastResult: null };
  recordServices(db, "hub", { origin: "services", status: "ok", facts: [fact] }, "2026-10-07T00:00:00Z");
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 8800, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 734, processName: "distinct", processPath: "C:/Tools/distinct.exe", container: null }] }, "2026-10-07T00:00:00Z");
  return { db, id: String(listServices(db)[0]!.id) };
}

test("control plan prints the plan without a token and reads no live state or executable", async (t) => {
  const { db, id } = seed(t);
  const lines: string[] = [];
  const deps: ControlRunnerDeps = { machines: [{ id: "hub", transport: { type: "local" } }], reader: async () => { throw new Error("The plan must read the catalog only."); }, exec: async () => { throw new Error("The plan must not execute."); } };
  await controlCommand(db, ["plan", "service", id, "stop", "--hard"], { deps, write: (line) => { lines.push(line); } });
  const plan = JSON.parse(lines[0]!);
  assert.equal(plan.allowed, true);
  assert.equal(plan.hard, true);
  assert.equal("token" in plan || "argv" in plan || "env" in plan, false);
  await controlCommand(db, ["plan", "listener", "1", "stop"], { deps, write: (line) => { lines.push(line); } });
  assert.equal(JSON.parse(lines[1]!).mechanism, "windows-service");
});

test("control run refuses without --yes before any live read or execution", async (t) => {
  const { db, id } = seed(t);
  const deps: ControlRunnerDeps = { machines: [], reader: async () => { throw new Error("The read is forbidden."); }, exec: async () => { throw new Error("Execution is forbidden."); } };
  await assert.rejects(controlCommand(db, ["run", "service", id, "stop"], { deps }), /requires --yes/);
});

test("control run with --yes prints the audit and control log filters it", async (t) => {
  const { db, id } = seed(t);
  const lines: string[] = [];
  let time = Date.parse("2026-10-07T00:00:00Z");
  let calls = 0;
  const deps: ControlRunnerDeps = {
    machines: [{ id: "hub", transport: { type: "local" } }],
    clock: { now: () => time, sleep: async (ms) => { time += ms; } },
    reader: async (_m, row) => ({ ...row, state: calls ? "stopped" : "running" }),
    exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; },
  };
  const write = (line: string): void => { lines.push(line); };
  await controlCommand(db, ["run", "service", id, "stop", "--yes"], { deps, write });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(lines[0]!).state, "done");
  assert.equal("token" in JSON.parse(lines[0]!), false);
  await controlCommand(db, ["log", "--machine", "hub", "--limit", "1"], { write });
  assert.equal(JSON.parse(lines[1]!).items.length, 1);
  await controlCommand(db, ["log", "--machine", "mini"], { write });
  assert.equal(JSON.parse(lines[2]!).items.length, 0);
  await assert.rejects(controlCommand(db, ["log", "--limit", "201"], { write }), /limit/);
});

test("control protected and uninstall print instructions and validate command arguments", async (t) => {
  const { db, id } = seed(t);
  const lines: string[] = [];
  const write = (line: string): void => { lines.push(line); };
  await controlCommand(db, ["protected"], { write, protectedPath: "fixtures/servicestate/missing-protected.json" });
  assert.equal(JSON.parse(lines[0]!).groups.length, 8);
  assert.ok(JSON.parse(lines[0]!).fileError);
  for (const target of ["service", "listener"]) await controlCommand(db, ["uninstall", target, id], { write });
  assert.equal(JSON.parse(lines[1]!).note, "Scout never runs an uninstall.");
  assert.equal(JSON.parse(lines[2]!).command, "sc.exe delete DistinctService");
  for (const args of [["unknown"], ["plan", "bad", id, "stop"], ["plan", "service", "bad", "stop"], ["plan", "service", id, "bad"], ["plan", "service", id, "start", "--hard"], ["uninstall", "service", "999"]]) await assert.rejects(controlCommand(db, args, { write }));
});

test("the CLI entry accepts control log and refuses control run without confirmation in memory", () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const log = spawnSync(process.execPath, [entry, "control", "log", "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
  assert.equal(log.status, 0);
  assert.deepEqual(JSON.parse(log.stdout).items, []);
  const refused = spawnSync(process.execPath, [entry, "control", "run", "service", "1", "stop", "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requires --yes/);
});

test("control plan accepts disable and enable, refuses --hard with them and rejects an unknown action", async (t) => {
  const { db, id } = seed(t);
  const lines: string[] = [];
  const deps: ControlRunnerDeps = { machines: [{ id: "hub", transport: { type: "local" } }], exec: async () => { throw new Error("The plan must not execute."); } };
  await controlCommand(db, ["plan", "service", id, "disable"], { deps, write: (line) => { lines.push(line); } });
  const plan = JSON.parse(lines[0]!);
  assert.equal(plan.action, "disable");
  assert.equal(plan.allowed, false);
  assert.equal(plan.refusal, "Only launchd jobs and scheduled tasks can be disabled or enabled");
  await assert.rejects(controlCommand(db, ["plan", "service", id, "enable", "--hard"], { deps }), /only for stop/);
  await assert.rejects(controlCommand(db, ["plan", "service", id, "pause"], { deps }), /start, stop, restart, disable or enable/);
});
