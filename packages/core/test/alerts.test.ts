import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { acknowledgeAlerts, alertsFileReader, alertsResponse, alertsSummary, evaluateAlerts, openCatalog, recordCloudflare, recordListeners, recordServices, refreshAlertMutes, setAlertMute, upsertMachine, type AlertFile, type Db, type ListenerFact, type ServiceFact } from "../src/index.ts";

const T = "2026-10-07T00:00:00.000Z";
const T2 = "2026-10-07T01:00:00.000Z";
const T3 = "2026-10-07T02:00:00.000Z";
const listener = (port = 8080, bind: ListenerFact["bind"] = "loopback", overrides: Partial<ListenerFact> = {}): ListenerFact => ({ port, bind, protocol: "tcp", address: "127.0.0.1", pid: port, processName: "node", processPath: "C:/Tools/node.exe", container: null, ...overrides });
const service = (name = "Example", overrides: Partial<ServiceFact> = {}): ServiceFact => ({ kind: "windows-service", name, displayName: null, domain: "system", program: "C:/Tools/example.exe", state: "running", startMode: "auto", enabled: true, pid: 9000, runAs: null, triggers: null, lastRun: null, lastResult: null, ...overrides });
const listen = (db: Db, facts: ListenerFact[], at = T2, machine = "hub"): void => { recordListeners(db, machine, { origin: "listeners", status: "ok", facts }, at); };
const serve = (db: Db, facts: ServiceFact[], at = T2): void => { recordServices(db, "hub", { origin: "services", status: "ok", facts }, at); };
const all = (db: Db) => alertsResponse(db, new URLSearchParams("state=all&include=muted"), T3).alerts;

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  listen(db, [listener(8000)], T);
  serve(db, [service("Baseline")], T);
  assert.deepEqual(evaluateAlerts(db, T), []);
  return db;
}

function edge(db: Db): void {
  recordCloudflare(db, { zones: [{ id: "zone", name: "example.test" }], tunnels: [{ id: "tunnel", name: "Hub", status: "healthy", connections: 1, remoteManaged: true }], ingress: [{ tunnelId: "tunnel", position: 0, hostname: "scout.example.test", path: null, service: "http://localhost:8080" }], dns: [], accessApps: [], workerRoutes: [] }, T, null);
}

test("the machine baseline suppresses existing events and remains independent for each machine", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  listen(db, [listener(8000)], T);
  listen(db, [listener(8000), listener()], T2);
  assert.deepEqual(evaluateAlerts(db, T2), []);
  listen(db, [listener(8000), listener(), listener(8090)], T3);
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  listen(db, [listener()], T2, "mini");
  assert.equal(evaluateAlerts(db, T3).filter((event) => event.change === "created").length, 1);
  assert.equal(all(db)[0]!.machineName, "Hub");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alert_baseline").get()!.n, 2);
});

test("an empty first scan establishes a baseline and the next listener alerts", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  listen(db, [], T);
  serve(db, [], T);
  assert.deepEqual(evaluateAlerts(db, T, { machineId: "hub" }), []);
  listen(db, [listener()], T2);
  serve(db, [service()], T2);
  assert.deepEqual(evaluateAlerts(db, T2).map((event) => event.alert.kind).sort(), ["new-daemon", "new-listener"]);
});

test("per-connection launchd jobs never alert and launchd wording names the job", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "macos", kind: "host" });
  const launchd = (name: string): ServiceFact => service(name, { kind: "launchd", program: "/opt/worker/run" });
  serve(db, [launchd("com.example.keep")], T);
  assert.deepEqual(evaluateAlerts(db, T), []);
  serve(db, [launchd("com.example.keep"), launchd("com.openssh.sshd.58B8D9F0-F6E9-466C-9A7D-1B03CD601D05"), launchd("application.com.example.12345.67890"), launchd("com.example.new")], T2);
  const created = evaluateAlerts(db, T2).filter((event) => event.change === "created");
  assert.equal(created.length, 1);
  assert.equal(created[0]!.alert.detail, "The launchd job is running with auto startup.");
  serve(db, [launchd("com.example.keep"), launchd("com.openssh.sshd.58B8D9F0-F6E9-466C-9A7D-1B03CD601D05")], T3);
  assert.deepEqual(evaluateAlerts(db, T3).filter((event) => event.alert.kind === "service-down" && /sshd|application/.test(event.alert.title)), []);
});

