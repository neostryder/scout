import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertsResponse, defaultWatchConfig, evaluateAlerts, formatDuration, isWatched, listOutages, openCatalog, outageNotice, outagesResponse, parseWatchConfig, recordListeners, recordMonitorGap, recordObservations, recordServices, resetWatchCounters, serviceObservations, serviceOwnsListener, serviceWatchKey, settleUnwatched, urlObservations, updateWatchFile, upsertMachine, watchFileReader, type Db, type Observation, type ServiceFact } from "../src/index.ts";

const AT = "2026-10-10T00:00:00.000Z";
const stamp = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const machine = (at: number, ok: boolean, state = ok ? "up" : "hung"): Observation => ({ key: "machine:gm", kind: "machine", machineId: "gm", label: "Server", ok, state, detail: ok ? "" : "Port 22 accepted a connection but sent no SSH banner.", at: stamp(at) });
const service: ServiceFact = { kind: "windows-service", name: "worker", displayName: "Worker", domain: "system", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null };

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "gm", name: "Server", os: "macos", kind: "host" });
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  return db;
}

test("one failed check is not an outage and two in a row are, starting at the first failure", (t) => {
  const db = seed(t);
  assert.deepEqual(recordObservations(db, [machine(0, true)]), []);
  assert.deepEqual(recordObservations(db, [machine(2, false)]), []);
  const confirmed = recordObservations(db, [machine(4, false)]);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]!.change, "confirmed");
  assert.equal(confirmed[0]!.outage.startedAt, stamp(2));
  assert.equal(confirmed[0]!.outage.confirmedAt, stamp(4));
  assert.equal(confirmed[0]!.outage.state, "hung");
  assert.equal(listOutages(db, { state: "open", now: stamp(5) }).length, 1);
});

test("a recovery closes the outage with its duration and a restart that ends before the second check is silent", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, false)]);
  assert.deepEqual(recordObservations(db, [machine(2, true)]), []);
  assert.equal(listOutages(db).length, 0);
  recordObservations(db, [machine(4, false)]);
  recordObservations(db, [machine(6, false)]);
  const [done] = recordObservations(db, [machine(66, true)]);
  assert.equal(done!.change, "recovered");
  assert.equal(done!.outage.startedAt, stamp(4));
  assert.equal(done!.outage.endedAt, stamp(66));
  assert.equal(done!.outage.durationMs, 62 * 60_000);
  assert.equal(listOutages(db, { state: "open" }).length, 0);
  assert.match(outageNotice(done!).body, /after 1 h 2 min/);
});

test("a change of failure state updates the open outage and repeated or late checks are ignored", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, false), ]);
  recordObservations(db, [machine(2, false)]);
  const [changed] = recordObservations(db, [machine(4, false, "down")]);
  assert.equal(changed!.change, "updated");
  assert.equal(listOutages(db)[0]!.state, "down");
  assert.deepEqual(recordObservations(db, [machine(4, false, "down")]), []);
  assert.deepEqual(recordObservations(db, [machine(1, true)]), []);
  assert.equal(listOutages(db, { state: "open" }).length, 1);
});

test("three separate failures inside 30 minutes make a flapping outage that clears after a quiet half hour", (t) => {
  const db = seed(t);
  const flap: string[] = [];
  const feed = (at: number, ok: boolean): void => { for (const change of recordObservations(db, [machine(at, ok)])) if (change.outage.kind === "flapping") flap.push(change.change); };
  feed(0, false); feed(2, true); feed(4, false); feed(6, true); feed(8, false);
  assert.deepEqual(flap, ["confirmed"]);
  assert.equal(listOutages(db, { state: "open" })[0]!.kind, "flapping");
  feed(10, true);
  assert.deepEqual(flap, ["confirmed"]);
  feed(50, true);
  assert.deepEqual(flap, ["confirmed", "recovered"]);
});

