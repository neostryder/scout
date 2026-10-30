import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { listServices, openCatalog, recordListeners, recordServices, SCHEMA_SQL, SCHEMA_VERSION, upsertMachine, type Db, type ListenerFact, type ListenerResult, type ServiceFact, type ServiceResult } from "../src/index.ts";

const T = "2026-10-06T12:00:00Z";
const T2 = "2026-10-06T13:00:00Z";
const T3 = "2026-10-06T14:00:00Z";

const service: ServiceFact = {
  kind: "windows-service", name: "Appinfo", displayName: "Application Information", domain: "system",
  program: "C:/Windows/System32/svchost.exe", state: "running", startMode: "manual", enabled: true, pid: 100,
  runAs: "LocalSystem", triggers: null, lastRun: null, lastResult: null,
};
const task: ServiceFact = {
  kind: "scheduled-task", name: "\\Microsoft\\Windows\\Update", displayName: "Update", domain: "system",
  program: "C:/Windows/System32/task.exe", state: "stopped", startMode: null, enabled: true, pid: null,
  runAs: "SYSTEM", triggers: ["Daily"], lastRun: null, lastResult: "0",
};
const result = (facts: ServiceFact[], status: ServiceResult["status"] = "ok", origin = "win-services"): ServiceResult => ({ origin, status, facts });
const listener = (over: Partial<ListenerFact> = {}): ListenerFact => ({
  port: 8787, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 100, processName: "svchost",
  processPath: "C:/Windows/System32/svchost.exe", container: null, ...over,
});
const heard = (facts: ListenerFact[], status: ListenerResult["status"] = "ok"): ListenerResult => ({ origin: "netconn", status, facts });

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  return db;
}

function events(db: Db): { kind: string; machine: string; detail: unknown }[] {
  return (db.prepare("SELECT kind, machine_id AS machine, detail_json AS detail FROM events ORDER BY id").all() as { kind: string; machine: string; detail: string }[]).map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}

test("the first machine scan stores rows without events", (t) => {
  const db = seed(t);
  assert.deepEqual(recordServices(db, "hub", result([service, task], "partial", "services"), T), { services: 2, gone: 0 });
  assert.deepEqual(events(db), []);
  const rows = listServices(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.machineName === "Hub" && row.firstSeenAt === T && row.lastSeenAt === T && row.goneAt === null));
  assert.deepEqual(rows.find((row) => row.kind === "scheduled-task")!.triggers, ["Daily"]);
});

test("new services emit events after the first scan and each machine has its own baseline", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service]), T);
  recordServices(db, "hub", result([service, { ...service, name: "LSM", pid: 4 }], "ok", "win-services"), T2);
  recordServices(db, "mini", result([{ ...service, kind: "launchd", domain: "gui", name: "com.apple.sample", program: null, pid: null }], "ok", "launchd-state"), T2);
  assert.equal(listServices(db, { machine: "mini", gone: "present" }).length, 1);
  assert.deepEqual(events(db), [{ kind: "service_new", machine: "hub", detail: { machine: "hub", kind: "windows-service", domain: "system", name: "LSM", old: null, new: { state: "running", enabled: true, program: service.program } } }]);
});

test("a second family does not mark the first family's rows gone", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service, task], "ok", "services"), T);
  assert.equal(recordServices(db, "hub", result([], "ok", "win-tasks"), T2).gone, 1);
  assert.equal(listServices(db, { gone: "present" })[0]!.kind, "windows-service");
  assert.equal(listServices(db, { gone: "gone" })[0]!.kind, "scheduled-task");
  assert.equal(recordServices(db, "hub", result([], "ok", "win-services"), T3).gone, 1);
  assert.equal(listServices(db, { gone: "present" }).length, 0);
  assert.deepEqual(events(db).map((row) => row.kind), ["service_gone", "service_gone"]);
});

test("partial, failed and skipped reads never mark absent services gone", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service]), T);
  for (const status of ["partial", "failed", "skipped"] as const) {
    assert.equal(recordServices(db, "hub", result([], status), T2).gone, 0);
    assert.equal(listServices(db, { gone: "present" }).length, 1);
  }
  recordServices(db, "hub", result([{ ...service, pid: 200 }], "partial"), T2);
  for (const status of ["failed", "skipped"] as const) recordServices(db, "hub", result([{ ...service, pid: 300 }], status), T3);
  assert.equal(listServices(db)[0]!.pid, 200);
  assert.equal(listServices(db)[0]!.lastSeenAt, T2);
  assert.deepEqual(events(db), []);
});

test("successful absence emits one gone event and a return clears gone without a new event", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service]), T);
  assert.deepEqual(recordServices(db, "hub", result([]), T2), { services: 0, gone: 1 });
  const row = listServices(db, { gone: "gone" })[0]!;
  assert.equal(row.goneAt, T2);
  assert.equal(row.lastSeenAt, T);
  assert.equal(recordServices(db, "hub", result([]), T3).gone, 0);
  recordServices(db, "hub", result([{ ...service, pid: 200 }]), T3);
  const present = listServices(db, { gone: "present" })[0]!;
  assert.equal(present.id, row.id);
  assert.equal(present.firstSeenAt, T);
  assert.equal(present.goneAt, null);
  assert.equal(events(db).length, 1);
  assert.equal(events(db)[0]!.kind, "service_gone");
});

