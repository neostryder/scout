import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsSummary, listListeners, listServices, openCatalog, upsertMachine, type Db, type Probe, type ProbeOutput, type Transport } from "@scout/core";
import { collectListeners, collectServices, readLive, type LiveMachine, type ProbeRunner } from "../src/live.ts";

const local: Transport = { type: "local" };
const windows: LiveMachine = { id: "hub", os: "windows", transport: local };
const mac: LiveMachine = { id: "laptop", os: "macos", transport: local };

test("service scans evaluate alerts after storage and evaluator errors never stop a scan", async () => {
  const db = dbWith(windows, "Hub");
  const logs: string[] = [];
  const run: ProbeRunner = async (_transport, probe) => ({ exitCode: 0, stdout: windowsStdout(probe.id, "Running"), stderr: "" });
  try {
    await collectServices(db, windows, { run, alerts: { loadMutes: () => ({ ungatedHosts: [], mute: [], at: null, fileError: null }) } });
    assert.equal(alertsSummary(db).open, 0);
    await collectServices(db, windows, { run: async (_transport, probe) => ({ exitCode: 0, stdout: windowsStdout(probe.id, "Stopped"), stderr: "" }), alerts: { loadMutes: () => ({ ungatedHosts: [], mute: [], at: null, fileError: null }) } });
    assert.equal(alertsSummary(db).open, 1);
    await collectServices(db, windows, { run, log: (line) => logs.push(line), alerts: { evaluate: () => { throw new Error("fixture evaluator failure"); } } });
    assert.ok(logs.some((line) => line.includes("Alert evaluation failed")));
    assert.equal(listServices(db).find((row) => row.name === "Cloudflared")!.state, "running");
  } finally { db.close(); }
});

test("listener scans evaluate changes and return alert changes to their subscriber", async () => {
  const db = dbWith(windows, "Hub");
  const changes: string[] = [];
  let port = 8080;
  const run: ProbeRunner = async () => ({ exitCode: 0, stdout: JSON.stringify([{ port, pid: port, address: "127.0.0.1", name: "node", path: "C:/Tools/node.exe" }]), stderr: "" });
  const alerts = { loadMutes: () => ({ ungatedHosts: [], mute: [], at: null, fileError: null }), onChanges: (events: { change: string }[]) => { changes.push(...events.map((event) => event.change)); } };
  try {
    await collectListeners(db, windows, { run, alerts });
    assert.deepEqual(changes, []);
    port = 8090;
    await collectListeners(db, windows, { run, alerts });
    assert.equal(alertsSummary(db).open, 2);
    assert.deepEqual(changes, ["created", "created"]);
  } finally { db.close(); }
});

function dbWith(machine: LiveMachine, name: string): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: machine.id, name, os: machine.os, kind: "host" });
  return db;
}

