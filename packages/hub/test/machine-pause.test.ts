import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHealthTargets, findHubMachine, hubMachineId, hubMachineName, openCatalog, recordCloudflare, recordMeterReading, recordResearch, recordScan, recordServices, resourcesResponse, setHubMachine, upsertMachine } from "@scout/core";
import { configureHubMachine, loadAllMachines, loadMachines, pausedMachineIds, watchMachines } from "@scout/ops";
import { LiveSchedule, type LiveClock, type LiveMachineConfig } from "../src/live.ts";
import { ScanSchedule } from "../src/scan-schedule.ts";
import { createHub } from "../src/server.ts";

const AT = "2026-10-18T00:00:00.000Z";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function machinesFile(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "scout-pause-"));
  const path = join(folder, "machines.json");
  const write = (paused = true) => writeFileSync(path, JSON.stringify({ machines: [
    { id: "local", name: "Local", os: "linux", paused: true, transport: { type: "local" } },
    { id: "remote", name: "Remote", os: "linux", paused, transport: { type: "ssh", target: "test@remote" } },
  ] }));
  write();
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, path, write };
}

test("shared machine readers skip paused remotes and always retain the local hub", (t) => {
  const f = machinesFile(t);
  const previous = { id: hubMachineId(), name: hubMachineName() };
  t.after(() => setHubMachine(previous.id, previous.name));
  assert.deepEqual(loadAllMachines(f.path).map((machine) => machine.id), ["local", "remote"]);
  assert.deepEqual(loadMachines(f.path).map((machine) => machine.id), ["local"]);
  assert.deepEqual(pausedMachineIds(f.path), ["remote"]);
  assert.equal(findHubMachine(loadAllMachines(f.path))?.id, "local");
  assert.deepEqual(configureHubMachine(f.path).map((machine) => machine.id), ["local"]);
  assert.equal(hubMachineId(), "local");
  assert.deepEqual(watchMachines(loadMachines(f.path)), []);
  f.write(false);
  assert.deepEqual(loadMachines(f.path).map((machine) => machine.id), ["local", "remote"]);
  assert.deepEqual(pausedMachineIds(f.path), []);
  assert.equal(watchMachines(loadMachines(f.path))[0]?.id, "remote");
});

test("both machine readers retain the missing-config error", (t) => {
  const f = machinesFile(t);
  for (const read of [loadMachines, loadAllMachines, pausedMachineIds]) assert.throws(() => read(join(f.folder, "missing.json")), /copy machines.example.json/);
});