test("switching an item off closes its open outage and drops its counters", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, false)]);
  recordObservations(db, [machine(2, false)]);
  const changes = settleUnwatched(db, { kind: "machine", machineId: "gm" }, new Set(), stamp(3));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.change, "recovered");
  assert.match(changes[0]!.outage.detail, /no longer watched/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_state").get()!.n, 0);
});

test("a hub restart resets the failure counters so the first failed check starts over", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, false)]);
  resetWatchCounters(db);
  assert.deepEqual(recordObservations(db, [machine(2, false)]), []);
  assert.equal(recordObservations(db, [machine(4, false)]).length, 1);
});

test("a monitor gap is recorded once with its real start and end and is never open", (t) => {
  const db = seed(t);
  const first = recordMonitorGap(db, stamp(-60), stamp(0), "Hub");
  assert.equal(first.outage.kind, "monitor-gap");
  assert.equal(first.outage.durationMs, 3_600_000);
  recordMonitorGap(db, stamp(-60), stamp(0), "Hub");
  assert.equal(listOutages(db).length, 1);
  assert.equal(listOutages(db, { state: "open" }).length, 0);
  assert.match(outageNotice(first).title, /Scout was not running/);
});

test("services are watched only after being seen running and an outage needs two fresh reads", (t) => {
  const db = seed(t);
  const config = defaultWatchConfig();
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [{ ...service, state: "stopped" }] }, stamp(0));
  assert.deepEqual(serviceObservations(db, "gm", config, stamp(0)), []);
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [service] }, stamp(1));
  recordObservations(db, serviceObservations(db, "gm", config, stamp(1)));
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [{ ...service, state: "stopped" }] }, stamp(3));
  assert.deepEqual(recordObservations(db, serviceObservations(db, "gm", config, stamp(3))), []);
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [{ ...service, state: "stopped" }] }, stamp(5));
  const [confirmed] = recordObservations(db, serviceObservations(db, "gm", config, stamp(5)));
  assert.equal(confirmed!.outage.kind, "service");
  assert.equal(confirmed!.outage.startedAt, stamp(3));
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [service] }, stamp(7));
  assert.equal(recordObservations(db, serviceObservations(db, "gm", config, stamp(7)))[0]!.change, "recovered");
});

test("manual-start, hidden and opted-out services are not watched", (t) => {
  const db = seed(t);
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [service, { ...service, name: "ondemand", startMode: "manual" }] }, stamp(0));
  const keys = serviceObservations(db, "gm", defaultWatchConfig(), stamp(0)).map((obs) => obs.key);
  assert.deepEqual(keys, [serviceWatchKey({ machineId: "gm", kind: "windows-service", domain: "system", name: "worker" } as never)]);
  const off = parseWatchConfig({ items: { [keys[0]!]: false } });
  assert.deepEqual(serviceObservations(db, "gm", off, stamp(0)), []);
  assert.deepEqual(serviceObservations(db, "gm", parseWatchConfig({ machines: { gm: false } }), stamp(0)), []);
});

test("an open outage raises one alert that resolves on recovery and the immediate service-down alert stays quiet for watched services", (t) => {
  const db = seed(t);
  const config = defaultWatchConfig();
  const options = { loadWatch: () => config };
  recordObservations(db, [machine(0, false)]);
  assert.equal(evaluateAlerts(db, stamp(1), options).filter((change) => change.alert.kind === "machine-outage").length, 0);
  recordObservations(db, [machine(2, false)]);
  const created = evaluateAlerts(db, stamp(3), options).filter((change) => change.alert.kind === "machine-outage");
  assert.equal(created.length, 1);
  assert.equal(created[0]!.alert.severity, "high");
  assert.equal(created[0]!.alert.machineName, "Server");
  assert.deepEqual(evaluateAlerts(db, stamp(4), options), []);
  recordObservations(db, [machine(5, true)]);
  const resolved = evaluateAlerts(db, stamp(6), options).filter((change) => change.change === "resolved");
  assert.equal(resolved.length, 1);
  assert.equal(alertsResponse(db, new URLSearchParams("kind=machine-outage&state=all"), stamp(6)).alerts.length, 1);

  recordServices(db, "gm", { origin: "services", status: "ok", facts: [service] }, stamp(10));
  evaluateAlerts(db, stamp(10), options);
  recordObservations(db, serviceObservations(db, "gm", config, stamp(10)));
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [{ ...service, state: "stopped" }] }, stamp(12));
  const downs = evaluateAlerts(db, stamp(12), options).filter((change) => change.alert.kind === "service-down");
  assert.equal(downs.length, 0);
  const withoutWatch = evaluateAlerts(db, stamp(13)).filter((change) => change.alert.kind === "service-down");
  assert.equal(withoutWatch.length, 0, "no new event, so the alert path is unchanged");
});