test("listeners in the dynamic port range stay quiet on every interface", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener(60000), listener(60001, "all")]);
  const created = evaluateAlerts(db, T2).filter((event) => event.change === "created");
  assert.deepEqual(created.map((event) => event.alert.title), []);
  listen(db, [listener(8000), listener(60000), listener(60001, "all"), listener(9000, "all")], T3);
  assert.deepEqual(evaluateAlerts(db, T3).filter((event) => event.change === "created").map((event) => event.alert.title), ["New listener on Hub: port 9000 (node)"]);
});

test("new listeners deduplicate, resolve when gone and create a new occurrence when they return", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener()]);
  const created = evaluateAlerts(db, T2);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.alert.key, "new-listener:hub:8080:node");
  assert.equal(created[0]!.alert.severity, "info");
  assert.deepEqual(evaluateAlerts(db, T2), []);
  const id = created[0]!.alert.id;
  listen(db, [listener(8000)], T3);
  assert.ok(evaluateAlerts(db, T3).some((event) => event.change === "resolved" && event.alert.id === id));
  listen(db, [listener(8000), listener()], T3);
  const reopened = evaluateAlerts(db, T3).find((event) => event.alert.kind === "new-listener")!;
  assert.equal(reopened.change, "created");
  assert.notEqual(reopened.alert.id, id);
  assert.equal(all(db).filter((row) => row.key === reopened.alert.key).length, 2);
});

test("all-interface listeners warn and narrowing never creates an exposure alert", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener(8080, "all")]);
  assert.equal(evaluateAlerts(db, T2)[0]!.alert.severity, "warn");
  listen(db, [listener(8000), listener(8080, "lan")], T3);
  assert.deepEqual(evaluateAlerts(db, T3), []);
  listen(db, [listener(8000), listener(8080, "loopback")], T3);
  assert.deepEqual(evaluateAlerts(db, T3), []);
});

for (const [from, to, severity] of [["loopback", "lan", "warn"], ["loopback", "all", "high"], ["lan", "all", "high"]] as const) {
  test(`exposure from ${from} to ${to} has ${severity} severity and resolves after narrowing`, (t) => {
    const db = seed(t);
    db.prepare("UPDATE listeners SET bind = ?").run(from);
    listen(db, [listener(8000, to)], T2);
    const change = evaluateAlerts(db, T2)[0]!;
    assert.equal(change.alert.kind, "exposure-change");
    assert.equal(change.alert.severity, severity);
    listen(db, [listener(8000, from)], T3);
    assert.equal(evaluateAlerts(db, T3)[0]!.change, "resolved");
  });
}

test("new optional and third-party daemons alert, resolve on removal and return as new occurrences", (t) => {
  const db = seed(t);
  serve(db, [service("Baseline"), service("New"), service("Fax", { program: "C:/Windows/System32/fxssvc.exe" })]);
  const changes = evaluateAlerts(db, T2);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((event) => event.alert.kind === "new-daemon" && event.alert.severity === "info"));
  serve(db, [service("Baseline")], T3);
  assert.equal(evaluateAlerts(db, T3).filter((event) => event.change === "resolved").length, 2);
  serve(db, [service("Baseline"), service("New")], T3);
  assert.ok(evaluateAlerts(db, T3).some((event) => event.change === "created" && event.alert.kind === "new-daemon"));
});

