import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incidentById, openCatalog, type FleetCatalogConfig, type FleetFile, type IncidentPacket } from "@scout/core";
import { FleetCatalogSource } from "../src/fleet-catalog.ts";
import { FleetService } from "../src/fleet.ts";

const T = "2026-10-31T18:00:00.000Z";

function fixture(catalog?: FleetCatalogConfig) {
  const db = openCatalog(":memory:");
  db.prepare("INSERT INTO machines (id, name, os, kind) VALUES (?, ?, ?, ?)").run("machine-id", "desktop", "windows", "host");
  db.prepare(`INSERT INTO services (machine_id, kind, domain, name, state, enabled, last_result, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("machine-id", "scheduled-task", "system", "\\Backup", "stopped", 1, "1", T, T);
  const file: FleetFile = { policy: null, notifiers: [], investigator: null, triage: null, healers: [], expected: [], ingestTokenEnv: null, digestTimes: [], fileError: null, ...(catalog ? { sources: { catalog } } : {}) };
  const batches: IncidentPacket[][] = [];
  const logs: string[] = [];
  const stub: Pick<FleetService, "config" | "accept"> = {
    config: () => file,
    accept: async (items) => {
      batches.push(items as IncidentPacket[]);
      return { accepted: items.length, rejected: [] };
    },
  };
  const fleet = stub as FleetService;
  const options = { now: () => new Date(T), log: (line: string) => { logs.push(line); } };
  return { db, file, batches, logs, stub, fleet, options };
}

test("the source is inert without explicit catalog enablement and sends after configuration", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetCatalogSource(f.db, f.fleet, f.options);
  for (const sources of [undefined, {}, { catalog: {} }, { catalog: { enabled: false } }]) {
    f.file.sources = sources;
    await source.tick();
    assert.deepEqual(f.batches, []);
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get(), undefined);
  }
  f.file.sources = { catalog: { enabled: true } };
  await source.tick();
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0]?.length, 1);
  assert.equal(f.batches[0]?.[0]?.host, "desktop");
  assert.equal(f.batches[0]?.[0]?.component, "Backup");
  await source.tick();
  assert.equal(f.batches.length, 2);
  assert.equal(f.batches[1]?.[0]?.fingerprint, f.batches[0]?.[0]?.fingerprint);
  assert.deepEqual(f.logs, []);
});

test("state survives a source restart and recovery is sent exactly once", async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.db.close());
  const first = new FleetCatalogSource(f.db, f.fleet, f.options);
  await first.tick();
  const stored = f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string };
  assert.deepEqual(JSON.parse(stored.value), f.batches[0]);
  first.stop();
  f.db.prepare("UPDATE services SET last_result = '0'").run();
  const second = new FleetCatalogSource(f.db, f.fleet, { ...f.options, now: () => new Date("2026-10-31T18:01:00.000Z") });
  await second.tick();
  assert.equal(f.batches.length, 2);
  assert.deepEqual(f.batches[1], [{ ...f.batches[0]?.[0], recovered: true, lastSeen: "2026-10-31T18:01:00.000Z", summary: "recovered" }]);
  await second.tick();
  assert.equal(f.batches.length, 2);
  assert.equal((f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string }).value, "[]");
});

test("catalog rows map integer flags, exclude gone services, and obey configured expressions", async (t) => {
  const f = fixture({ enabled: true, tasks: { include: [] }, systemd: { include: ["^BACKUP\\.SERVICE$"] }, windowsServices: { include: ["^BACKUP$"] } });
  t.after(() => f.db.close());
  const insert = f.db.prepare(`INSERT INTO services (machine_id, kind, domain, name, state, start_mode, enabled, keep_alive, last_result, first_seen_at, last_seen_at, gone_at)
    VALUES ('machine-id', ?, 'system', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("launchd", "org.example.agent", "stopped", null, 1, 1, "0", T, T, null);
  insert.run("launchd", "org.example.completed", "stopped", null, 1, 0, "0", T, T, null);
  insert.run("launchd", "org.example.failed", "stopped", null, 1, null, "1", T, T, null);
  insert.run("launchd", "org.example.disabled", "stopped", null, 0, 1, "0", T, T, null);
  insert.run("launchd", "org.example.unknown", "stopped", null, null, 1, "0", T, T, null);
  insert.run("launchd", "org.example.gone", "stopped", null, 1, 1, "0", T, T, T);
  insert.run("systemd", "backup.service", "other", "auto", 1, null, null, T, T, null);
  insert.run("windows-service", "Backup", "stopped", "auto", 1, null, null, T, T, null);
  await new FleetCatalogSource(f.db, f.fleet, f.options).tick();
  assert.deepEqual(f.batches[0]?.map((item) => [item.component, item.failureClass]), [["org.example.agent", "dead"], ["org.example.failed", "ran-failed"], ["backup.service", "dead"], ["Backup", "dead"]]);
  assert.deepEqual(f.logs, []);
});

test("configured never-run tasks open incidents and recover after running", async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.db.close());
  f.db.prepare("UPDATE services SET last_result = '267011', first_seen_at = '2026-10-01T18:00:00.000Z'").run();
  const source = new FleetCatalogSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches.length, 0);
  f.file.sources = { catalog: { enabled: true, neverRan: { tasks: ["^other$"] } } };
  await source.tick();
  assert.equal(f.batches.length, 0);
  f.file.sources = { catalog: { enabled: true, neverRan: { tasks: ["^backup$"] } } };
  await source.tick();
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0]?.length, 1);
  assert.equal(f.batches[0]?.[0]?.component, "Backup");
  assert.equal(f.batches[0]?.[0]?.failureClass, "never-ran");
  assert.equal(f.batches[0]?.[0]?.summary, "task has never run");
  assert.equal(f.batches[0]?.[0]?.severity, "warning");
  f.db.prepare("UPDATE services SET last_result = '0', last_run = ?").run(T);
  await source.tick();
  assert.deepEqual(f.batches[1], [{ ...f.batches[0]?.[0], recovered: true, lastSeen: T, summary: "recovered" }]);
  await source.tick();
  assert.equal(f.batches.length, 2);
  assert.equal((f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string }).value, "[]");
  assert.deepEqual(f.logs, []);
});