test("state, enabled and program changes emit one event and a pid change emits none", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service]), T);
  recordServices(db, "hub", result([{ ...service, pid: 250 }]), T2);
  assert.equal(listServices(db)[0]!.pid, 250);
  assert.deepEqual(events(db), []);
  recordServices(db, "hub", result([{ ...service, pid: 250, state: "stopped", enabled: false, program: "C:/Windows/System32/other.exe" }]), T3);
  assert.deepEqual(events(db), [{
    kind: "service_changed", machine: "hub",
    detail: {
      machine: "hub", kind: "windows-service", domain: "system", name: "Appinfo",
      old: { state: "running", enabled: true, program: service.program },
      new: { state: "stopped", enabled: false, program: "C:/Windows/System32/other.exe" },
    },
  }]);
});

test("the same launchd label in two domains is two rows", (t) => {
  const db = seed(t);
  const job = (domain: ServiceFact["domain"], pid: number | null): ServiceFact => ({ ...service, kind: "launchd", domain, name: "com.apple.sample", program: null, pid, displayName: null, runAs: null });
  recordServices(db, "mini", result([job("system", 10), job("gui", null)], "ok", "launchd-state"), T);
  assert.equal(listServices(db).length, 2);
});

test("the pid join, the path fallback and present listeners only", (t) => {
  const db = seed(t);
  const keep = [
    listener({ port: 135, pid: 100, processPath: "C:/Windows/System32/svchost.exe" }),
    listener({ port: 49664, pid: 100, processPath: "C:/Other/svchost.exe" }),
    listener({ port: 80, pid: 999, processPath: "c:/windows/system32/svchost.exe" }),
  ];
  const gone = listener({ port: 443, pid: 100, address: "10.0.0.8", bind: "lan" });
  recordListeners(db, "hub", heard([...keep, gone]), T);
  recordListeners(db, "hub", heard(keep), T2);
  recordListeners(db, "mini", heard([
    listener({ port: 631, pid: null, processName: "cupsd", processPath: "/usr/sbin/cupsd" }),
    listener({ port: 632, pid: null, processName: "cupsd", processPath: "/usr/sbin/CUPSd" }),
    listener({ port: 7000, pid: 50, processName: "other", processPath: "/usr/sbin/other" }),
  ]), T);
  recordServices(db, "hub", result([service, { ...service, name: "Idle", pid: null, state: "stopped" }]), T);
  recordServices(db, "mini", result([
    { ...service, kind: "launchd", domain: "system", name: "com.apple.cupsd", program: "/usr/sbin/cupsd", pid: null, displayName: null },
    { ...service, kind: "launchd", domain: "gui", name: "com.apple.other", program: "/usr/sbin/cupsd", pid: 50, displayName: null },
  ], "ok", "launchd-state"), T);
  const running = listServices(db, { machine: "hub", q: "Appinfo" })[0]!;
  assert.deepEqual(running.ports.map((port) => port.port), [135, 49664]);
  const idle = listServices(db, { machine: "hub", q: "Idle" })[0]!;
  assert.deepEqual(idle.ports.map((port) => port.port), [80, 135]);
  assert.deepEqual(listServices(db, { machine: "mini", q: "cupsd" })[0]!.ports.map((port) => port.port), [631]);
  assert.deepEqual(listServices(db, { machine: "mini", q: "other" })[0]!.ports.map((port) => port.port), [7000]);
  assert.equal(listServices(db, { hasPort: true }).length, 4);
  assert.equal(listServices(db, { machine: "hub", hasPort: false }).length, 0);
});

test("the query combines machine, kind, state, text and gone filters and sorts rows", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service, task, { ...service, name: "Stopped", state: "stopped", program: "C:/Tools/100%/svc.exe" }]), T);
  recordServices(db, "mini", result([{ ...service, kind: "launchd", domain: "system", name: "com.apple.sample", program: null }], "ok", "launchd-state"), T);
  assert.deepEqual(listServices(db).map((row) => [row.machineName, row.kind, row.name]), [
    ["Hub", "scheduled-task", task.name],
    ["Hub", "windows-service", "Appinfo"],
    ["Hub", "windows-service", "Stopped"],
    ["Mini", "launchd", "com.apple.sample"],
  ]);
  assert.equal(listServices(db, { machine: "hub", kind: "windows-service", state: "running", q: "APPLICATION", gone: "present" }).length, 1);
  assert.equal(listServices(db, { q: "100%" }).length, 1);
  assert.equal(listServices(db, { q: "_" }).length, 0);
  recordServices(db, "mini", result([], "ok", "launchd-state"), T2);
  assert.equal(listServices(db, { machine: "mini", gone: "gone" }).length, 1);
  assert.equal(listServices(db, { gone: "present", kind: "launchd" }).length, 0);
});