test("a second exposure widening raises severity without duplicating the active key", (t) => {
  const db = seed(t);
  listen(db, [listener(8000, "lan")]);
  const first = evaluateAlerts(db, T2)[0]!.alert;
  assert.equal(first.severity, "warn");
  listen(db, [listener(8000, "all")], T3);
  const widened = evaluateAlerts(db, T3)[0]!.alert;
  assert.equal(widened.id, first.id);
  assert.equal(widened.severity, "high");
  assert.equal(alertsSummary(db).high, 1);
  assert.equal(all(db).length, 1);
  assert.deepEqual(evaluateAlerts(db, T3), []);
});

test("container identities with the same port and process have distinct alert keys", (t) => {
  const db = seed(t);
  const a = listener(8080, "loopback", { container: { name: "one", image: "fixture:1", containerPort: 80 } });
  const b = listener(8080, "all", { container: { name: "two", image: "fixture:1", containerPort: 80 } });
  listen(db, [listener(8000), a, b]);
  const changes = evaluateAlerts(db, T2);
  assert.equal(changes.length, 2);
  assert.equal(new Set(changes.map((event) => event.alert.key)).size, 2);
  assert.notEqual(changes[0]!.alert.target.id, changes[1]!.alert.target.id);
  assert.deepEqual(changes.map((event) => event.alert.severity).sort(), ["info", "warn"]);
});

test("an exposure that narrows before evaluation produces no alert", (t) => {
  const db = seed(t);
  listen(db, [listener(8000, "all")]);
  listen(db, [listener(8000, "loopback")], T3);
  assert.deepEqual(evaluateAlerts(db, T3), []);
});

test("services that stop or disappear warn, recover and reopen after another stop", (t) => {
  const db = seed(t);
  serve(db, [service("Baseline", { state: "stopped", pid: null })]);
  const stopped = evaluateAlerts(db, T2)[0]!;
  assert.equal(stopped.alert.kind, "service-down");
  assert.equal(stopped.alert.severity, "warn");
  serve(db, [service("Baseline")], T3);
  assert.equal(evaluateAlerts(db, T3)[0]!.change, "resolved");
  serve(db, [], T3);
  assert.notEqual(evaluateAlerts(db, T3)[0]!.alert.id, stopped.alert.id);
});

test("stopped services that never ran and expected-down rows remain quiet", (t) => {
  const db = seed(t);
  db.prepare("UPDATE services SET expected_down = 1").run();
  db.prepare("UPDATE listeners SET expected_down = 1").run();
  serve(db, [service("Baseline", { state: "stopped" })]);
  listen(db, []);
  assert.deepEqual(evaluateAlerts(db, T2), []);
  db.prepare("UPDATE services SET expected_down = 0").run();
  serve(db, [service("Baseline", { state: "disabled" })], T3);
  assert.deepEqual(evaluateAlerts(db, T3), []);
});

test("hidden rows and exposed essential rows never create alerts", (t) => {
  const db = seed(t);
  const essential = service("RpcSs", { program: "C:/Windows/System32/svchost.exe", pid: 8080 });
  serve(db, [service("Baseline"), essential]);
  listen(db, [listener(8000), listener(8080, "all", { processName: "svchost", processPath: essential.program })]);
  assert.deepEqual(evaluateAlerts(db, T2), []);
  serve(db, [service("Baseline"), { ...essential, state: "stopped" }], T3);
  listen(db, [listener(8000)], T3);
  assert.deepEqual(evaluateAlerts(db, T3), []);
});

test("domain origins and their listeners alert high and resolve when the origin returns", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener()], T);
  edge(db);
  evaluateAlerts(db, T);
  listen(db, [listener(8000)]);
  const changes = evaluateAlerts(db, T2);
  const domain = changes.find((event) => event.alert.kind === "domain-origin-down")!;
  const stopped = changes.find((event) => event.alert.kind === "service-down")!;
  assert.equal(domain.alert.severity, "high");
  assert.equal(domain.alert.target.type, "route");
  assert.equal(stopped.alert.severity, "high");
  assert.deepEqual(evaluateAlerts(db, T2), []);
  listen(db, [listener(8000), listener()], T3);
  const returned = evaluateAlerts(db, T3);
  assert.ok(returned.some((event) => event.alert.id === domain.alert.id && event.change === "resolved"));
  assert.ok(returned.some((event) => event.alert.id === stopped.alert.id && event.change === "resolved"));
  listen(db, [listener(8000)], T3);
  assert.notEqual(evaluateAlerts(db, T3).find((event) => event.alert.kind === "domain-origin-down")!.alert.id, domain.alert.id);
});