test("never-run grace uses catalog first observation and configured or default days", async (t) => {
  for (const graceDays of [undefined, 0, 3, 365]) {
    const neverRan = { tasks: ["^backup$"], ...(graceDays === undefined ? {} : { graceDays }) };
    const f = fixture({ enabled: true, neverRan });
    t.after(() => f.db.close());
    const boundary = new Date(Date.parse(T) - (graceDays ?? 8) * 86_400_000).toISOString();
    f.db.prepare("UPDATE services SET last_result = '267011', first_seen_at = ?").run(new Date(Date.parse(boundary) + 1).toISOString());
    const source = new FleetCatalogSource(f.db, f.fleet, f.options);
    await source.tick();
    assert.equal(f.batches.length, 0);
    f.db.prepare("UPDATE services SET first_seen_at = ?").run(boundary);
    await source.tick();
    assert.equal(f.batches.length, 1);
    assert.equal(f.batches[0]?.[0]?.failureClass, "never-ran");
    assert.deepEqual(f.logs, []);
  }
});

test("increasing grace recovers a previously reported never-run task once", async (t) => {
  const f = fixture({ enabled: true, neverRan: { tasks: ["^backup$"], graceDays: 0 } });
  t.after(() => f.db.close());
  f.db.prepare("UPDATE services SET last_result = '267011'").run();
  const source = new FleetCatalogSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0]?.[0]?.failureClass, "never-ran");
  f.file.sources = { catalog: { enabled: true, neverRan: { tasks: ["^backup$"], graceDays: 8 } } };
  await source.tick();
  assert.deepEqual(f.batches[1], [{ ...f.batches[0]?.[0], recovered: true, lastSeen: T, summary: "recovered" }]);
  await source.tick();
  assert.equal(f.batches.length, 2);
  assert.equal((f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string }).value, "[]");
  assert.deepEqual(f.logs, []);
});

test("the configured scan age and task exclusions apply to catalog rows", async (t) => {
  const f = fixture({ enabled: true, staleScanMinutes: 1 });
  t.after(() => f.db.close());
  f.db.prepare("UPDATE services SET last_seen_at = '2026-10-31T17:58:00.000Z'").run();
  const source = new FleetCatalogSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches.length, 0);
  f.db.prepare("UPDATE services SET last_seen_at = ?").run(T);
  f.file.sources = { catalog: { enabled: true, tasks: { exclude: ["^BACKUP$"] } } };
  await source.tick();
  assert.equal(f.batches.length, 0);
  f.file.sources = { catalog: { enabled: true, tasks: { include: ["^BACKUP$"], exclude: [] } } };
  await source.tick();
  assert.equal(f.batches[0]?.length, 1);
});