test("the watch file reads defaults, validates edits and writes only what is off", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "watch.json");
  const read = watchFileReader(path);
  assert.deepEqual(read(), defaultWatchConfig());
  let config = updateWatchFile(path, read(), { machine: "gm", watched: false });
  config = updateWatchFile(path, config, { check: "url", watched: false });
  config = updateWatchFile(path, config, { item: "service:gm:x", watched: false });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pausedUntil: null, machines: { gm: false }, checks: { machine: true, url: false, service: true }, items: { "service:gm:x": false } });
  assert.equal(isWatched(read(), "machine", "gm", "machine:gm", AT), false);
  assert.equal(isWatched(read(), "machine", "hub", "machine:hub", AT), true);
  assert.equal(isWatched(read(), "url", null, "url:x", AT), false);
  config = updateWatchFile(path, read(), { machine: "gm", watched: true });
  assert.deepEqual(config.machines, {});
  config = updateWatchFile(path, config, { pausedUntil: stamp(60) });
  assert.equal(isWatched(config, "machine", "hub", "machine:hub", stamp(30)), false);
  assert.equal(isWatched(config, "machine", "hub", "machine:hub", stamp(61)), true);
  assert.throws(() => updateWatchFile(path, config, { machine: "gm" }), /watched/);
  assert.throws(() => updateWatchFile(path, config, { check: "mail", watched: false }), /check must be/);
  assert.throws(() => updateWatchFile(path, config, { bogus: 1 }), /unknown field/);
  writeFileSync(path, "{ not json");
  assert.match(watchFileReader(path)().fileError ?? "", /malformed/);
});

test("the outages response lists open and past outages with the watched items and durations read well", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, false)]);
  recordObservations(db, [machine(2, false)]);
  const response = outagesResponse(db, defaultWatchConfig(), new URLSearchParams(), stamp(32));
  assert.equal(response.open, 1);
  assert.equal(response.outages[0]!.durationMs, 32 * 60_000);
  assert.equal(response.items[0]!.watched, true);
  assert.throws(() => outagesResponse(db, defaultWatchConfig(), new URLSearchParams("state=bogus")), /invalid state/);
  assert.deepEqual([45_000, 125_000, 3_720_000, 200_000_000].map(formatDuration), ["45 s", "2 min", "1 h 2 min", "2 d 7 h"]);
});

test("an outage notice and alert give local time to the second and the minutes since the last passing check", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, true)]);
  recordObservations(db, [machine(2, false)]);
  const [opened] = recordObservations(db, [machine(4, false)]);
  const body = outageNotice(opened!).body;
  assert.match(body, /Down since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+ \(4 minutes since the last successful check\)\./);
  assert.doesNotMatch(body, /T\d\d:\d\d:\d\d\.\d{3}Z/);
  evaluateAlerts(db, stamp(5));
  const alert = alertsResponse(db, new URLSearchParams("kind=machine-outage"), stamp(5)).alerts[0]!;
  assert.match(alert.detail, /\(4 minutes since the last successful check\)\.$/);
});

