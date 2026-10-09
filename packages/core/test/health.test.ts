import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { acknowledgeAlerts, alertsResponse, alertsSummary, buildHealthTargets, evaluateAlerts, healthResponse, healthRow, healthState, healthSummary, healthTarget, listListeners, listRoutes, listServices, openCatalog, recordCloudflare, recordListeners, recordServices, resetHealthFailures, retainHealthSamples, setAlertMute, storeHealthSample, syncHealthTargets, tlsDaysLeft, upsertMachine, type Db, type HealthSample, type ListenerFact, type ServiceFact } from "../src/index.ts";

const AT = "2026-10-07T00:00:00.000Z";
const DAY = 86_400_000;
const stamp = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();
const listener = (port = 8080, overrides: Partial<ListenerFact> = {}): ListenerFact => ({ port, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 42, processName: "node", processPath: "C:/Tools/node.exe", container: null, ...overrides });
const service: ServiceFact = { kind: "windows-service", name: "worker", displayName: null, domain: "system", program: "C:/Tools/node.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null };
const sample = (overrides: Partial<HealthSample> = {}): HealthSample => ({ at: AT, ok: true, status: 200, latencyMs: 12, error: null, tlsNotAfter: null, ...overrides });

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [listener()] }, AT);
  recordCloudflare(db, { zones: [{ id: "zone", name: "example.test" }], dns: [{ zone: "example.test", name: "scout.example.test", type: "A", content: "192.0.2.1", proxied: true }] }, AT, null);
  syncHealthTargets(db, AT);
  return db;
}

test("health targets use catalog domains and visible Hub ports and exclude Mac and wildcard rows", (t) => {
  const db = seed(t);
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [listener(), listener(135, { processName: "svchost", processPath: "C:/Windows/System32/svchost.exe" }), listener(8080, { address: "0.0.0.0", bind: "all" })] }, AT);
  recordListeners(db, "mini", { origin: "listeners", status: "ok", facts: [listener(9000)] }, AT);
  recordCloudflare(db, { dns: [{ zone: "example.test", name: "scout.example.test", type: "A", content: "192.0.2.1", proxied: true }, { zone: "example.test", name: "*.example.test", type: "A", content: "192.0.2.1", proxied: true }] }, AT, null);
  assert.deepEqual(buildHealthTargets(db).map((row) => [row.key, row.url]).sort(), [["domain:scout.example.test", "https://scout.example.test/"], ["listener:hub:8080", "http://127.0.0.1:8080/"]]);
  assert.equal(listListeners(db).find((row) => row.machineId === "mini")!.health, null);
  assert.equal(listListeners(db).find((row) => row.port === 135)!.health, null);
});

test("gone targets retain history and returning targets start with no failure streak", (t) => {
  const db = seed(t);
  storeHealthSample(db, "listener:hub:8080", sample({ ok: false, status: null, error: "timeout" }));
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [] }, stamp(1));
  syncHealthTargets(db, stamp(1));
  assert.equal(healthTarget(db, "listener:hub:8080"), null);
  assert.equal(healthResponse(db).targets.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples").get()!.n, 1);
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [listener()] }, stamp(2));
  syncHealthTargets(db, stamp(2));
  assert.equal(healthTarget(db, "listener:hub:8080")!.failures, 0);
  assert.equal(healthTarget(db, "listener:hub:8080")!.state, "unknown");
});

