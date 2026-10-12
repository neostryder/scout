import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listListeners, openCatalog, recordListeners, SCHEMA_SQL, SCHEMA_VERSION, upsertMachine, type Db, type ListenerFact, type ListenerResult } from "../src/index.ts";

const T = "2026-10-06T12:00:00Z";
const T2 = "2026-10-06T13:00:00Z";
const T3 = "2026-10-06T14:00:00Z";
const listener: ListenerFact = { port: 8787, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 100, processName: "node", processPath: "/opt/bin/node", container: null };
const container: ListenerFact = { ...listener, pid: null, processName: null, processPath: null, container: { name: "relay", image: "relay:1", containerPort: 3300 } };
const result = (facts: ListenerFact[], status: ListenerResult["status"] = "ok", origin = "lsof"): ListenerResult => ({ origin, status, facts });

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

test("the first machine scan stores process and container rows without events", (t) => {
  const db = seed(t);
  assert.deepEqual(recordListeners(db, "hub", result([listener, container], "partial", "listeners"), T), { listeners: 2, gone: 0 });
  assert.deepEqual(events(db), []);
  const rows = listListeners(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.machineName === "Hub" && row.firstSeenAt === T && row.lastSeenAt === T && row.goneAt === null));
});

test("a scan that reads the owner as process 0 keeps the last real owner and adds no second row", (t) => {
  const db = seed(t);
  const idle: ListenerFact = { ...listener, pid: 0, processName: "Idle", processPath: null };
  recordListeners(db, "hub", result([listener], "ok", "listeners"), T);
  recordListeners(db, "hub", result([idle], "ok", "listeners"), T2);
  const rows = listListeners(db, { port: 8787 });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.processName, rows[0]!.pid, rows[0]!.goneAt, rows[0]!.lastSeenAt], ["node", 100, null, T2]);
  recordListeners(db, "hub", result([idle], "ok", "listeners"), T3);
  assert.equal(listListeners(db, { port: 8787 }).length, 1);
  assert.equal(events(db).length, 0);
});

test("a reader that learns the owner of an unnamed listener renames the row without a new or gone event", (t) => {
  const db = seed(t);
  const unnamed: ListenerFact = { ...listener, pid: null, processName: null, processPath: null };
  recordListeners(db, "hub", result([unnamed], "ok", "listeners"), T);
  recordListeners(db, "hub", result([listener], "ok", "listeners"), T2);
  const rows = listListeners(db, { port: 8787 });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.processName, rows[0]!.pid, rows[0]!.goneAt, rows[0]!.firstSeenAt], ["node", 100, null, T]);
  assert.deepEqual(events(db), []);
  recordListeners(db, "hub", result([{ ...listener, processName: "deno" }], "ok", "listeners"), T3);
  assert.deepEqual(events(db).map((event) => event.kind), ["listener_new", "listener_gone"]);
});

test("the store retains the widest bind and keeps identity across pid and path changes", (t) => {
  const db = seed(t);
  const all: ListenerFact = { ...listener, address: "::", bind: "all" };
  const lan: ListenerFact = { ...listener, address: "192.168.1.100", bind: "lan" };
  assert.equal(recordListeners(db, "hub", result([listener, all, lan, all]), T).listeners, 1);
  const first = listListeners(db)[0]!;
  assert.equal(first.bind, "all");
  assert.equal(first.address, "::");
  recordListeners(db, "hub", result([{ ...all, pid: 200, processPath: "/opt/new/node" }, listener]), T2);
  const second = listListeners(db)[0]!;
  assert.equal(second.id, first.id);
  assert.equal(second.pid, 200);
  assert.equal(second.processPath, "/opt/new/node");
  assert.equal(second.firstSeenAt, T);
  assert.equal(second.lastSeenAt, T2);
  assert.deepEqual(events(db), []);
});

test("bind widening and narrowing each emit one event with the old and new scope", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener]), T);
  recordListeners(db, "hub", result([listener, { ...listener, bind: "lan", address: "192.168.1.100" }]), T2);
  recordListeners(db, "hub", result([{ ...listener, bind: "all", address: "*" }, listener]), T3);
  recordListeners(db, "hub", result([listener]), T3);
  assert.deepEqual(events(db), [
    { kind: "listener_changed", machine: "hub", detail: { machine: "hub", port: 8787, process: "node", oldBind: "loopback", newBind: "lan" } },
    { kind: "listener_changed", machine: "hub", detail: { machine: "hub", port: 8787, process: "node", oldBind: "lan", newBind: "all" } },
    { kind: "listener_changed", machine: "hub", detail: { machine: "hub", port: 8787, process: "node", oldBind: "all", newBind: "loopback" } },
  ]);
});

