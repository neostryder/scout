import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCatalog, recordListeners, recordServices, upsertMachine, type ServiceFact } from "@scout/core";
import type { ControlRunnerDeps } from "@scout/ops";
import { portsCommand } from "../src/ports.ts";
import { stacksCommand } from "../src/stacks.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve("ports-stack-cli-")).replace(/\\/g, "/");
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const facts: ServiceFact[] = ["First", "Last"].map((name) => ({ kind: "scheduled-task", name, displayName: null, domain: "gui", program: "C:/Tools/node.exe", state: "stopped", startMode: "manual", enabled: true, pid: null, runAs: null, triggers: null, lastRun: null, lastResult: null }));
  recordServices(db, "hub", { origin: "services", status: "ok", facts }, "2026-10-07T00:00:00Z");
  writeFileSync(`${root}/ports.json`, JSON.stringify({ ranges: [{ name: "dev", from: 4870, to: 4872 }, { name: "full", from: 1, to: 1 }], reserved: [{ port: 4870, name: "Hub", match: "node" }, { port: 1, name: "Full" }] }));
  writeFileSync(`${root}/stacks.json`, JSON.stringify({ stacks: [{ name: "dev", label: "Development", members: facts.map((fact) => ({ type: "service", machine: "hub", kind: fact.kind, name: fact.name })) }] }));
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 4870, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 100, processName: "python", processPath: "C:/Tools/python.exe", container: null }] }, "2026-10-07T00:00:00Z");
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const lines: string[] = [];
  const write = (line: string) => { lines.push(line); };
  let time = 0;
  const calls: string[] = [];
  const deps: ControlRunnerDeps = { machines: [{ id: "hub", os: "windows", transport: { type: "local" } }], protectedPath: `${root}/protected.json`, clock: { now: () => time, sleep: async (ms) => { time += ms; } }, reader: async (_machine, row) => ({ ...row, state: calls.includes(row.name) ? "running" : row.state }), exec: async (_transport, _argv, _timeout, _signal, env) => { calls.push(env!.SCOUT_NAME!); return { exitCode: 0, stdout: "", stderr: "" }; } };
  return { root, db, lines, write, calls, deps };
}

test("ports prints ranges, reservations, clashes and next-port output with full and unknown errors", (t) => {
  const f = fixture(t);
  const options = { portsPath: `${f.root}/ports.json`, write: f.write };
  portsCommand(f.db, [], options);
  const output = f.lines.join("\n");
  assert.match(output, /Range.*Used.*Next/);
  assert.match(output, /dev.*1\/3.*4871/);
  assert.match(output, /4870.*Hub.*clash.*python/);
  assert.match(output, /reserved-taken: Port 4870/);
  portsCommand(f.db, ["next", "dev"], options);
  assert.equal(f.lines.at(-1), "4871");
  assert.throws(() => portsCommand(f.db, ["next", "missing"], options), /unknown range/);
  assert.throws(() => portsCommand(f.db, ["next", "full"], options), /range is full/);
  assert.throws(() => portsCommand(f.db, ["next"], options), /requires a range/);
});

test("stacks lists members and plans steps without live reads or execution", async (t) => {
  const f = fixture(t);
  const options = { stacksPath: `${f.root}/stacks.json`, deps: { ...f.deps, reader: async () => { throw new Error("The live read is forbidden."); }, exec: async () => { throw new Error("Execution is forbidden."); } }, write: f.write };
  await stacksCommand(f.db, [], options);
  assert.match(f.lines[0]!, /Name.*State.*Members/);
  assert.match(f.lines[1]!, /dev.*ready.*2/);
  await stacksCommand(f.db, ["plan", "dev"], options);
  assert.match(f.lines[2]!, /1\. First: Start-ScheduledTask/);
  assert.match(f.lines[3]!, /2\. Last: Start-ScheduledTask/);
  assert.equal(/token|SCOUT_NAME/.test(f.lines.join("\n")), false);
  assert.deepEqual(f.calls, []);
});

test("stacks start requires --yes before reading live state and prints each result after confirmation", async (t) => {
  const f = fixture(t);
  const options = { stacksPath: `${f.root}/stacks.json`, deps: f.deps, write: f.write };
  await assert.rejects(stacksCommand(f.db, ["start", "dev"], options), /requires --yes/);
  assert.deepEqual(f.calls, []);
  await stacksCommand(f.db, ["start", "dev", "--yes"], options);
  assert.deepEqual(f.calls, ["First", "Last"]);
  assert.match(f.lines[0]!, /1\. First: done - The task started/);
  assert.match(f.lines[1]!, /2\. Last: done - The task started/);
  assert.equal(f.lines[2], "Started 2 of 2 members");
});

test("the CLI entry accepts both registry lists and refuses stack Start without --yes in memory", () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  for (const command of ["ports", "stacks"]) {
    const result = spawnSync(process.execPath, [entry, command, "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, command === "ports" ? /Range.*Used.*Next/ : /Name.*State.*Members/);
  }
  const refused = spawnSync(process.execPath, [entry, "stacks", "start", "dev", "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /stacks start requires --yes/);
});