test("health states count failures and recover from down and non-HTTP samples", (t) => {
  const db = seed(t);
  const key = "listener:hub:8080";
  assert.equal(healthRow(db, key).state, "unknown");
  storeHealthSample(db, key, sample({ at: stamp(-1) }));
  for (const [index, state] of ["failing", "failing", "down"].entries()) {
    storeHealthSample(db, key, sample({ at: stamp(index), ok: false, status: 503, error: "HTTP 503" }));
    assert.equal(healthTarget(db, key)!.state, state);
    assert.equal(healthTarget(db, key)!.failures, index + 1);
  }
  assert.equal(storeHealthSample(db, key, sample({ at: stamp(4), latencyMs: 2001 }))!.target.state, "slow");
  assert.equal(healthTarget(db, key)!.lastOkAt, stamp(4));
  assert.equal(storeHealthSample(db, key, sample({ at: stamp(5), ok: false, status: null, notHttp: true }))!.target.state, "not-http");
  assert.equal(healthTarget(db, key)!.failures, 0);
  assert.equal(storeHealthSample(db, key, sample({ at: stamp(6), latencyMs: 2000 }))!.target.state, "up");
  assert.deepEqual(healthState(sample({ ok: false }), 2), { state: "down", failures: 3 });
});

test("retention removes samples older than seven days and caps each target at 2016", (t) => {
  const db = seed(t);
  const put = db.prepare("INSERT INTO health_samples (target_key, kind, at, ok, status, latency_ms) VALUES (?, 'listener', ?, 1, 200, 1)");
  db.exec("BEGIN");
  for (let i = 0; i < 2020; i++) put.run("listener:hub:8080", stamp(-i));
  put.run("listener:hub:9000", stamp(-7 * DAY));
  put.run("listener:hub:9000", stamp(-7 * DAY - 1));
  db.exec("COMMIT");
  retainHealthSamples(db, AT);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples WHERE target_key = 'listener:hub:8080'").get()!.n, 2016);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples WHERE target_key = 'listener:hub:9000'").get()!.n, 1);
});

test("the health response has exact fields, full counts, filters and the newest 60 samples oldest first", (t) => {
  const db = seed(t);
  for (let i = 0; i < 61; i++) storeHealthSample(db, "listener:hub:8080", sample({ at: stamp(i), latencyMs: i }));
  const probe = { running: false, lastRunAt: AT, nextRunAt: stamp(300_000), intervalSeconds: 300 };
  const response = healthResponse(db, new URLSearchParams("kind=listener&state=up"), AT, probe);
  assert.deepEqual(Object.keys(response), ["targets", "counts", "probe", "generatedAt"]);
  assert.deepEqual(response.counts, { up: 1, slow: 0, failing: 0, down: 0, "not-http": 0, unknown: 1 });
  assert.deepEqual(response.probe, probe);
  db.prepare("INSERT INTO meta (key, value) VALUES ('health_last_run', ?)").run(AT);
  assert.equal(healthResponse(db).probe.lastRunAt, AT);
  const target = response.targets[0]!;
  assert.deepEqual(Object.keys(target).sort(), ["key", "kind", "label", "machineId", "port", "url", "state", "status", "latencyMs", "lastOkAt", "lastProbeAt", "failures", "error", "tlsNotAfter", "tlsDaysLeft", "history"].sort());
  assert.equal(target.history.length, 60);
  assert.deepEqual(target.history[0], { at: stamp(1), ok: true, latencyMs: 1, status: 200 });
  assert.equal(target.history[59]!.at, stamp(60));
  assert.equal(healthResponse(db, new URLSearchParams(), AT).targets[0]!.state, "unknown");
  assert.throws(() => healthResponse(db, new URLSearchParams("state=nope")), /invalid state/);
  assert.throws(() => healthResponse(db, new URLSearchParams("kind=service")), /invalid kind/);
  recordServices(db, "hub", { origin: "services", status: "ok", facts: [service] }, AT);
  assert.deepEqual(listServices(db)[0]!.ports[0]!.health, healthRow(db, "listener:hub:8080"));
  assert.equal(listRoutes(db)[0]!.health!.key, "domain:scout.example.test");
});

test("health changes emit state and TLS changes and skip ordinary samples", (t) => {
  const db = seed(t);
  assert.equal(storeHealthSample(db, "domain:scout.example.test", sample())!.change, "state");
  assert.equal(storeHealthSample(db, "domain:scout.example.test", sample({ latencyMs: 100 })), null);
  assert.equal(storeHealthSample(db, "domain:scout.example.test", sample({ tlsNotAfter: stamp(9 * DAY) }))!.change, "tls");
  assert.deepEqual(healthSummary(db, AT), { down: 0, failing: 0, expiring: 1 });
});

