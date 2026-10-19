import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alertsSummary, evaluateAlerts, openCatalog, recordCloudflare, recordListeners, upsertMachine, type Db, type ListenerFact } from "@scout/core";
import { createHub, type HubOptions } from "../src/server.ts";
import { LiveSchedule } from "../src/live.ts";
import { CloudflareSchedule } from "../src/cloudflare.ts";
import { collectListeners, readLive, type ProbeRunner } from "@scout/ops";

const T = "2026-10-07T00:00:00.000Z";
const T2 = "2026-10-07T01:00:00.000Z";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const listener = (port: number): ListenerFact => ({ port, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: port, processName: "node", processPath: "C:/Tools/node.exe", container: null });
const listen = (db: Db, ports: number[]): void => { recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: ports.map(listener) }, T2); };
interface Reply { status: number; body: any }

async function app(t: TestContext, options: Partial<HubOptions> = {}) {
  const db = options.db ?? openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  if (!options.db) {
    listen(db, [8000]);
    evaluateAlerts(db, T);
    listen(db, [8000, 8080, 8090]);
    evaluateAlerts(db, T2);
  }
  const server = createHub({ db, webRoot: ".", control: false, streamHeartbeatMs: 20, alerts: { alertsPath: "fixtures/alerts/missing.json" }, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); db.close(); });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<Reply> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: `/api/services/alerts${path}`, method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { db, port, call };
}

async function stream(t: TestContext, port: number) {
  const events: { kind: string; data: any }[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/api/services/live" }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => {
        raw += part;
        let end: number;
        while ((end = raw.indexOf("\n\n")) >= 0) {
          const frame = raw.slice(0, end);
          raw = raw.slice(end + 2);
          const match = /^event: (.+)\ndata: (.+)$/.exec(frame);
          if (match) {
            events.push({ kind: match[1]!, data: JSON.parse(match[2]!) });
            if (match[1] === "hello") resolve();
          }
        }
      });
    });
    req.on("error", reject);
    t.after(() => req.destroy());
    req.end();
  });
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const end = Date.now() + 2000;
    while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), "The stream did not send the expected event.");
  };
  return { events, waitFor };
}

test("alert lists and summaries follow the contract with default state, filters and paging", async (t) => {
  const { call } = await app(t);
  const listed = await call("");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.alerts.length, 2);
  assert.equal(listed.body.total, 2);
  assert.deepEqual(listed.body.counts, { open: 2, acknowledged: 0, resolved: 0 });
  assert.deepEqual(listed.body.mutes, []);
  assert.equal(typeof listed.body.generatedAt, "string");
  assert.equal(listed.body.fileError, null);
  assert.deepEqual((await call("/summary")).body, { open: 2, high: 0, latestAt: T2 });
  assert.equal((await call("?limit=1&kind=new-listener&machine=hub&state=all")).body.alerts.length, 1);
  assert.equal((await call("?machine=mini")).body.total, 0);
});

test("acknowledgement routes return counts, preserve repeat acknowledgements and return 404 for missing ids", async (t) => {
  const { call } = await app(t);
  const id = (await call("")).body.alerts[0].id;
  assert.deepEqual((await call("/ack", { id })).body, { acknowledged: 1 });
  assert.deepEqual((await call("/ack", { id })).body, { acknowledged: 0 });
  assert.equal((await call("?state=acknowledged")).body.alerts[0].state, "acknowledged");
  assert.deepEqual(await call("/ack", { id: 999 }), { status: 404, body: { error: "not found" } });
  assert.deepEqual((await call("/ack", { all: true, kind: "new-listener" })).body, { acknowledged: 1 });
  assert.deepEqual((await call("/ack", { all: true })).body, { acknowledged: 0 });
  assert.equal((await call("/summary")).body.open, 0);
});

test("page mutes exclude alerts from counts and list them when include=muted", async (t) => {
  const { call } = await app(t);
  const key = (await call("")).body.alerts[0].key;
  const muted = await call("/mute", { key, reason: "development" });
  assert.equal(muted.status, 200);
  assert.equal(muted.body.mutes[0].key, key);
  assert.equal(muted.body.mutes[0].source, "page");
  assert.equal((await call("")).body.total, 1);
  assert.equal((await call("/summary")).body.open, 1);
  assert.equal((await call("?include=muted")).body.alerts.find((row: any) => row.key === key).muted, true);
  assert.deepEqual((await call("/mute", { key, remove: true })).body, { mutes: [] });
  assert.equal((await call("")).body.total, 2);
});

test("alert routes enforce methods, JSON, same-origin and body validation", async (t) => {
  const { call } = await app(t);
  assert.equal((await call("/ack")).status, 405);
  assert.equal((await call("", {}, {}, "POST")).status, 405);
  assert.equal((await call("/ack", {}, { origin: "https://elsewhere.test" })).status, 403);
  assert.equal((await call("/ack", {}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("/ack", " ".repeat(4097))).status, 413);
  for (const body of ["{", "[]", {}, { id: "1" }, { all: false }, { all: true, kind: "bad" }]) assert.equal((await call("/ack", body)).status, 400);
  for (const body of [{}, { key: "" }, { key: "x", reason: 3 }, { key: "x", remove: "true" }]) assert.equal((await call("/mute", body)).status, 400);
  for (const query of ["?state=bad", "?kind=bad", "?limit=0", "?include=bad"]) assert.equal((await call(query)).status, 400);
  assert.equal((await call("/unknown")).status, 404);
});

test("the list reports a malformed alerts file and refreshes file mutes at request time", async (t) => {
  const directory = mkdtempSync(join(process.cwd(), ".scout-alerts-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "alerts.json");
  writeFileSync(path, "{");
  const { call } = await app(t, { alerts: { alertsPath: path } });
  assert.ok((await call("")).body.fileError);
  writeFileSync(path, JSON.stringify({ mute: [{ match: "new-listener:hub:*", reason: "development" }] }));
  assert.equal((await call("/summary")).body.open, 0);
  assert.equal((await call("")).body.fileError, null);
  assert.equal((await call("?include=muted")).body.total, 2);
});

test("the services stream includes hello.alerts and publishes acknowledgements and mute changes", async (t) => {
  const { port, call } = await app(t);
  const { events, waitFor } = await stream(t, port);
  assert.deepEqual(events[0]!.data.alerts, { open: 2, high: 0 });
  const alert = (await call("")).body.alerts[0];
  await call("/ack", { id: alert.id });
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.change === "acknowledged"));
  await call("/mute", { key: alert.key });
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.change === "muted"));
  assert.equal(events.find((event) => event.kind === "alert" && event.data.change === "muted")!.data.alert.muted, true);
});

