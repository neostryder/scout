import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { alertsResponse, healthTarget, openCatalog, recordCloudflare, recordListeners, storeHealthSample, syncHealthTargets, upsertMachine, type AlertChange, type Db, type HealthIdentity, type HealthNotice } from "@scout/core";
import { HEALTH_TIMEOUT_MS, probeHealth, readHealthTls, runHealthCycle, type HealthFetch, type HealthRequest, type HealthTlsSocket } from "../src/health.ts";

const AT = "2026-10-07T00:00:00.000Z";
const listener: HealthIdentity = { key: "listener:hub:8080", kind: "listener", label: "node:8080", machineId: "hub", port: 8080, url: "http://127.0.0.1:8080/" };
const domain: HealthIdentity = { key: "domain:scout.example.test", kind: "domain", label: "scout.example.test", machineId: null, port: null, url: "https://scout.example.test/" };
const now = (): number => Date.parse(AT);

function seed(t: TestContext, ports = [8080]): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: ports.map((port) => ({ port, protocol: "tcp", address: "0.0.0.0", bind: "all", pid: port, processName: "node", processPath: "C:/Tools/node.exe", container: null })) }, AT);
  return db;
}

for (const status of [405, 501]) {
  test(`the probe falls back from HEAD ${status} to GET and cancels both bodies`, async () => {
    const calls: HealthRequest[] = [];
    let cancelled = 0;
    let clock = now();
    const fetch: HealthFetch = async (url, options) => {
      assert.equal(url, listener.url);
      calls.push(options);
      clock += 12;
      return { status: calls.length === 1 ? status : 200, body: { cancel: async () => { cancelled++; } } };
    };
    const result = await probeHealth(listener, { fetch, now: () => clock });
    assert.deepEqual(calls.map((row) => row.method), ["HEAD", "GET"]);
    assert.equal(cancelled, 2);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.latencyMs, 24);
    for (const call of calls) {
      assert.equal(call.redirect, "manual");
      assert.equal(call.credentials, "omit");
      assert.deepEqual(call.headers, { "User-Agent": "scout-health/1" });
    }
  });
}

test("HTTP redirects and Access refusals count as answers and server errors fail", async () => {
  for (const status of [200, 302, 403, 500, 503]) {
    let calls = 0;
    const result = await probeHealth(listener, { now, fetch: async () => { calls++; return { status }; } });
    assert.equal(calls, 1);
    assert.equal(result.ok, status < 500);
    assert.equal(result.error, status < 500 ? null : `HTTP ${status}`);
  }
});