function events(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

function listenerJson(): string {
  return JSON.stringify([{ port: 20241, pid: 100, address: "0.0.0.0", name: "cloudflared", path: "C:/Tools/cloudflared.exe" }]);
}

function serviceJson(state: string): string {
  return JSON.stringify([{
    Name: "Cloudflared", DisplayName: "Cloudflared", PathName: "C:/Tools/cloudflared.exe", State: state,
    StartMode: "Auto", ProcessId: 100, StartName: "LocalSystem",
  }]);
}

function taskJson(): string {
  return JSON.stringify([{
    TaskName: "ScoutSample", TaskPath: "\\", State: "Ready", Execute: "C:/Tools/scout.exe",
    Triggers: ["boot"], RunAs: "SYSTEM", LastRun: null, LastResult: 0,
  }]);
}

function windowsStdout(id: string, state: string): string {
  if (id === "listeners") return listenerJson();
  if (id === "services") return serviceJson(state);
  if (id === "tasks") return taskJson();
  return "[]";
}

const lsof = "p123\ncpython\nn*:8010\n---SCOUT-PS---\n123 /usr/local/bin/python\n";
const docker = "relay|relay:1|0.0.0.0:8080->80/tcp|running\n";
const launchd = "---SCOUT-SYSTEM---\n1 0\tcom.example.helper\n---SCOUT-GUI---\n---SCOUT-DISABLED-SYSTEM---\n---SCOUT-DISABLED-GUI---\n";

function runner(stdout: (probe: Probe) => string, calls: { id: string; timeout: number | undefined }[], fail?: (probe: Probe) => Error | undefined): ProbeRunner {
  return async (_transport, probe, timeout) => {
    calls.push({ id: probe.id, timeout });
    const error = fail?.(probe);
    if (error) throw error;
    return { exitCode: 0, stdout: stdout(probe), stderr: "" };
  };
}

test("collect keeps the scan timeouts and the coverage lines", async () => {
  const db = dbWith(windows, "Hub");
  const macDb = dbWith(mac, "Laptop");
  const calls: { id: string; timeout: number | undefined }[] = [];
  const logs: string[] = [];
  const run = runner((probe) => windowsStdout(probe.id, "Running"), calls);
  try {
    await collectListeners(db, windows, { run, log: (line) => logs.push(line) });
    await collectServices(db, windows, { run, log: (line) => logs.push(line) });
    assert.deepEqual(calls.map((call) => [call.id, call.timeout]), [
      ["listeners", undefined],
      ["services", undefined],
      ["tasks", 600_000],
    ]);
    assert.equal(logs[0], "  listeners netconn     ok          1 facts");
    assert.equal(logs[1], "  services win-services  ok          1 facts");
    assert.equal(logs[2], "  services win-tasks     ok          1 facts");
    calls.length = 0;
    await readLive(db, windows, { run, slow: false });
    assert.deepEqual(calls.map((call) => call.id), ["listeners", "services"]);
    assert.ok(calls.every((call) => call.timeout === 30_000));
    calls.length = 0;
    await readLive(db, windows, { run, slow: true });
    assert.equal(calls.find((call) => call.id === "tasks")?.timeout, 600_000);
    assert.ok(calls.filter((call) => call.id !== "tasks").every((call) => call.timeout === 30_000));
    const macCalls: { id: string; timeout: number | undefined }[] = [];
    await collectServices(macDb, mac, { run: runner((probe) => probe.id === "state" ? launchd : "", macCalls) });
    assert.deepEqual(macCalls, [{ id: "state", timeout: undefined }]);
  } finally {
    db.close();
    macDb.close();
  }
});

test("the first listener and service write of a machine emits no events", async () => {
  const db = dbWith(windows, "Hub");
  const calls: { id: string; timeout: number | undefined }[] = [];
  let state = "Running";
  const run = runner((probe) => windowsStdout(probe.id, state), calls);
  try {
    await collectListeners(db, windows, { run });
    await collectServices(db, windows, { run });
    assert.equal(events(db), 0);
    assert.deepEqual(listServices(db, { machine: "hub", includeHidden: true }).map((row) => row.kind).sort(), ["scheduled-task", "windows-service"]);
    state = "Stopped";
    await collectServices(db, windows, { run });
    const kinds = db.prepare("SELECT kind FROM events ORDER BY id").all() as { kind: string }[];
    assert.deepEqual(kinds.map((row) => row.kind), ["service_changed"]);
  } finally {
    db.close();
  }
});

test("the first mac listener write records both families without events", async () => {
  const db = dbWith(mac, "Laptop");
  const calls: { id: string; timeout: number | undefined }[] = [];
  const run = runner((probe) => probe.id === "ports" ? docker : lsof, calls);
  try {
    await collectListeners(db, mac, { run });
    assert.equal(events(db), 0);
    const rows = listListeners(db, { machine: "laptop", includeHidden: true });
    assert.equal(rows.filter((row) => row.containerName === "relay").length, 1);
    assert.equal(rows.filter((row) => row.processName === "python").length, 1);
    await collectListeners(db, mac, { run });
    assert.equal(events(db), 0);
    assert.deepEqual(calls.map((call) => call.id), ["listeners", "ports", "listeners", "ports"]);
  } finally {
    db.close();
  }
});

test("readLive reports a row change and ignores last_seen_at", async () => {
  const db = dbWith(windows, "Hub");
  const stamps = ["2026-10-01T00:00:00.000Z", "2026-10-01T00:05:00.000Z", "2026-10-01T00:10:00.000Z"];
  let tick = 0;
  let state = "Running";
  const run = runner((probe) => windowsStdout(probe.id, state), []);
  const now = (): string => stamps[tick++] ?? stamps[2]!;
  try {
    const first = await readLive(db, windows, { run, now, slow: true });
    assert.equal(first.status, "ok");
    assert.equal(first.changed, true);
    assert.deepEqual(first.tables, ["services", "listeners"]);
    const second = await readLive(db, windows, { run, now, slow: true });
    assert.deepEqual(second, { changed: false, tables: [], status: "ok", error: null });
    const cloudflared = listServices(db, { machine: "hub", q: "Cloudflared", includeHidden: true })[0];
    assert.equal(cloudflared?.lastSeenAt, stamps[1]);
    state = "Stopped";
    const third = await readLive(db, windows, { run, now, slow: false });
    assert.equal(third.changed, true);
    assert.deepEqual(third.tables, ["services"]);
    assert.equal(listServices(db, { machine: "hub", q: "Cloudflared", includeHidden: true })[0]?.state, "stopped");
  } finally {
    db.close();
  }
});

test("readLive keeps a partial write when a later probe throws", async () => {
  const db = dbWith(windows, "Hub");
  const logs: string[] = [];
  const run: ProbeRunner = async (_transport, probe) => {
    if (probe.id === "services") throw new Error("service probe exploded");
    const stdout = probe.id === "listeners" ? "{" : "[]";
    return { exitCode: 0, stdout: probe.id === "listeners" ? listenerJson() : stdout, stderr: "" };
  };
  try {
    const thrown = await readLive(db, windows, { run, slow: false });
    assert.equal(thrown.status, "failed");
    assert.equal(thrown.error, "service probe exploded");
    assert.equal(thrown.changed, true);
    assert.deepEqual(thrown.tables, ["listeners"]);
    const bad: ProbeRunner = async (_transport, probe): Promise<ProbeOutput> => {
      logs.push("skip");
      return { exitCode: probe.id === "listeners" ? 1 : 0, stdout: probe.id === "listeners" ? listenerJson() : "{", stderr: "" };
    };
    const partial = await readLive(db, windows, { run: bad, slow: false, log: (line) => logs.push(line) });
    assert.equal(partial.status, "partial");
    assert.match(partial.error ?? "", /some listener records could not be read/);
    assert.match(partial.error ?? "", /service output is not valid JSON/);
    assert.match(logs.find((line) => line.includes("netconn")) ?? "", /some listener records could not be read/);
    const failed = await readLive(db, windows, {
      slow: false,
      run: async () => ({ exitCode: 0, stdout: "{", stderr: "" }),
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "listener output is not valid JSON; service output is not valid JSON");
    const linux = await readLive(db, { id: "guest", os: "linux", transport: local }, { run: async () => { throw new Error("should not run"); } });
    assert.deepEqual(linux, { changed: false, tables: [], status: "ok", error: null });
  } finally {
    db.close();
  }
});