test("partial, failed and skipped reads never mark absent listeners gone", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener]), T);
  for (const status of ["partial", "failed", "skipped"] as const) {
    assert.equal(recordListeners(db, "hub", result([], status), T2).gone, 0);
    assert.equal(listListeners(db, { state: "present" }).length, 1);
  }
  recordListeners(db, "hub", result([{ ...listener, pid: 200 }], "partial"), T2);
  for (const status of ["failed", "skipped"] as const) recordListeners(db, "hub", result([{ ...listener, pid: 300 }], status), T3);
  assert.equal(listListeners(db)[0]!.pid, 200);
  assert.equal(listListeners(db)[0]!.lastSeenAt, T2);
  assert.deepEqual(events(db), []);
});

test("successful absence emits one gone event and a return clears gone without changing first seen", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener]), T);
  assert.deepEqual(recordListeners(db, "hub", result([]), T2), { listeners: 0, gone: 1 });
  const row = listListeners(db, { state: "gone" })[0]!;
  assert.equal(row.goneAt, T2);
  assert.equal(row.lastSeenAt, T);
  assert.equal(recordListeners(db, "hub", result([]), T3).gone, 0);
  assert.deepEqual(events(db), [{ kind: "listener_gone", machine: "hub", detail: { machine: "hub", port: 8787, process: "node", oldBind: "loopback", newBind: null } }]);
  recordListeners(db, "hub", result([{ ...listener, pid: 200 }]), T3);
  const present = listListeners(db, { state: "present" })[0]!;
  assert.equal(present.id, row.id);
  assert.equal(present.firstSeenAt, T);
  assert.equal(present.lastSeenAt, T3);
  assert.equal(present.goneAt, null);
  assert.equal(events(db).length, 1);
});

test("new listeners emit events after the first scan and each machine has its own baseline", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener]), T);
  recordListeners(db, "hub", result([listener, { ...listener, port: 8080 }]), T2);
  recordListeners(db, "mini", result([listener]), T2);
  recordListeners(db, "hub", result([]), T3);
  assert.equal(listListeners(db, { machine: "mini", state: "present" }).length, 1);
  assert.deepEqual(events(db)[0], { kind: "listener_new", machine: "hub", detail: { machine: "hub", port: 8080, process: "node", oldBind: null, newBind: "loopback" } });
  assert.equal(events(db).length, 3);
  assert.ok(events(db).every((row) => row.machine === "hub"));
});

test("process and container readers cannot mark each other's rows gone", (t) => {
  const db = seed(t);
  recordListeners(db, "mini", result([listener, container], "ok", "listeners"), T);
  recordListeners(db, "mini", result([], "ok", "lsof"), T2);
  assert.equal(listListeners(db, { state: "present" })[0]!.containerName, "relay");
  recordListeners(db, "mini", result([listener]), T3);
  recordListeners(db, "mini", result([], "ok", "docker-ports"), T3);
  assert.equal(listListeners(db, { state: "present" })[0]!.processName, "node");
  assert.equal(listListeners(db, { state: "gone" })[0]!.containerName, "relay");
  assert.equal(events(db).at(-1)!.kind, "listener_gone");
  assert.deepEqual(events(db).at(-1)!.detail, { machine: "mini", port: 8787, process: "relay", oldBind: "loopback", newBind: null });
});

test("the store separates process names and container identities on the same port", (t) => {
  const db = seed(t);
  recordListeners(db, "mini", result([listener, { ...listener, processName: "python" }, container, { ...container, container: { ...container.container!, name: "relay-other" } }], "ok", "listeners"), T);
  assert.equal(listListeners(db).length, 4);
  recordListeners(db, "mini", result([{ ...container, container: { ...container.container!, image: "relay:2" } }], "partial", "docker-ports"), T2);
  assert.equal(listListeners(db).length, 4);
  assert.equal(listListeners(db, { q: "relay" }).find((row) => row.containerName === "relay")!.containerImage, "relay:2");
});

test("the query combines machine, bind, state, literal substring and port filters and sorts rows", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener, { ...listener, port: 8080, processName: "other", processPath: "/opt/100%/tool", bind: "all" }, { ...container, port: 9000 }], "ok", "listeners"), T);
  recordListeners(db, "mini", result([{ ...listener, port: 9001 }, { ...listener, port: 80 }]), T);
  assert.deepEqual(listListeners(db).map((row) => [row.machineName, row.port]), [["Hub", 8080], ["Hub", 8787], ["Hub", 9000], ["Mini", 80], ["Mini", 9001]]);
  assert.equal(listListeners(db, { machine: "hub", bind: "loopback", state: "present", q: "NODE", port: 8787 }).length, 1);
  assert.equal(listListeners(db, { q: "100%" }).length, 1);
  assert.equal(listListeners(db, { q: "relay" }).length, 1);
  assert.equal(listListeners(db, { q: "_" }).length, 0);
  recordListeners(db, "mini", result([]), T2);
  assert.equal(listListeners(db, { machine: "mini", state: "gone", port: 80 }).length, 1);
});