test("unhealthy alerts use stable keys and domain and listener severity and resolve on recovery or disappearance", (t) => {
  const db = seed(t);
  storeHealthSample(db, "listener:hub:8080", sample());
  for (let i = 0; i < 3; i++) {
    for (const target of buildHealthTargets(db)) storeHealthSample(db, target.key, sample({ ok: false, status: null, error: "timeout" }));
    const changes = evaluateAlerts(db, AT).filter((change) => change.alert.kind === "unhealthy");
    assert.equal(changes.length, i === 2 ? 2 : 0);
  }
  const alerts = alertsResponse(db, new URLSearchParams("kind=unhealthy"), AT).alerts;
  assert.deepEqual(alerts.map((row) => [row.key, row.severity]).sort(), [["unhealthy:domain:scout.example.test", "high"], ["unhealthy:listener:hub:8080", "warn"]]);
  assert.equal(alerts.find((row) => row.severity === "high")!.detail, "scout.example.test has not answered for 3 checks (timeout)");
  assert.equal(alertsSummary(db).open, 2);
  assert.deepEqual(evaluateAlerts(db, AT), []);
  acknowledgeAlerts(db, { all: true, kind: "unhealthy" }, AT);
  storeHealthSample(db, "listener:hub:8080", sample());
  assert.equal(evaluateAlerts(db, AT).filter((change) => change.alert.kind === "unhealthy" && change.change === "resolved").length, 1);
  recordCloudflare(db, { dns: [] }, AT, null);
  assert.equal(evaluateAlerts(db, AT).filter((change) => change.alert.kind === "unhealthy" && change.change === "resolved").length, 1);
});

test("certificate expiry thresholds use elapsed days, escalate and resolve after renewal and respect mutes", (t) => {
  const db = seed(t);
  const key = "domain:scout.example.test";
  storeHealthSample(db, key, sample({ tlsNotAfter: stamp(14 * DAY + 1) }));
  assert.equal(evaluateAlerts(db, AT).length, 0);
  storeHealthSample(db, key, sample({ tlsNotAfter: stamp(9 * DAY) }));
  setAlertMute(db, { key: "cert-expiring:scout.example.test", reason: "fixture" }, AT);
  const warn = evaluateAlerts(db, AT).find((change) => change.alert.kind === "cert-expiring")!.alert;
  assert.equal(warn.severity, "warn");
  assert.equal(warn.detail, "The certificate for scout.example.test ends in 9 days");
  assert.equal(warn.muted, true);
  assert.equal(alertsSummary(db).open, 0);
  storeHealthSample(db, key, sample({ tlsNotAfter: stamp(3 * DAY) }));
  const high = evaluateAlerts(db, AT).find((change) => change.alert.kind === "cert-expiring")!.alert;
  assert.equal(high.id, warn.id);
  assert.equal(high.severity, "high");
  storeHealthSample(db, key, sample({ tlsNotAfter: stamp(40 * DAY) }));
  assert.equal(evaluateAlerts(db, AT).find((change) => change.alert.kind === "cert-expiring")!.change, "resolved");
  assert.equal(tlsDaysLeft(stamp(3 * DAY + 1), AT), 4);
});

test("non-HTTP listeners never alert and a process restart needs three new failures", (t) => {
  const db = seed(t);
  const key = "listener:hub:8080";
  for (let i = 0; i < 3; i++) storeHealthSample(db, key, sample({ ok: false, notHttp: true, status: null, error: "not HTTP" }));
  assert.equal(evaluateAlerts(db, AT).length, 0);
  for (let i = 0; i < 3; i++) storeHealthSample(db, key, sample({ ok: false }));
  assert.equal(healthTarget(db, key)!.state, "not-http");
  storeHealthSample(db, key, sample());
  for (let i = 0; i < 3; i++) storeHealthSample(db, key, sample({ ok: false }));
  assert.equal(healthTarget(db, key)!.state, "down");
  resetHealthFailures(db);
  storeHealthSample(db, key, sample({ ok: false }));
  assert.equal(healthTarget(db, key)!.state, "failing");
  assert.equal(evaluateAlerts(db, AT).length, 0);
});

