import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, parseTrayRules, recordListeners, recordMeterReading, recordServices, trayFileReader, trayResponse, upsertMachine, writeTrayRules, EMPTY_TRAY_RULES, serviceWatchKey, type Db, type ServiceFact, type TrayRules } from "../src/index.ts";

const AT = "2026-10-10T12:00:00.000Z";
const svc = (over: Partial<ServiceFact>): ServiceFact => ({ kind: "windows-service", name: "worker", displayName: "Worker", domain: "system", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null, ...over });

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  upsertMachine(db, { id: "gm", name: "Gamemaster", os: "macos", kind: "host" });
  db.prepare("UPDATE machines SET state = 'reachable' WHERE kind = 'host'").run();
  recordServices(db, "eru", { origin: "services", status: "ok", facts: [svc({ name: "worker" }), svc({ name: "Spooler", displayName: "Print Spooler" }), svc({ name: "ondemand", displayName: "On Demand", startMode: "manual" }), svc({ name: "dead", displayName: "Dead One", state: "stopped" })] }, AT);
  return db;
}
const labels = (db: Db, rules: TrayRules = EMPTY_TRAY_RULES, machine = "eru"): string[] => trayResponse(db, rules, { now: AT }).machines.find((m) => m.id === machine)!.rows.map((r) => r.label);

test("rules validate, fill in missing lists, and reject malformed input with a readable message", () => {
  assert.deepEqual(parseTrayRules({}), EMPTY_TRAY_RULES);
  assert.deepEqual(parseTrayRules({ hide: { kinds: ["scheduled-task"], names: [{ match: "One*" }] } }).hide.names, [{ match: "One*" }]);
  assert.throws(() => parseTrayRules([]), /must be an object/);
  assert.throws(() => parseTrayRules({ hide: { kinds: ["bogus"] } }), /unknown value "bogus"/);
  assert.throws(() => parseTrayRules({ hide: { names: [{ machine: "x" }] } }), /hide.names/);
  assert.throws(() => parseTrayRules({ pins: [{ machine: "x" }] }), /pins/);
});

test("the rules file reads with a cache, ignores a damaged file with an error, and writes atomically", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tray-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "data", "tray.json");
  const read = trayFileReader(path);
  assert.deepEqual(read(), { rules: EMPTY_TRAY_RULES, fileError: null });
  const written = writeTrayRules(path, { hide: { machines: ["gm"] } });
  assert.deepEqual(written.hide.machines, ["gm"]);
  assert.match(readFileSync(path, "utf8"), /"machines": \[\n\s+"gm"/);
  assert.deepEqual(read().rules.hide.machines, ["gm"]);
  assert.throws(() => writeTrayRules(path, { hide: { kinds: ["nope"] } }));
  assert.deepEqual(read().rules.hide.machines, ["gm"]);
  writeFileSync(path, "{ not json");
  const damaged = read();
  assert.deepEqual(damaged.rules, EMPTY_TRAY_RULES);
  assert.match(damaged.fileError!, /damaged and is ignored/);
});

test("the default set holds the services meant to stay up, and a stopped one shows down only after it has been seen running", (t) => {
  const db = seed(t);
  const rows = () => trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).machines.find((m) => m.id === "eru")!;
  assert.deepEqual(rows().rows.map((r) => [r.label, r.state]), [["Print Spooler", "up"], ["Worker", "up"], ["Dead One", "stopped"]]);
  const key = serviceWatchKey({ machineId: "eru", kind: "windows-service", domain: "system", name: "dead" } as never);
  db.prepare("INSERT INTO watch_state (key, kind, machine_id, label, last_state) VALUES (?, 'service', 'eru', 'Dead One', 'up')").run(key);
  const eru = rows();
  assert.deepEqual(eru.rows.map((r) => [r.label, r.state]), [["Dead One", "down"], ["Print Spooler", "up"], ["Worker", "up"]]);
  assert.equal(eru.worst, "down");
  assert.equal(eru.counts.down, 1);
});

test("a listener a service owns does not appear twice, and an ephemeral listener stays out", (t) => {
  const db = seed(t);
  recordListeners(db, "eru", { origin: "listeners", status: "ok", facts: [
    { port: 8001, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 42, processName: "worker", processPath: "C:/Tools/worker.exe", container: null },
    { port: 55555, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 77, processName: "chrome", processPath: "C:/Chrome/chrome.exe", container: null },
  ] }, AT);
  const rows = trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).machines.find((m) => m.id === "eru")!.rows;
  assert.equal(rows.filter((r) => r.kind === "listener").length, 0);
  assert.ok(rows.some((r) => r.label === "Worker"));
});