test("dangling DNS alerts without a machine and resolves after a route disappears", (t) => {
  const db = seed(t);
  recordCloudflare(db, { zones: [{ id: "zone", name: "example.test" }], dns: [{ zone: "zone", name: "dangling.example.test", type: "CNAME", content: "dead.cfargotunnel.com", proxied: true }] }, T2, null);
  const alert = evaluateAlerts(db, T2)[0]!.alert;
  assert.equal(alert.kind, "domain-origin-down");
  assert.equal(alert.machineId, null);
  recordCloudflare(db, { dns: [] }, T3, null);
  assert.equal(evaluateAlerts(db, T3)[0]!.change, "resolved");
});

test("a stopped domain service stays high after its pid and listener disappear", (t) => {
  const db = seed(t);
  serve(db, [service("Baseline", { pid: 8080, program: "C:/Tools/node.exe" })], T);
  listen(db, [listener(8000), listener()], T);
  edge(db);
  evaluateAlerts(db, T);
  serve(db, [service("Baseline", { state: "stopped", pid: null, program: "C:/Tools/node.exe" })]);
  listen(db, [listener(8000)]);
  const stopped = evaluateAlerts(db, T2).find((event) => event.alert.target.type === "service")!;
  assert.equal(stopped.alert.kind, "service-down");
  assert.equal(stopped.alert.severity, "high");
});

test("an unknown route does not resolve a known down origin", (t) => {
  const db = seed(t);
  edge(db);
  const domain = evaluateAlerts(db, T2).find((event) => event.alert.kind === "domain-origin-down")!.alert;
  recordCloudflare(db, { tunnels: [{ id: "tunnel", name: "Hub", status: "down", connections: 0, remoteManaged: true }] }, T3, null);
  evaluateAlerts(db, T3);
  assert.equal(all(db).find((row) => row.id === domain.id)!.state, "open");
});

test("file globs and exact page mutes suppress counts and retain stored muted alerts", (t) => {
  const db = seed(t);
  const file: AlertFile = { ungatedHosts: [], mute: [{ match: "new-listener:hub:80?0:*", reason: "development" }], at: T, fileError: null };
  listen(db, [listener(8000), listener(), listener(8090)]);
  const options = { loadMutes: () => file };
  assert.ok(evaluateAlerts(db, T2, options).every((event) => event.alert.muted));
  assert.equal(alertsSummary(db).open, 0);
  assert.equal(alertsResponse(db).total, 0);
  assert.equal(all(db).length, 2);
  file.mute = [];
  assert.equal(refreshAlertMutes(db, options).length, 2);
  setAlertMute(db, { key: "new-listener:hub:8080:node", reason: "temporary" }, T3);
  refreshAlertMutes(db, options);
  assert.equal(alertsSummary(db).open, 1);
  assert.equal(alertsResponse(db, undefined, T3, options).mutes[0]!.source, "page");
  setAlertMute(db, { key: "new-listener:hub:8080:node", remove: true });
  refreshAlertMutes(db, options);
  assert.equal(alertsSummary(db).open, 2);
});