test("crash loops count only running-to-stopped transitions in the last thirty minutes on any machine", (t) => {
  const db = seed(t);
  recordServices(db, "mini", { origin: "services", status: "ok", facts: [{ ...service, kind: "launchd", name: "ssh" }] }, AT);
  const put = db.prepare("INSERT INTO events (at, machine_id, kind, detail_json) VALUES (?, 'mini', 'service_changed', ?)");
  const flip = (at: string, oldState = "running", newState = "stopped", name = "ssh"): void => { put.run(at, JSON.stringify({ name, kind: "launchd", domain: "system", old: { state: oldState }, new: { state: newState } })); };
  flip(stamp(-30 * 60_000 - 1));
  flip(stamp(-25 * 60_000));
  flip(stamp(-20 * 60_000));
  flip(stamp(-10 * 60_000), "stopped", "running");
  flip(stamp(1));
  flip(stamp(-5 * 60_000), "running", "stopped", "other");
  put.run(AT, "{bad");
  assert.equal(evaluateAlerts(db, AT).filter((change) => change.alert.kind === "crash-loop").length, 0);
  flip(stamp(-5 * 60_000));
  const created = evaluateAlerts(db, AT).find((change) => change.alert.kind === "crash-loop")!.alert;
  assert.equal(created.key, "crash-loop:mini:ssh");
  assert.equal(created.severity, "warn");
  assert.equal(created.detail, "ssh restarted 3 times in 30 minutes");
  assert.equal(evaluateAlerts(db, stamp(11 * 60_000)).find((change) => change.alert.kind === "crash-loop")!.change, "resolved");
});

test("a DNS-only record that never answered stays quiet and one that answered is watched", (t) => {
  const db = seed(t);
  recordCloudflare(db, { zones: [{ id: "zone", name: "example.test" }], dns: [{ zone: "example.test", name: "scout.example.test", type: "A", content: "192.0.2.1", proxied: true }, { zone: "example.test", name: "mail.example.test", type: "CNAME", content: "mail.example.net", proxied: false }, { zone: "example.test", name: "site.example.test", type: "CNAME", content: "host.example.net", proxied: false }] }, AT, null);
  syncHealthTargets(db, AT);
  for (let i = 0; i < 4; i++) storeHealthSample(db, "domain:mail.example.test", sample({ ok: false, status: null, error: "certificate not trusted" }));
  assert.equal(healthTarget(db, "domain:mail.example.test")!.state, "not-http");
  storeHealthSample(db, "domain:site.example.test", sample());
  for (let i = 0; i < 3; i++) storeHealthSample(db, "domain:site.example.test", sample({ ok: false, status: null, error: "timeout" }));
  assert.equal(healthTarget(db, "domain:site.example.test")!.state, "down");
  for (let i = 0; i < 3; i++) storeHealthSample(db, "domain:scout.example.test", sample({ ok: false, status: null, error: "timeout" }));
  assert.equal(healthTarget(db, "domain:scout.example.test")!.state, "down");
});

test("an on-demand service that starts and stops by design never raises a crash loop", (t) => {
  const db = seed(t);
  recordServices(db, "hub", { origin: "services", status: "ok", facts: [{ ...service, name: "MedicSvc", startMode: "manual" }] }, AT);
  const put = db.prepare("INSERT INTO events (at, machine_id, kind, detail_json) VALUES (?, 'hub', 'service_changed', ?)");
  for (let i = 1; i <= 4; i++) put.run(stamp(-i * 60_000), JSON.stringify({ name: "MedicSvc", kind: "windows-service", domain: "system", old: { state: "running" }, new: { state: "stopped" } }));
  assert.equal(evaluateAlerts(db, AT).filter((change) => change.alert.kind === "crash-loop").length, 0);
});