test("a thrown accept stays inside tick and does not persist an unsent failure", async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.db.close());
  const accept = f.stub.accept;
  f.stub.accept = async () => { throw new Error("accept failed"); };
  const source = new FleetCatalogSource(f.db, f.fleet, f.options);
  await assert.doesNotReject(source.tick());
  assert.deepEqual(f.logs, ["fleet catalog tick failed: accept failed"]);
  assert.equal(f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get(), undefined);
  f.stub.accept = accept;
  f.db.prepare("UPDATE services SET last_result = '0'").run();
  await source.tick();
  assert.deepEqual(f.batches, []);
});

test("a failed recovery remains persisted for retry", async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.db.close());
  const source = new FleetCatalogSource(f.db, f.fleet, f.options);
  await source.tick();
  const accept = f.stub.accept;
  f.stub.accept = async () => { throw new Error("accept failed"); };
  f.db.prepare("UPDATE services SET last_result = '0'").run();
  await assert.doesNotReject(source.tick());
  const stored = f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string };
  assert.equal(JSON.parse(stored.value).length, 1);
  f.stub.accept = accept;
  await source.tick();
  assert.equal(f.batches[1]?.[0]?.recovered, true);
});

test("rejected packets do not advance the persisted state", async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.db.close());
  f.stub.accept = async () => ({ accepted: 0, rejected: [{ index: 0, error: "ingest failed" }] });
  await new FleetCatalogSource(f.db, f.fleet, f.options).tick();
  assert.equal(f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get(), undefined);
  assert.deepEqual(f.logs, ["fleet catalog tick failed: catalog source packets were rejected"]);
});

test("start and stop manage one injected timer with the default or supplied interval", async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.db.close());
  const callbacks: (() => void)[] = [];
  const intervals: number[] = [];
  let stops = 0;
  const every = (fn: () => void, ms: number) => {
    callbacks.push(fn);
    intervals.push(ms);
    return { stop: () => { stops += 1; } };
  };
  const source = new FleetCatalogSource(f.db, f.fleet, { ...f.options, every });
  source.start();
  source.start();
  assert.deepEqual(intervals, [120_000]);
  callbacks[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.batches.length, 1);
  source.stop();
  source.stop();
  assert.equal(stops, 1);
  const custom = new FleetCatalogSource(f.db, f.fleet, { ...f.options, every, intervalMs: 1000 });
  custom.start();
  assert.deepEqual(intervals, [120_000, 1000]);
  custom.stop();
  assert.equal(stops, 2);
});

test("a catalog failure that clears resolves only after the configured clean sweeps, through a real fleet service", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-catalog-"));
  const f = fixture({ enabled: true });
  const configPath = join(dir, "fleet.json");
  writeFileSync(configPath, JSON.stringify({ sources: { catalog: { enabled: true } }, policy: { resolveAfterCleanChecks: 3 } }));
  const service = new FleetService(f.db, { configPath, now: () => new Date(T), every: () => ({ stop() { /* ticks are called directly */ } }), run: async () => ({ code: 0, error: null }) });
  t.after(() => { service.stop(); f.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = new FleetCatalogSource(f.db, service, f.options);
  await source.tick();
  const [opened] = service.incidents({});
  assert.equal(opened?.state, "open");
  f.db.prepare("UPDATE services SET last_result = '0'").run();
  await source.tick();
  await source.tick();
  assert.equal(service.incidents({})[0]?.state, "open");
  assert.equal(incidentById(f.db, opened!.id)?.cleanChecks, 2);
  await source.tick();
  assert.equal(service.incidents({})[0]?.state, "resolved");
  const events = () => (f.db.prepare("SELECT COUNT(*) AS n FROM fleet_events WHERE incident_id = ?").get(opened!.id) as { n: number }).n;
  const before = events();
  await source.tick();
  await source.tick();
  assert.equal(events(), before);
  assert.equal((f.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string }).value, "[]");
});