test("ungated hosts mute exposure and open-host origin alerts while gated host origins stay counted", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener()], T);
  edge(db);
  const file: AlertFile = { ungatedHosts: ["scout.example.test"], mute: [], at: T, fileError: null };
  const options = { loadMutes: () => file };
  evaluateAlerts(db, T, options);
  listen(db, [listener(8000), listener(8080, "all")]);
  assert.equal(evaluateAlerts(db, T2, options)[0]!.alert.muted, true);
  listen(db, [listener(8000)], T3);
  assert.equal(evaluateAlerts(db, T3, options).find((event) => event.alert.kind === "domain-origin-down")!.alert.muted, true);
  recordCloudflare(db, { accessApps: [{ id: "app", name: "Scout", domain: "scout.example.test", policies: 1 }] }, T3, null);
  const changed = evaluateAlerts(db, T3, options);
  assert.ok(changed.some((event) => event.alert.kind === "domain-origin-down" && event.change === "muted" && !event.alert.muted));
});

test("acknowledgements support ids, kind-scoped all, idempotence and missing ids", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener()]);
  serve(db, [service("Baseline"), service("New")]);
  const created = evaluateAlerts(db, T2);
  const id = created.find((event) => event.alert.kind === "new-listener")!.alert.id;
  assert.equal(acknowledgeAlerts(db, { id }, T3)![0]!.alert.acknowledgedAt, T3);
  assert.deepEqual(acknowledgeAlerts(db, { id }), []);
  assert.equal(acknowledgeAlerts(db, { id: 999 }), null);
  assert.equal(acknowledgeAlerts(db, { all: true, kind: "new-daemon" })!.length, 1);
  assert.equal(alertsSummary(db).open, 0);
  assert.equal(alertsSummary(db).latestAt, null);
  assert.equal(alertsResponse(db, new URLSearchParams("state=acknowledged&kind=new-daemon&machine=hub&limit=1")).total, 1);
  for (const body of [{}, { id: "1" }, { all: false }, { all: true, id }, { all: true, kind: "bad" }]) assert.throws(() => acknowledgeAlerts(db, body));
});

test("alert queries validate filters and sort newest first", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener()], T2);
  evaluateAlerts(db, T2);
  listen(db, [listener(8000), listener(), listener(8090)], T3);
  evaluateAlerts(db, T3);
  assert.equal(alertsResponse(db, new URLSearchParams("limit=1")).alerts[0]!.at, T3);
  assert.equal(alertsResponse(db, new URLSearchParams("limit=1")).total, 2);
  for (const query of ["state=bad", "kind=bad", "limit=0", "limit=501", "limit=1.5", "include=bad"]) assert.throws(() => alertsResponse(db, new URLSearchParams(query)));
});

test("the optional alerts file caches its mtime, ignores malformed content and notices removal", (t) => {
  const directory = mkdtempSync(join(process.cwd(), ".scout-alerts-test-"));
  const path = join(directory, "alerts.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const load = alertsFileReader(path);
  assert.equal(load().fileError, null);
  writeFileSync(path, JSON.stringify({ ungatedHosts: ["SCOUT.example.test"], mute: [{ match: "*", reason: "test" }] }));
  const first = load();
  assert.equal(load(), first);
  assert.deepEqual(first.ungatedHosts, ["scout.example.test"]);
  writeFileSync(path, "{");
  utimesSync(path, new Date(T2), new Date(T2));
  const invalid = load();
  assert.ok(invalid.fileError);
  assert.deepEqual(invalid.mute, []);
  assert.equal(load(), invalid);
  rmSync(path);
  assert.equal(load().fileError, null);
});

test("the evaluator rolls back watermarks and alert changes after a catalog error", (t) => {
  const db = seed(t);
  listen(db, [listener(8000), listener()]);
  const watermark = db.prepare("SELECT event_id FROM alert_baseline WHERE machine_id = 'hub'").get()!.event_id;
  db.exec("CREATE TRIGGER reject_alert BEFORE INSERT ON alerts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => evaluateAlerts(db, T2));
  assert.equal(db.prepare("SELECT event_id FROM alert_baseline WHERE machine_id = 'hub'").get()!.event_id, watermark);
  assert.equal(all(db).length, 0);
  db.exec("DROP TRIGGER reject_alert");
  assert.equal(evaluateAlerts(db, T2).length, 1);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, "3");
});