test("classification filters work while the core keeps hidden rows included by default", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service, { ...service, name: "External", program: "C:/Tools/external.exe" }]), T);
  assert.equal(listServices(db).length, 2);
  assert.equal(listServices(db, { includeHidden: false }).length, 1);
  assert.equal(listServices(db, { class: "third-party" })[0]!.name, "External");
  assert.equal(listServices(db, { official: false }).length, 1);
});

test("a failed transaction rolls back service rows and events", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service]), T);
  assert.throws(() => recordServices(db, "hub", result([{ ...service, name: "Other" }, { ...service, name: "Bad", state: "nope" as ServiceFact["state"] }]), T2));
  assert.equal(listServices(db).length, 1);
  assert.deepEqual(events(db), []);
});

test("the additive services schema leaves version 3 and existing data intact", (t) => {
  const db = seed(t);
  recordServices(db, "hub", result([service]), T);
  db.exec(SCHEMA_SQL);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "3");
  assert.equal(listServices(db).length, 1);
});

for (const [machine, os, file] of [["hub", "windows", "hub-services"], ["hub", "windows", "hub-tasks"], ["laptop", "macos", "laptop"]] as const) {
  test(`the ${file} fixture facts record in an in-memory catalog`, (t) => {
    const db = seed(t);
    if (machine === "laptop") upsertMachine(db, { id: machine, name: "Laptop", os, kind: "host" });
    const recorded = JSON.parse(readFileSync(new URL(`../../../fixtures/servicestate/${file}/expected.json`, import.meta.url), "utf8")) as ServiceResult;
    assert.equal(recorded.status, "ok");
    assert.equal(recordServices(db, machine, recorded, T).services, recorded.facts.length);
    assert.equal(listServices(db, { machine }).length, recorded.facts.length);
    assert.deepEqual(events(db), []);
  });
}

const unit = (over: Partial<ServiceFact> = {}): ServiceFact => ({
  kind: "systemd", name: "sshd", displayName: "OpenSSH Daemon", domain: "system", program: "/usr/bin/sshd",
  state: "running", startMode: "auto", enabled: true, pid: 300, runAs: "root", keepAlive: true, triggers: null, lastRun: null, lastResult: null, ...over,
});

test("systemd units record under their own origin and classify by the systemd rules", (t) => {
  const db = seed(t);
  upsertMachine(db, { id: "arch", name: "Arch", os: "linux", kind: "host" });
  recordServices(db, "arch", result([unit(), unit({ name: "systemd-journald", displayName: "Journal Service" }), unit({ name: "cups", displayName: "CUPS Scheduler" })], "ok", "systemd-state"), T);
  const rows = listServices(db, { machine: "arch", kind: "systemd" });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.name === "systemd-journald")!.classification.class, "essential");
  assert.notEqual(rows.find((row) => row.name === "cups")!.classification.class, "essential");
  // A windows-services origin cannot retire a systemd row.
  recordServices(db, "arch", result([], "ok", "win-services"), T2);
  assert.equal(listServices(db, { machine: "arch", gone: "present" }).length, 3);
});

test("a catalog built before systemd units gains the kind and keeps its service rows", () => {
  const dir = mkdtempSync(resolve("services-core-"));
  const path = `${dir}/legacy.db`.replace(/\\/g, "/");
  try {
    const db = openCatalog(path);
    upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
    recordServices(db, "hub", result([service, task]), T);
    const legacy = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS services \([\s\S]*?\n\);/)![0].replace(",'systemd'", "");
    assert.notEqual(legacy, SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS services \([\s\S]*?\n\);/)![0]);
    db.exec("ALTER TABLE services RENAME TO services_new");
    db.exec(legacy);
    db.exec("INSERT INTO services SELECT * FROM services_new");
    db.exec("DROP TABLE services_new");
    assert.throws(() => db.prepare("UPDATE services SET kind = 'systemd' WHERE id = 1").run());
    db.close();
    const reopened = openCatalog(path);
    try {
      assert.equal(listServices(reopened, { machine: "hub" }).length, 2);
      reopened.prepare("UPDATE services SET kind = 'systemd' WHERE id = 1").run();
      assert.equal(listServices(reopened, { kind: "systemd" }).length, 1);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a launchd job keeps its program and enabled flag when the cheap reader omits them", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  const full: ServiceFact = { kind: "launchd", name: "com.example.worker", displayName: null, domain: "gui", program: "/opt/worker", state: "running", startMode: null, enabled: true, pid: 40, runAs: null, triggers: null, lastRun: null, lastResult: null };
  const cheap: ServiceFact = { ...full, program: null, enabled: null };
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [full, { ...full, name: "com.example.other" }] }, T);
  const eventCount = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'service_changed'").get() as { n: number }).n;
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [cheap] }, T2);
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [full] }, T3);
  assert.equal(eventCount(), 0);
  const row = listServices(db, { machine: "mini" }).find((entry) => entry.name === "com.example.worker")!;
  assert.equal(row.program, "/opt/worker");
  assert.equal(row.enabled, true);
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [{ ...cheap, state: "stopped" }] }, "2026-10-06T15:00:00Z");
  assert.equal(eventCount(), 1);
});