test("the five-second timeout aborts a fake transport and closes an unfinished TLS socket", async () => {
  assert.equal(HEALTH_TIMEOUT_MS, 5000);
  let signal: AbortSignal | undefined;
  const result = await probeHealth(listener, { now, timeoutMs: 5, fetch: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(signal!.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
  assert.equal(result.notHttp, false);
  let destroyed = 0;
  const socket = Object.assign(new EventEmitter(), { authorized: false, getPeerCertificate: () => ({ valid_to: "Jan 04 00:00:00 2027 GMT" }), destroy: () => { destroyed++; } });
  const controller = new AbortController();
  const pending = readHealthTls(domain.label, controller.signal, () => socket as unknown as HealthTlsSocket);
  controller.abort();
  assert.equal((await pending).error, "timeout");
  assert.equal(destroyed, 1);
});

test("closed or malformed HTTP sockets mark listeners as non-HTTP while refused connections remain failing", async () => {
  for (const code of ["HPE_INVALID_CONSTANT", "UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED"]) {
    const error = Object.assign(new Error("fixture"), { cause: { code } });
    const result = await probeHealth(listener, { now, fetch: async () => { throw error; } });
    assert.equal(result.notHttp, code !== "ECONNREFUSED");
    assert.equal(result.error, code === "ECONNREFUSED" ? "connection error" : "not HTTP");
  }
  const garbage = await probeHealth(listener, { now, fetch: async () => ({ status: 0 }) });
  assert.equal(garbage.notHttp, true);
});

test("TLS reads use SNI and port 443 and preserve the expiry of untrusted certificates", async () => {
  for (const trusted of [true, false]) {
    let destroyed = 0;
    const socket = Object.assign(new EventEmitter(), { authorized: trusted, getPeerCertificate: () => ({ valid_to: "Jan 04 00:00:00 2027 GMT" }), destroy: () => { destroyed++; } });
    const tls = readHealthTls(domain.label, new AbortController().signal, (options) => {
      assert.deepEqual(options, { host: domain.label, port: 443, servername: domain.label, rejectUnauthorized: false });
      return socket as unknown as HealthTlsSocket;
    });
    socket.emit("secureConnect");
    const result = await tls;
    assert.equal(result.notAfter, "2027-01-04T00:00:00.000Z");
    assert.equal(result.trusted, trusted);
    assert.equal(destroyed, 1);
    const sample = await probeHealth(domain, { now, fetch: async () => ({ status: 302 }), tls: async () => result });
    assert.equal(sample.tlsNotAfter, result.notAfter);
    assert.equal(sample.error, trusted ? null : "certificate not trusted");
  }
});

test("a failed HTTPS request still records an untrusted certificate end date", async () => {
  const sample = await probeHealth(domain, { now, fetch: async () => { throw new Error("fixture TLS refusal"); }, tls: async () => ({ trusted: false, notAfter: "2027-01-04T00:00:00.000Z" }) });
  assert.equal(sample.ok, false);
  assert.equal(sample.error, "certificate not trusted");
  assert.equal(sample.tlsNotAfter, "2027-01-04T00:00:00.000Z");
});

test("probe identity checks refuse URLs outside catalog target forms", async () => {
  let calls = 0;
  const fetch: HealthFetch = async () => { calls++; return { status: 200 }; };
  for (const target of [{ ...listener, url: "http://192.0.2.1:8080/" }, { ...domain, label: "example.test/path" }, { ...listener, machineId: "mini" }]) {
    assert.equal((await probeHealth(target, { now, fetch })).error, "invalid target");
  }
  assert.equal(calls, 0);
});

test("the native transport probes a loopback test server without following its redirect", async (t) => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    assert.equal(req.headers["user-agent"], "scout-health/1");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(req.method === "HEAD" ? 405 : 302, { location: "/should-not-be-read" });
    res.end("unused body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;
  const result = await probeHealth({ ...listener, key: `listener:hub:${port}`, port, url: `http://127.0.0.1:${port}/` });
  assert.equal(result.status, 302);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["HEAD /", "GET /"]);
});

test("a cycle caps concurrency at four and serializes all ports on the same host", async (t) => {
  const db = seed(t, [8080, 8081, 8082]);
  recordCloudflare(db, { zones: [{ id: "z", name: "example.test" }], dns: Array.from({ length: 6 }, (_, index) => ({ zone: "example.test", name: `host${index}.example.test`, type: "A", content: "192.0.2.1", proxied: true })) }, AT, null);
  let active = 0;
  let max = 0;
  const hosts = new Set<string>();
  const fetch: HealthFetch = async (url) => {
    const host = new URL(url).hostname;
    assert.equal(hosts.has(host), false);
    hosts.add(host);
    active++;
    max = Math.max(max, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    hosts.delete(host);
    return { status: 200 };
  };
  await runHealthCycle(db, { now, fetch, tls: async (hostname) => { assert.equal(hosts.has(hostname), false); return { notAfter: null, trusted: true }; } });
  assert.equal(max, 4);
  assert.equal(active, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples").get()!.n, 9);
});

test("cycles store samples, prune history, evaluate alerts and publish only changed targets plus progress", async (t) => {
  const db = seed(t);
  const notices: HealthNotice[] = [];
  const alerts: AlertChange[] = [];
  const options = { now, fetch: async () => ({ status: 503 }), publish: (notice: HealthNotice) => notices.push(notice), onAlerts: (changes: AlertChange[]) => alerts.push(...changes) };
  syncHealthTargets(db, AT);
  storeHealthSample(db, listener.key, { at: AT, ok: true, status: 200, latencyMs: 5, error: null, tlsNotAfter: null });
  await runHealthCycle(db, options);
  assert.equal(healthTarget(db, listener.key, AT)!.state, "failing");
  assert.deepEqual(notices.map((notice) => notice.kind), ["health-run", "health", "health-run", "health-run"]);
  assert.deepEqual(notices[0]!.data, { running: true, done: 0, total: 1 });
  assert.deepEqual(notices[3]!.data, { running: false, done: 1, total: 1 });
  notices.length = 0;
  await runHealthCycle(db, options);
  assert.equal(notices.filter((notice) => notice.kind === "health").length, 1, "the second failed check confirms the target as down");
  assert.equal(healthTarget(db, listener.key, AT)!.state, "down");
  await runHealthCycle(db, options);
  assert.equal(alerts.find((change) => change.alert.kind === "unhealthy")!.alert.key, "unhealthy:listener:hub:8080");
  assert.equal(alertsResponse(db, new URLSearchParams("kind=unhealthy"), AT).total, 1);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'health_last_run'").get()!.value, AT);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples").get()!.n, 4);
  const target = notices.find((notice) => notice.kind === "health")!.data;
  assert.equal("history" in (target as { target: object }).target, false);
});

test("an evaluator failure keeps samples and emits cycle completion", async (t) => {
  const db = seed(t);
  const notices: HealthNotice[] = [];
  const logs: string[] = [];
  await runHealthCycle(db, { now, fetch: async () => ({ status: 200 }), publish: (notice) => notices.push(notice), evaluate: () => { throw new Error("fixture evaluator"); }, log: (line) => logs.push(line) });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_samples").get()!.n, 1);
  assert.deepEqual(notices.at(-1)!.data, { running: false, done: 1, total: 1 });
  assert.deepEqual(logs, ["Alert evaluation failed; the next probe cycle will retry."]);
});