test("classification filters work while the core keeps hidden rows included by default", (t) => {
  const db = seed(t);
  const system = { ...listener, port: 8788, processPath: "C:/Windows/System32/svchost.exe" };
  recordListeners(db, "hub", result([system, listener]), T);
  assert.equal(listListeners(db).length, 2);
  assert.equal(listListeners(db, { includeHidden: false }).length, 1);
  assert.equal(listListeners(db, { class: "third-party" }).length, 1);
  assert.equal(listListeners(db, { official: true }).length, 1);
});

test("a failed transaction rolls back listener rows and events", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener]), T);
  assert.throws(() => recordListeners(db, "hub", result([{ ...listener, port: 8080 }, { ...listener, port: 9000, bind: "invalid" as ListenerFact["bind"] }]), T2));
  assert.equal(listListeners(db).length, 1);
  assert.deepEqual(events(db), []);
});

test("the additive listeners schema leaves version 3 and existing data intact", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", result([listener]), T);
  db.exec(SCHEMA_SQL);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "3");
  assert.equal(listListeners(db).length, 1);
});

for (const machine of ["hub", "laptop", "server", "mini"]) {
  test(`the ${machine} fixture facts record in an in-memory catalog`, (t) => {
    const db = seed(t);
    if (!["hub", "mini"].includes(machine)) upsertMachine(db, { id: machine, name: machine, os: "macos", kind: "host" });
    const recorded = JSON.parse(readFileSync(new URL(`../../../fixtures/listeners/${machine}/expected.json`, import.meta.url), "utf8")) as ListenerResult;
    const facts = [...recorded.facts];
    if (machine === "server") facts.push(...(JSON.parse(readFileSync(new URL("../../../fixtures/listeners/docker-server/expected.json", import.meta.url), "utf8")) as ListenerResult).facts);
    const keys = new Set(facts.map((fact) => JSON.stringify([fact.port, fact.protocol, fact.processName, fact.container?.name ?? null])));
    assert.equal(recordListeners(db, machine, result(facts, "ok", "listeners"), T).listeners, keys.size);
    assert.equal(listListeners(db, { machine }).length, keys.size);
    assert.deepEqual(events(db), []);
  });
}

test("launchLabel names what a runtime is running", async () => {
  const { launchLabel } = await import("../src/listeners.ts");
  assert.equal(launchLabel("node", "C:/Repositories/ark-overseer/dist/index.js"), "node: ark-overseer/index.js");
  assert.equal(launchLabel("node", "/home/u/proj/node_modules/vite/bin/vite.js"), "node: vite");
  assert.equal(launchLabel("node", "/home/u/proj/node_modules/@scope/tool/cli.js"), "node: @scope/tool");
  assert.equal(launchLabel("node", "server.js"), "node: server.js");
  assert.equal(launchLabel("node", null), "node");
  assert.equal(launchLabel(null, null), null);
});

test("an owner names a listener the process name alone leaves unclear, and it survives a scan that reads process 0", async (t) => {
  const { launchLabel } = await import("../src/listeners.ts");
  assert.equal(launchLabel("svchost", null, "Remote Desktop Services"), "svchost: Remote Desktop Services");
  assert.equal(launchLabel("AdguardSvc", null, "adguardsvc"), "adguardsvc");
  assert.equal(launchLabel(null, null, "Print Spooler"), "Print Spooler");
  assert.equal(launchLabel("Idle", null, "Print Spooler"), "Print Spooler");
  assert.equal(launchLabel("node", "server.js", "Example Service service"), "node: server.js");
  assert.equal(launchLabel("node", null, null), "node");
  const db = seed(t);
  const named: ListenerFact = { ...listener, pid: 3100, processName: "node", processPath: "C:/ProgramData/Example/node.exe", owner: "Example Service service" };
  recordListeners(db, "hub", result([named], "ok", "netconn"), T);
  assert.equal(listListeners(db)[0]!.owner, "Example Service service");
  assert.equal(listListeners(db)[0]!.label, "node: Example Service service");
  recordListeners(db, "hub", result([{ ...named, pid: 0, processName: "Idle", processPath: null, owner: null }], "ok", "netconn"), T2);
  const rows = listListeners(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.owner, "Example Service service");
  assert.equal(rows[0]!.pid, 3100);
});