test("paused machines retain installs and history, disappear from resources, and appear paused in machine and service lists", async (t) => {
  const f = machinesFile(t);
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (const id of ["local", "remote"]) {
    upsertMachine(db, { id, name: id, os: "linux", kind: "host" });
    recordMeterReading(db, id, { cpuPct: 10, memUsedBytes: 100, memTotalBytes: 200, disks: [], gpus: [], netRxBytes: 0, netTxBytes: 0, processes: [] }, AT);
  }
  recordScan(db, "remote", { sourceKind: "test", location: "", status: "ok", installs: [{ ecosystem: "npm", key: "demo", name: "demo", kind: "package", version: "1", location: "/demo" }] }, AT);
  const counts = () => ["installs", "events", "meter_samples"].map((table) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  const before = counts();
  const scans = new ScanSchedule(db, { machinesPath: f.path, root: f.folder, dbPath: ":memory:", spawn: () => { throw new Error("a scan must not run"); } });
  assert.deepEqual(resourcesResponse(db, AT).machines.map((machine) => machine.machineId), ["local"]);
  assert.deepEqual(counts(), before);
  const server = createHub({ db, webRoot: f.folder, scans, health: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const summary = await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json() as { machines: { id: string; state: string }[] };
    assert.equal(summary.machines.find((machine) => machine.id === "remote")?.state, "paused");
    const overview = await (await fetch(`http://127.0.0.1:${port}/api/services/overview`)).json() as { machines: { id: string; live: { state: string } }[] };
    assert.equal(overview.machines.find((machine) => machine.id === "remote")?.live.state, "paused");
    f.write(false);
    scans.status();
    assert.equal((db.prepare("SELECT state FROM machines WHERE id = 'remote'").get() as { state: string }).state, "unknown");
    assert.deepEqual(resourcesResponse(db, AT).machines.map((machine) => machine.machineId), ["local", "remote"]);
    assert.deepEqual(counts(), before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

class FakeClock implements LiveClock {
  time = Date.parse(AT);
  serial = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
    this.time = until;
    await settle();
  }
}

test("live cycles re-read machines, stop paused reads, and discover resumed machines without a restart", async (t) => {
  const f = machinesFile(t);
  f.write(false);
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  const calls: string[] = [];
  const live = new LiveSchedule(db, { machines: () => loadMachines(f.path) as LiveMachineConfig[], clock, reader: async (machine) => {
    calls.push(machine.id);
    return { changed: false, tables: [], status: "ok", error: null };
  } });
  t.after(() => { live.stop(); db.close(); });
  live.start();
  await settle();
  assert.deepEqual(calls, ["local", "remote"]);
  f.write(true);
  await clock.advance(120_000);
  assert.deepEqual(calls, ["local", "remote", "local"]);
  assert.equal(live.status().find((machine) => machine.id === "remote")?.state, "paused");
  assert.throws(() => live.refresh("remote"), /machine is paused/);
  f.write(false);
  await clock.advance(120_000);
  assert.equal(calls.filter((id) => id === "remote").length, 2);
  live.stop();
  assert.equal(clock.timers.size, 0);
});

test("a machine paused at live startup begins reading after its flag is removed", async (t) => {
  const f = machinesFile(t);
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  const calls: string[] = [];
  const live = new LiveSchedule(db, { machines: () => loadMachines(f.path) as LiveMachineConfig[], clock, reader: async (machine) => {
    calls.push(machine.id);
    return { changed: false, tables: [], status: "ok", error: null };
  } });
  t.after(() => { live.stop(); db.close(); });
  live.start();
  await settle();
  assert.deepEqual(calls, ["local"]);
  f.write(false);
  await clock.advance(120_000);
  assert.ok(calls.includes("remote"));
});

test("job and control routes use the current machine list after a pause", async (t) => {
  const f = machinesFile(t);
  f.write(false);
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "remote", name: "Remote", os: "windows", kind: "host" });
  recordScan(db, "remote", { sourceKind: "npm", location: "", status: "ok", installs: [{ ecosystem: "npm", key: "demo", name: "demo", kind: "package", version: "1.0", location: "" }] }, AT);
  const install = db.prepare("SELECT id, package_id AS packageId FROM installs").get() as { id: number; packageId: number };
  recordResearch(db, install.packageId, "npm", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  recordServices(db, "remote", { origin: "services", status: "ok", facts: [{ kind: "windows-service", name: "DistinctService", displayName: null, domain: "system", program: "C:/Tools/distinct.exe", state: "running", startMode: "manual", enabled: true, pid: 734, runAs: null, triggers: null, lastRun: null, lastResult: null }] }, AT);
  const serviceId = (db.prepare("SELECT id FROM services").get() as { id: number }).id;
  let reads = 0;
  let commands = 0;
  const server = createHub({ db, webRoot: f.folder, health: false,
    jobs: { get machines() { return loadMachines(f.path); }, exec: async () => { commands++; throw new Error("a paused job must not connect"); } },
    control: { get machines() { return loadMachines(f.path); }, protectedPath: join(f.folder, "protected.json"), reader: async (_machine, row) => { reads++; return row; } },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const before = await (await fetch(`${base}/api/updates/plan?installId=${install.id}`)).json() as { allowed: boolean };
    assert.equal(before.allowed, true);
    f.write(true);
    const after = await (await fetch(`${base}/api/updates/plan?installId=${install.id}`)).json() as { allowed: boolean };
    assert.equal(after.allowed, false);
    const headers = { "content-type": "application/json" };
    const job = await fetch(`${base}/api/jobs`, { method: "POST", headers, body: JSON.stringify({ installIds: [install.id], confirm: true }) });
    assert.equal(job.status, 400);
    const control = await (await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers, body: JSON.stringify({ target: "service", id: serviceId, action: "stop", hard: false }) })).json() as { plan: { allowed: boolean } };
    assert.equal(control.plan.allowed, false);
    assert.equal(reads, 0);
    assert.equal(commands, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("health targets omit public hostnames assigned to a paused machine", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "remote", name: "Remote", os: "linux", kind: "host", address: "192.0.2.1" });
  recordCloudflare(db, { zones: [{ id: "z", name: "example.test" }], dns: [{ zone: "example.test", name: "worker.example.test", type: "CNAME", content: "tunnel.cfargotunnel.com", proxied: true }], tunnels: [{ id: "tunnel", name: "test", status: "healthy", connections: 1, remoteManaged: true }], ingress: [{ tunnelId: "tunnel", position: 0, hostname: "worker.example.test", path: null, service: "http://localhost:8080" }] }, AT, null);
  assert.equal(buildHealthTargets(db, { test: "remote" })[0]?.machineId, "remote");
  db.prepare("UPDATE machines SET state = 'paused' WHERE id = 'remote'").run();
  assert.deepEqual(buildHealthTargets(db, { test: "remote" }), []);
});
