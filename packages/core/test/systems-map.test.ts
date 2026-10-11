import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordServices, upsertMachine, trayResponse, statusSummary, systemsMapMarkdown, whoIs, EMPTY_TRAY_RULES, type Db, type ServiceFact } from "../src/index.ts";

const AT = "2026-10-10T12:00:00.000Z";
const svc = (over: Partial<ServiceFact>): ServiceFact => ({ kind: "windows-service", name: "worker", displayName: "Worker", domain: "system", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null, ...over });

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  db.prepare("UPDATE machines SET state = 'reachable' WHERE kind = 'host'").run();
  recordServices(db, "eru", { origin: "services", status: "ok", facts: [svc({ name: "worker" }), svc({ name: "Spooler", displayName: "Print Spooler" }), svc({ name: "dead", displayName: "Dead One", state: "stopped" })] }, AT);
  return db;
}

test("whois finds a service by name and rejects an empty or out-of-range query", (t) => {
  const db = seed(t);
  const hits = whoIs(db, "spool");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, "service");
  assert.equal(hits[0]!.machineId, "eru");
  assert.deepEqual(whoIs(db, "no-such-thing"), []);
  assert.throws(() => whoIs(db, "  "), /requires a port number or a name/);
  assert.throws(() => whoIs(db, "70000"), /1 to 65535/);
});

test("the status summary lists machines and only the rows that are down or changed", (t) => {
  const db = seed(t);
  const tray = trayResponse(db, EMPTY_TRAY_RULES, { now: AT });
  const status = statusSummary(tray);
  assert.equal(status.machines.length, 1);
  assert.equal(status.machines[0]!.id, "eru");
  assert.ok(status.problems.every((p) => p.state === "down" || p.state === "changed"));
  assert.equal(status.generatedAt, tray.generatedAt);
});

test("the systems map is plain markdown with a section per machine and pipes kept out of cells", (t) => {
  const db = seed(t);
  const tray = trayResponse(db, EMPTY_TRAY_RULES, { now: AT });
  const text = systemsMapMarkdown({
    tray,
    stacks: [{ name: "dev", label: "Dev | stack", state: "ready", members: [{ order: 1, label: "Worker", machineId: "eru", running: null, waitPort: 4870 }] }],
    ports: { ranges: [{ name: "apps", from: 4800, to: 4899, usedCount: 2, size: 100, next: 4801 }], reserved: [{ port: 4870, name: "Scout", state: "free", by: null }], clashes: [{ kind: "reserved-taken", detail: "4870 is taken" }] },
  });
  assert.match(text, /^# Systems map\n/);
  assert.match(text, /## Eru\n/);
  assert.match(text, /\| Name \| Kind \| State \|/);
  assert.match(text, /### Dev \/ stack/);
  assert.match(text, /\| apps \| 4800-4899 \| 2\/100 \| 4801 \|/);
  assert.match(text, /- Clash \(reserved-taken\): 4870 is taken/);
  assert.ok(!/\n{3,}/.test(text));
  assert.ok(text.endsWith("\n"));
});