test("an item that never passed a check says so, and a recovery reports no last-check text", (t) => {
  const db = seed(t);
  recordObservations(db, [machine(0, false)]);
  const [opened] = recordObservations(db, [machine(2, false)]);
  assert.match(outageNotice(opened!).body, /\(no successful check on record\)\./);
  const [done] = recordObservations(db, [machine(10, true)]);
  assert.equal(done!.outage.lastOkAt, null);
  assert.doesNotMatch(outageNotice(done!).body, /since the last successful check/);
});

test("only items meant to stay up are watched: automatic services, launchd keep-alive jobs, and listeners they own, containers, or routes serve", (t) => {
  const db = seed(t);
  const task: ServiceFact = { ...service, kind: "scheduled-task", name: "\Nightly", displayName: "Nightly", pid: null, startMode: null };
  const agent: ServiceFact = { ...service, kind: "launchd", name: "tools.example.keeper", displayName: null, domain: "gui", program: "/opt/keeper", pid: 77, startMode: null, keepAlive: true };
  const helper: ServiceFact = { ...service, kind: "launchd", name: "tools.example.helper", displayName: null, domain: "gui", program: "/opt/helper", pid: 78, startMode: null, keepAlive: false };
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [service, task, agent, helper] }, stamp(0));
  const listener = (port: number, pid: number | null, processName: string, processPath: string | null, container: { name: string; image: string; containerPort: number } | null = null) => ({ port, protocol: "tcp" as const, address: "0.0.0.0", bind: "all" as const, pid, processName, processPath, container });
  recordListeners(db, "gm", { origin: "listeners", status: "ok", facts: [
    listener(8001, 42, "worker", "C:/Tools/worker.exe"),
    listener(8002, 77, "keeper", "/opt/keeper"),
    listener(8003, 900, "msedge", "C:/Program Files/Edge/msedge.exe"),
    listener(8004, 78, "helper", "/opt/helper"),
    listener(8005, 901, "docker-proxy", null, { name: "web-1", image: "web", containerPort: 80 }),
  ] }, stamp(0));
  const labels = (): string[] => serviceObservations(db, "gm", defaultWatchConfig(), stamp(1)).map((obs) => obs.label).sort();
  const stays = ["Port 8001 (worker) on Server", "Port 8002 (keeper) on Server", "Port 8005 (docker-proxy) on Server", "Worker on Server", "tools.example.keeper on Server"];
  assert.deepEqual(labels(), stays);
  db.prepare("INSERT INTO meta (key, value) VALUES ('alert_routes', ?)").run(JSON.stringify({ "app.example.test:": { state: "ok", machineId: "gm", listenerId: null, serviceId: null, port: 8003 } }));
  assert.deepEqual(labels(), [...stays, "Port 8003 (msedge) on Server"].sort());
  const forced = parseWatchConfig({ items: { "listener:gm:8004:helper": true } });
  assert.ok(serviceObservations(db, "gm", forced, stamp(1)).some((obs) => obs.label === "Port 8004 (helper) on Server"));
});

test("a hostname that never answered a probe is not watched, and one that answered once is", (t) => {
  const db = seed(t);
  const put = db.prepare("INSERT INTO health_targets (key, kind, label, machine_id, port, url, state, failures, last_ok_at, last_probe_at, last_status, last_error) VALUES (?, 'domain', ?, NULL, NULL, ?, 'failing', 1, ?, ?, 530, 'HTTP 530')");
  put.run("domain:never.example.test", "never.example.test", "https://never.example.test/", null, stamp(5));
  put.run("domain:once.example.test", "once.example.test", "https://once.example.test/", stamp(1), stamp(5));
  assert.deepEqual(urlObservations(db, defaultWatchConfig(), stamp(6)).map((obs) => obs.label), ["once.example.test"]);
});

test("a service that stays up owns the listeners its child processes open", () => {
  const service = { machineId: "mini", pid: 100, program: null } as never;
  const child = { machineId: "mini", pid: 200, ppid: 100, processPath: null } as never;
  const stranger = { machineId: "mini", pid: 300, ppid: 99, processPath: null } as never;
  assert.equal(serviceOwnsListener(service, child), true);
  assert.equal(serviceOwnsListener(service, stranger), false);
});