test("live reads publish created and resolved alerts and update the next hello", async (t) => {
  const db = openCatalog(":memory:");
  let ports = [8000];
  const live = new LiveSchedule(db, { machines: [{ id: "hub", name: "Hub", os: "windows", transport: { type: "local" } }], reader: async () => { listen(db, ports); return { changed: true, tables: ["listeners"], status: "ok", error: null }; } });
  t.after(() => live.stop());
  const { port } = await app(t, { db, live });
  const { events, waitFor } = await stream(t, port);
  live.refresh();
  await settle();
  assert.equal(alertsSummary(db).open, 0);
  ports = [8000, 8080];
  live.refresh();
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.change === "created"));
  assert.deepEqual((await stream(t, port)).events[0]!.data.alerts, { open: 1, high: 0 });
  ports = [8000];
  live.refresh();
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.change === "resolved"));
});

test("an evaluator error is logged and a completed live read stays fresh", async (t) => {
  const db = openCatalog(":memory:");
  const logs: string[] = [];
  let reads = 0;
  const live = new LiveSchedule(db, { machines: [{ id: "hub", name: "Hub", os: "windows", transport: { type: "local" } }], reader: async () => { reads++; listen(db, [8000]); return { changed: true, tables: ["listeners"], status: "ok", error: null }; } });
  t.after(() => live.stop());
  await app(t, { db, live, alerts: { evaluate: () => { throw new Error("injected evaluator failure"); }, log: (line) => logs.push(line), alertsPath: "fixtures/alerts/missing.json" } });
  live.refresh();
  await settle();
  assert.equal(live.status()[0]!.state, "fresh");
  assert.equal(logs.length, 1);
  live.refresh();
  await settle();
  assert.equal(reads, 2);
  assert.equal(logs.length, 2);
});

test("each Cloudflare read evaluates route changes and publishes the domain alert", async (t) => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  listen(db, [8000]);
  evaluateAlerts(db, T);
  const edge = new CloudflareSchedule(db, { read: async () => {
    recordCloudflare(db, { zones: [{ id: "zone", name: "example.test" }], dns: [{ zone: "zone", name: "dangling.example.test", type: "CNAME", content: "gone.cfargotunnel.com", proxied: true }] }, T2, null);
    return { changed: true, state: "fresh", error: null, lastReadAt: T2 };
  } });
  t.after(() => edge.stop());
  const { port } = await app(t, { db, cloudflare: edge });
  const { events, waitFor } = await stream(t, port);
  edge.refresh();
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.alert.kind === "domain-origin-down"));
  assert.equal(alertsSummary(db).high, 1);
  assert.ok(events.some((event) => event.kind === "edge"));
});

test("scans and live reads outside the cadence publish alerts through the hub", async (t) => {
  const db = openCatalog(":memory:");
  const { port } = await app(t, { db });
  const { events, waitFor } = await stream(t, port);
  const machine = { id: "hub", os: "windows" as const, transport: { type: "local" as const } };
  let ports = [8000];
  const run: ProbeRunner = async (_transport, probe) => ({ exitCode: 0, stdout: probe.id === "listeners" ? JSON.stringify(ports.map((port) => ({ port, pid: port, address: "127.0.0.1", name: "node", path: "C:/Tools/node.exe" }))) : "[]", stderr: "" });
  await collectListeners(db, machine, { run });
  assert.equal(alertsSummary(db).open, 0);
  ports = [8000, 8080];
  await collectListeners(db, machine, { run });
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.change === "created"));
  ports = [8000];
  const read = await readLive(db, machine, { run });
  assert.equal(read.status, "ok");
  await waitFor(() => events.some((event) => event.kind === "alert" && event.data.change === "resolved"));
});

test("evaluations requested together run once with every machine named", async () => {
  const { HubAlerts } = await import("../src/alerts.ts");
  const calls: { now: string; machineId?: string; machineIds?: string[] }[] = [];
  const alerts = new HubAlerts(openCatalog(":memory:"), { coalesceMs: 20, evaluate: (_db, now, options) => { calls.push({ now, ...(options?.machineId ? { machineId: options.machineId } : {}), ...(options?.machineIds ? { machineIds: options.machineIds } : {}) }); return []; }, alertsPath: "fixtures/alerts/missing.json" });
  alerts.evaluate(T, "eru");
  alerts.evaluate(T2, "bilbo");
  alerts.evaluate(T2);
  assert.equal(calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.now, T2);
  assert.deepEqual(calls[0]!.machineIds, ["eru", "bilbo"]);
  alerts.evaluate(T, "eru");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.machineId, "eru");
  alerts.evaluate(T);
  alerts.stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, 2);
});
