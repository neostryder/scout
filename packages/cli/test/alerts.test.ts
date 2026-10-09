import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateAlerts, openCatalog, recordListeners, upsertMachine } from "@scout/core";
import { alertsCommand } from "../src/alerts.ts";

function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const listen = (ports: number[]): void => { recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: ports.map((port) => ({ port, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: port, processName: "node", processPath: "C:/Tools/node.exe", container: null })) }, "2026-10-07T00:00:00.000Z"); };
  listen([8000]);
  evaluateAlerts(db, "2026-10-07T00:00:00.000Z");
  listen([8000, 8080, 8090]);
  const created = evaluateAlerts(db, "2026-10-07T01:00:00.000Z");
  const lines: string[] = [];
  const options = { write: (line: string) => { lines.push(line); }, alerts: {} };
  return { db, alert: created[0]!.alert, lines, options };
}

test("the alerts CLI lists catalog rows with state, kind and machine filters", (t) => {
  const { db, lines, options } = seed(t);
  alertsCommand(db, ["--state", "all", "--kind", "new-listener", "--machine", "hub"], options);
  assert.equal(JSON.parse(lines[0]!).total, 2);
  alertsCommand(db, ["--machine", "mini"], options);
  assert.equal(JSON.parse(lines[1]!).total, 0);
});

test("the alerts CLI acknowledges one id and all remaining rows", (t) => {
  const { db, alert, lines, options } = seed(t);
  alertsCommand(db, ["ack", String(alert.id)], options);
  assert.deepEqual(JSON.parse(lines[0]!), { acknowledged: 1 });
  alertsCommand(db, ["ack", "--all"], options);
  assert.deepEqual(JSON.parse(lines[1]!), { acknowledged: 1 });
  alertsCommand(db, ["--state", "acknowledged"], options);
  assert.equal(JSON.parse(lines[2]!).total, 2);
});

test("the alerts CLI persists key mutes and removes them", (t) => {
  const { db, alert, lines, options } = seed(t);
  alertsCommand(db, ["mute", alert.key, "--reason", "development ports"], options);
  assert.equal(JSON.parse(lines[0]!).mutes[0].reason, "development ports");
  alertsCommand(db, [], options);
  assert.equal(JSON.parse(lines[1]!).total, 1);
  alertsCommand(db, ["unmute", alert.key], options);
  assert.deepEqual(JSON.parse(lines[2]!).mutes, []);
  alertsCommand(db, [], options);
  assert.equal(JSON.parse(lines[3]!).total, 2);
});

test("the alerts CLI rejects invalid ids, missing keys and invalid list filters", (t) => {
  const { db, options } = seed(t);
  for (const args of [["ack"], ["ack", "bad"], ["ack", "999"], ["ack", "1", "--all"], ["mute"], ["unmute"], ["unknown"], ["--state", "bad"], ["--kind", "bad"], ["--machine"]]) assert.throws(() => alertsCommand(db, args, options));
});

test("the CLI entry dispatches alerts commands using an in-memory catalog", () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  for (const args of [[], ["ack", "--all"], ["mute", "example", "--reason", "test"], ["unmute", "example"]]) {
    const result = spawnSync(process.execPath, [entry, "alerts", ...args, "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(typeof JSON.parse(result.stdout), "object");
  }
});