test("hide rules remove rows by kind, class, machine and name, and a pin brings one back", (t) => {
  const db = seed(t);
  assert.deepEqual(labels(db, parseTrayRules({ hide: { names: [{ machine: "eru", match: "print*" }] } })), ["Worker", "Dead One"]);
  assert.deepEqual(labels(db, parseTrayRules({ hide: { kinds: ["windows-service"] } })), []);
  const hiddenOnes = trayResponse(db, parseTrayRules({ hide: { names: [{ machine: "eru", match: "print*" }] } }), { now: AT });
  assert.equal(hiddenOnes.hidden, 1);
  assert.equal(hiddenOnes.machines.find((m) => m.id === "eru")!.hidden, 1);
  const all = trayResponse(db, parseTrayRules({ hide: { machines: ["eru"] } }), { now: AT });
  assert.equal(all.machines.some((m) => m.id === "eru"), false);
  const spooler = trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).machines[0]!.rows.find((r) => r.label === "Print Spooler")!;
  const pinned = parseTrayRules({ hide: { kinds: ["windows-service"] }, pins: [{ machine: "eru", key: spooler.key }] });
  assert.deepEqual(labels(db, pinned), ["Print Spooler"]);
  assert.equal(trayResponse(db, pinned, { now: AT }).machines[0]!.rows[0]!.pinned, true);
});

test("a pin shows a service the default set leaves out", (t) => {
  const db = seed(t);
  const key = serviceWatchKey({ machineId: "eru", kind: "windows-service", domain: "system", name: "ondemand" } as never);
  assert.equal(labels(db).includes("On Demand"), false);
  assert.ok(labels(db, parseTrayRules({ pins: [{ machine: "eru", key }] })).includes("On Demand"));
});

test("an unreachable machine shows its rows as unknown and the hub's live view overrides the catalog", (t) => {
  const db = seed(t);
  const down = trayResponse(db, EMPTY_TRAY_RULES, { now: AT, reachable: (id) => id === "eru" ? false : null });
  const eru = down.machines.find((m) => m.id === "eru")!;
  assert.equal(eru.reachable, false);
  assert.ok(eru.rows.every((r) => r.state === "unknown"));
  assert.equal(eru.worst, "unknown");
});

test("a stack gets its own tab and the response version changes when a row changes", (t) => {
  const db = seed(t);
  const stacks = [{ name: "ark", label: "ARK", state: "partial", members: [{ running: true }, { running: false }] }] as never;
  const withStack = trayResponse(db, EMPTY_TRAY_RULES, { now: AT, stacks });
  const tab = withStack.machines.find((m) => m.id === "stacks")!;
  assert.deepEqual(tab.rows.map((r) => [r.label, r.state, r.detail]), [["ARK", "changed", "1 of 2 running"]]);
  const before = trayResponse(db, EMPTY_TRAY_RULES, { now: AT });
  assert.equal(before.version, trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).version);
  recordServices(db, "eru", { origin: "services", status: "ok", facts: [svc({ name: "worker", state: "stopped" })] }, AT);
  assert.notEqual(before.version, trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).version);
});

test("protected rows refuse stop and restart and carry the reason", (t) => {
  const db = seed(t);
  recordServices(db, "eru", { origin: "services", status: "ok", facts: [svc({ name: "sshd", displayName: "OpenSSH Server" })] }, AT);
  const row = trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).machines.find((m) => m.id === "eru")!.rows.find((r) => r.name === "sshd")!;
  assert.equal(row.protected, true);
  assert.ok(row.protectedReason);
  assert.ok(row.actions.filter((a) => a.action !== "start").every((a) => !a.available));
});

test("a machine carries its newest meter summary, the busiest disk, and a changed reading changes the version", (t) => {
  const db = seed(t);
  assert.equal(trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).machines.find((m) => m.id === "eru")!.meters, null);
  const reading = { cpuPct: 12, memUsedBytes: 25, memTotalBytes: 100, disks: [{ mount: "C:", usedBytes: 60, totalBytes: 100 }, { mount: "D:", usedBytes: 90, totalBytes: 100 }], gpus: [{ name: "GPU", utilPct: 3, vramUsedBytes: 4, vramTotalBytes: 16 }], netRxBytes: 0, netTxBytes: 0, processes: [] };
  recordMeterReading(db, "eru", reading, "2026-10-10T11:59:50.000Z");
  const first = trayResponse(db, EMPTY_TRAY_RULES, { now: AT });
  assert.deepEqual(first.machines.find((m) => m.id === "eru")!.meters, { ageSeconds: 10, cpuPct: 12, memPct: 25, diskPct: 90, diskMount: "D:", vramPct: 25, netBps: null });
  assert.equal(first.machines.find((m) => m.id === "gm")!.meters, null);
  recordMeterReading(db, "eru", { ...reading, cpuPct: 40 }, "2026-10-10T11:59:55.000Z");
  assert.notEqual(trayResponse(db, EMPTY_TRAY_RULES, { now: AT }).version, first.version);
});
