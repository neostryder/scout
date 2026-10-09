import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openCatalog, recordListeners, upsertMachine } from "@scout/core";
import { healthCommand } from "../src/health.ts";

const AT = "2026-10-07T00:00:00.000Z";
function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 8080, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 42, processName: "node", processPath: "C:/Tools/node.exe", container: null }] }, AT);
  return db;
}

test("health lists the contract table and applies state and kind filters", async (t) => {
  const db = seed(t);
  const lines: string[] = [];
  await healthCommand(db, ["--kind", "listener", "--state", "unknown"], { now: () => AT, write: (line) => lines.push(line) });
  assert.match(lines[0]!, /^Label\s+State\s+Latency\s+Status\s+TLS days\s+Last ok$/);
  assert.match(lines[1]!, /^node:8080\s+unknown\s+-\s+-\s+-\s+-$/);
  assert.equal(lines[2], "\n1 target");
  await assert.rejects(() => healthCommand(db, ["--state", "wrong"]), /invalid state/);
  await assert.rejects(() => healthCommand(db, ["--kind"]), /requires a value/);
  await assert.rejects(() => healthCommand(db, ["wrong"]), /requires refresh/);
});

test("health refresh runs a cycle in process with a fake transport and prints the resulting sample", async (t) => {
  const db = seed(t);
  const lines: string[] = [];
  let calls = 0;
  await healthCommand(db, ["refresh", "--state", "up"], { now: () => AT, write: (line) => lines.push(line), probe: { now: () => Date.parse(AT), fetch: async () => { calls++; return { status: 200 }; } } });
  assert.equal(calls, 1);
  assert.match(lines[1]!, /^node:8080\s+up\s+0 ms\s+200\s+-\s+2026-10-07T00:00:00.000Z$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples").get()!.n, 1);
});

test("the CLI entry dispatches health against an empty in-memory catalog", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url)), "health", "--db", ":memory:"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TLS days\s+Last ok/);
  assert.match(result.stdout, /0 targets/);
});
