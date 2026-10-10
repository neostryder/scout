import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listServices, openCatalog, recordListeners, recordServices, upsertMachine, type ListenerFact, type ServiceFact } from "@scout/core";
import { createHub } from "../src/server.ts";
import { LiveSchedule, type LiveClock, type LiveReader } from "../src/live.ts";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:01:00.000Z";
const T2 = "2026-10-01T00:02:00.000Z";
const START = Date.parse("2026-10-06T00:00:00.000Z");
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function service(fact: Pick<ServiceFact, "kind" | "name" | "state"> & Partial<ServiceFact>): ServiceFact {
  return {
    displayName: null, domain: "system", program: null, startMode: null, enabled: true, pid: null, runAs: null,
    triggers: null, lastRun: null, lastResult: null, ...fact,
  };
}

function listener(fact: Pick<ListenerFact, "port" | "address" | "bind"> & Partial<ListenerFact>): ListenerFact {
  return { protocol: "tcp", pid: null, processName: null, processPath: null, container: null, ...fact };
}

const appinfo = service({
  kind: "windows-service", name: "Appinfo", displayName: "Application Information", program: "C:/Windows/System32/svchost.exe",
  state: "running", startMode: "auto", pid: 4, runAs: "LocalSystem",
});
const fax = service({
  kind: "windows-service", name: "Fax", displayName: "Fax", program: "C:/Windows/System32/fxssvc.exe",
  state: "stopped", startMode: "manual", pid: null, runAs: "LocalSystem",
});
function cloudflared(state: "running" | "stopped"): ServiceFact {
  return service({
    kind: "windows-service", name: "Cloudflared", displayName: "Cloudflared", program: "C:/Tools/cloudflared.exe",
    state, startMode: "auto", pid: 100, runAs: "LocalSystem",
  });
}
const helper = service({ kind: "launchd", name: "com.example.helper", program: "/opt/helper", state: "running", pid: 50 });
const task = service({ kind: "scheduled-task", name: "ScoutSample", displayName: "ScoutSample", state: "stopped", enabled: true });
const windowsServices = (state: "running" | "stopped"): ServiceFact[] => [appinfo, fax, cloudflared(state)];

const svchost = listener({ port: 135, address: "127.0.0.1", bind: "loopback", pid: 4, processName: "svchost", processPath: "C:/Windows/System32/svchost.exe" });
const tunnel = listener({ port: 20241, address: "0.0.0.0", bind: "all", pid: 100, processName: "cloudflared", processPath: "C:/Tools/cloudflared.exe" });
const discard = listener({ port: 9, address: "127.0.0.1", bind: "loopback", pid: 9, processName: "discard", processPath: "/usr/local/bin/discard" });
const goneproc = listener({ port: 7, address: "127.0.0.1", bind: "loopback", pid: 7, processName: "goneproc", processPath: "/usr/local/bin/goneproc" });
const python = listener({ port: 8010, address: "*", bind: "all", pid: 123, processName: "python", processPath: "/usr/local/bin/python" });

const db = openCatalog(":memory:");
upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
upsertMachine(db, { id: "laptop", name: "Laptop", os: "macos", kind: "host" });
upsertMachine(db, { id: "guest", name: "Guest", os: "linux", kind: "guest", parentId: "hub" });
recordServices(db, "hub", { origin: "win-services", status: "ok", facts: windowsServices("running") }, T0);
recordServices(db, "laptop", { origin: "launchd-state", status: "ok", facts: [helper] }, T0);
recordListeners(db, "hub", { origin: "netconn", status: "ok", facts: [svchost, tunnel] }, T0);
recordListeners(db, "laptop", { origin: "lsof", status: "ok", facts: [discard, goneproc] }, T0);
recordServices(db, "hub", { origin: "win-services", status: "ok", facts: windowsServices("stopped") }, T1);
recordServices(db, "hub", { origin: "win-tasks", status: "ok", facts: [task] }, T1);
recordListeners(db, "laptop", { origin: "lsof", status: "ok", facts: [discard, goneproc, python] }, T1);
recordServices(db, "hub", { origin: "win-services", status: "ok", facts: windowsServices("running") }, T2);
recordServices(db, "hub", { origin: "win-tasks", status: "ok", facts: [] }, T2);
recordListeners(db, "laptop", { origin: "lsof", status: "ok", facts: [discard, python] }, T2);

const root = mkdtempSync(join(tmpdir(), "scout-services-api-"));
const server = createHub({ db, webRoot: root, streamHeartbeatMs: 30 });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
after(() => { server.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

interface Listed {
  total: number;
  hiddenCount: number;
  rows: {
    name?: string;
    port?: number;
    exposure?: string;
    serviceName?: string | null;
    serviceKind?: string | null;
    processName?: string | null;
    machineId: string;
    state?: string;
    classification: { class: string; hidden: boolean; official: boolean };
  }[];
  facets: Record<string, { value: string; count: number; label?: string }[]>;
}

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, method, path,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (part: Buffer) => chunks.push(part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function listed(path: string): Promise<Listed> {
  const response = await call("GET", path);
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body) as Listed;
}

function counts(rows: { value: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.value, row.count]));
}

test("services hide essential rows, count them, and facet every dimension but their own", async () => {
  const body = await listed("/api/services");
  assert.equal(body.total, 3);
  assert.equal(body.hiddenCount, 1);
  assert.deepEqual(body.rows.map((row) => row.name), ["Fax", "Cloudflared", "com.example.helper"]);
  assert.deepEqual(body.rows.map((row) => row.exposure), ["none", "all", "none"]);
  assert.equal(body.rows[1]?.classification.class, "third-party");
  assert.equal(body.rows[1]?.classification.official, false);
  assert.equal(body.rows[0]?.classification.class, "optional");
  assert.equal(body.rows[0]?.classification.official, true);
  assert.deepEqual(counts(body.facets.kind ?? []), { "windows-service": 2, launchd: 1 });
  assert.deepEqual(counts(body.facets.exposure ?? []), { none: 2, all: 1 });
  assert.equal(body.facets.machine?.[0]?.label, "Hub");
  const byKind = await listed("/api/services?kind=windows-service");
  assert.equal(byKind.total, 2);
  assert.equal(byKind.hiddenCount, 1);
  assert.deepEqual(counts(byKind.facets.kind ?? []), { "windows-service": 2, launchd: 1 });
  const byMachine = await listed("/api/services?machine=hub");
  assert.deepEqual(counts(byMachine.facets.machine ?? []), { hub: 2, laptop: 1 });
  assert.equal(byMachine.facets.machine?.find((row) => row.value === "laptop")?.label, "Laptop");
  const all = await listed("/api/services?all=1&class=essential");
  assert.equal(all.total, 1);
  assert.equal(all.hiddenCount, 1);
  assert.equal(all.rows[0]?.name, "Appinfo");
  assert.equal(all.rows[0]?.classification.hidden, true);
  assert.equal(all.rows[0]?.exposure, "loopback");
  assert.deepEqual(counts(all.facets.class ?? []), { essential: 1, optional: 1, "third-party": 2 });
  assert.equal((await listed("/api/services?class=essential")).total, 0);
  assert.equal((await listed("/api/services?state=stopped")).rows[0]?.name, "Fax");
  assert.equal((await listed("/api/services?official=1")).rows[0]?.name, "Fax");
  assert.deepEqual((await listed("/api/services?official=0")).rows.map((row) => row.name), ["Cloudflared", "com.example.helper"]);
  assert.equal((await listed("/api/services?hasPort=1")).total, 1);
  assert.equal((await listed("/api/services?hasPort=1")).hiddenCount, 1);
  assert.deepEqual((await listed("/api/services?all=1&hasPort=1")).rows.map((row) => row.name), ["Appinfo", "Cloudflared"]);
  assert.equal((await listed("/api/services?q=fax")).rows[0]?.name, "Fax");
  assert.equal((await listed("/api/services?q=nope")).total, 0);
  assert.equal((await listed("/api/services?kind=nope")).total, 3);
  assert.equal((await listed("/api/services?gone=gone")).rows[0]?.name, "ScoutSample");
  assert.deepEqual((await listed("/api/services?sort=name")).rows.map((row) => row.name), ["Cloudflared", "com.example.helper", "Fax"]);
  assert.deepEqual((await listed("/api/services?sort=name&dir=desc")).rows.map((row) => row.name), ["Fax", "com.example.helper", "Cloudflared"]);
  assert.deepEqual((await listed("/api/services?sort=machine&dir=desc")).rows.map((row) => row.name), ["com.example.helper", "Fax", "Cloudflared"]);
  assert.deepEqual((await listed("/api/services?sort=ports")).rows.map((row) => row.name), ["Cloudflared", "Fax", "com.example.helper"]);
  assert.deepEqual((await listed("/api/services?sort=ports&dir=desc")).rows.map((row) => row.name), ["Cloudflared", "Fax", "com.example.helper"]);
  assert.deepEqual((await listed("/api/services?sort=lastSeen&dir=desc")).rows.map((row) => row.name), ["Fax", "Cloudflared", "com.example.helper"]);
  const page = await listed("/api/services?sort=name&limit=1&offset=1");
  assert.equal(page.total, 3);
  assert.deepEqual(page.rows.map((row) => row.name), ["com.example.helper"]);
  assert.equal((await listed("/api/services?limit=0")).rows.length, 3);
  assert.equal((await listed("/api/services?limit=9999")).rows.length, 3);
});

test("listeners join a service, hide the essential loopback row, and page in catalog order", async () => {
  const body = await listed("/api/listeners");
  assert.equal(body.total, 3);
  assert.equal(body.hiddenCount, 1);
  assert.deepEqual(body.rows.map((row) => row.processName), ["cloudflared", "discard", "python"]);
  assert.equal(body.rows[2]?.serviceName, null);
  assert.equal(body.rows[0]?.serviceName, "Cloudflared");
  assert.equal(body.rows[0]?.serviceKind, "windows-service");
  assert.equal(body.rows[2]?.port, 8010);
  const loopback = await listed("/api/listeners?bind=loopback");
  assert.equal(loopback.total, 1);
  assert.equal(loopback.hiddenCount, 1);
  assert.deepEqual(counts(loopback.facets.bind ?? []), { all: 2, loopback: 1 });
  const revealed = await listed("/api/listeners?all=1");
  assert.equal(revealed.rows.find((row) => row.port === 135)?.serviceName, "Appinfo");
  assert.deepEqual(counts(revealed.facets.class ?? []), { essential: 1, "third-party": 3 });
  assert.equal((await listed("/api/listeners?port=8010")).rows[0]?.processName, "python");
  assert.equal((await listed("/api/listeners?port=nope")).total, 3);
  assert.equal((await listed("/api/listeners?q=python")).total, 1);
  assert.equal((await listed("/api/listeners?q=Appinfo")).total, 0);
  assert.equal((await listed("/api/listeners?gone=gone")).rows[0]?.port, 7);
  assert.equal((await listed("/api/listeners?class=third-party&official=0")).total, 3);
  const page = await listed("/api/listeners?limit=1&offset=1");
  assert.equal(page.rows[0]?.processName, "discard");
});

test("event summaries are newest first and name the change", async () => {
  const response = await call("GET", "/api/services/events?limit=50");
  assert.equal(response.headers["cache-control"], "no-store");
  const body = JSON.parse(response.body) as { events: { id: number; at: string; machineId: string; kind: string; summary: string; detail: { port?: number; newBind?: string; name?: string; old?: { state?: string }; new?: { state?: string } } }[] };
  assert.ok(body.events.length >= 4);
  assert.ok(body.events.every((event, index) => index === 0 || event.id < (body.events[index - 1]?.id ?? 0)));
  assert.equal(body.events[0]?.summary, "Laptop: listener 7 goneproc gone (loopback)");
  const added = body.events.find((event) => event.summary === "Laptop: new listener 8010 python (all interfaces)");
  assert.ok(added);
  assert.equal(added?.detail.port, 8010);
  assert.equal(added?.detail.newBind, "all");
  assert.ok(body.events.some((event) => event.summary === "Hub: Cloudflared changed from stopped to running"));
  assert.ok(body.events.some((event) => event.summary === "Hub: Cloudflared changed from running to stopped"));
  assert.ok(body.events.some((event) => event.summary === "Hub: new scheduled task ScoutSample"));
  assert.ok(body.events.some((event) => event.summary === "Hub: scheduled task ScoutSample is gone"));
  const laptop = JSON.parse((await call("GET", "/api/services/events?machine=laptop")).body) as { events: { machineId: string }[] };
  assert.ok(laptop.events.every((event) => event.machineId === "laptop"));
  const one = JSON.parse((await call("GET", "/api/services/events?limit=1")).body) as { events: { summary: string }[] };
  assert.equal(one.events.length, 1);
  const capped = JSON.parse((await call("GET", "/api/services/events?limit=9999")).body) as { events: unknown[] };
  assert.equal(capped.events.length, body.events.length);
});

test("overview counts visible present rows and reports live as never when refresh is off", async () => {
  const response = await call("GET", "/api/services/overview");
  const body = JSON.parse(response.body) as { generatedAt: string; machines: { id: string; name: string; os: string; hub: boolean; services: { total: number; running: number; optionalRunning: number; thirdParty: number }; listeners: { total: number; loopback: number; lan: number; all: number }; live: { state: string; lastLiveAt: string | null; cadenceMs: number; error: string | null } }[] };
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.machines.map((machine) => machine.id), ["hub", "laptop"]); // a guest such as a Colima VM is not a machine of its own on the page
  const hub = body.machines[0];
  assert.equal(body.machines[0]?.hub, true);
  assert.equal(hub?.services.total, 2);
  assert.equal(hub?.services.running, 1);
  assert.equal(hub?.services.optionalRunning, 0);
  assert.equal(hub?.services.thirdParty, 1);
  assert.deepEqual(hub?.listeners, { total: 1, loopback: 0, lan: 0, all: 1 });
  assert.deepEqual(hub?.live, { state: "never", lastLiveAt: null, cadenceMs: 120_000, error: null });
  assert.equal(body.machines[1]?.listeners.loopback, 1);
  assert.equal(body.machines[1]?.listeners.all, 1);
});

test("refresh and the stream stay quiet when live is off", async () => {
  const refused = await call("POST", "/api/services/refresh", { "content-type": "application/json" }, "{}");
  assert.equal(refused.status, 404);
  assert.deepEqual(JSON.parse(refused.body), { error: "live refresh is off" });
  assert.equal((await call("POST", "/api/services/refresh", { "content-type": "text/plain" }, "{}")).status, 415);
  assert.equal((await call("POST", "/api/services/refresh", { "content-type": "application/json", origin: "http://evil.example" }, "{}")).status, 403);
  assert.equal((await call("POST", "/api/services/refresh", { "content-type": "application/json" }, "[]")).status, 400);
  assert.equal((await call("POST", "/api/services/refresh", { "content-type": "application/json" }, "x".repeat(4097))).status, 413);
  assert.equal((await call("POST", "/api/services", { "content-type": "application/json" }, "{}")).status, 405);
  assert.equal((await call("GET", "/api/services", { host: "evil.example" })).status, 421);
  assert.equal((await call("GET", "/api/services/missing")).status, 404);
  const req = request({ host: "127.0.0.1", port, path: "/api/services/live", headers: { host: `127.0.0.1:${port}` } }, (res) => {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-accel-buffering"], "no");
  });
  const text = await new Promise<string>((resolve, reject) => {
    req.on("response", (res) => {
      let data = "";
      const timer = setTimeout(() => { req.destroy(); resolve(data); }, 120);
      res.on("data", (part: Buffer) => {
        data += part.toString("utf8");
        if (data.includes(": heartbeat")) { clearTimeout(timer); req.destroy(); resolve(data); }
      });
      res.on("error", reject);
    });
    req.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "ECONNRESET") reject(err); });
    req.end();
  });
  assert.match(text, /event: hello\ndata: /);
  assert.match(text, /"state":"never"/);
  assert.match(text, /: heartbeat/);
});

class FakeClock implements LiveClock {
  time = START;
  timers = new Map<number, { at: number; callback: () => void }>();
  private serial = 0;
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
}

test("the live stream says hello, reports a real change, heartbeats, and drops the watcher", { timeout: 10_000 }, async () => {
  const liveDb = openCatalog(":memory:");
  const clock = new FakeClock();
  const seen = new Map<string, number>();
  const reader: LiveReader = async (machine) => {
    const count = (seen.get(machine.id) ?? 0) + 1;
    seen.set(machine.id, count);
    if (machine.id === "hub" && count > 1) {
      recordServices(liveDb, "hub", { origin: "win-services", status: "ok", facts: [cloudflared("running")] }, T2);
      return { changed: true, tables: ["services"], status: "ok", error: null };
    }
    return { changed: false, tables: [], status: "ok", error: null };
  };
  const live = new LiveSchedule(liveDb, {
    clock,
    reader,
    machines: [
      { id: "hub", name: "Hub", os: "windows", transport: { type: "local" } },
      { id: "laptop", name: "Laptop", os: "macos", transport: { type: "local" } },
    ],
  });
  const liveRoot = mkdtempSync(join(tmpdir(), "scout-services-live-"));
  const liveServer = createHub({ db: liveDb, webRoot: liveRoot, live, streamHeartbeatMs: 30 });
  await new Promise<void>((resolve) => liveServer.listen(0, "127.0.0.1", resolve));
  const livePort = (liveServer.address() as AddressInfo).port;
  try {
    live.start();
    for (let i = 0; i < 200 && !live.status().every((machine) => machine.state === "fresh"); i++) await settle();
    const pieces: { event: string; data: string }[] = [];
    let comments = 0;
    let notify = (): void => undefined;
    const stream = await new Promise<{ headers: IncomingHttpHeaders; stop: () => void }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: livePort, path: "/api/services/live", headers: { host: `127.0.0.1:${livePort}` } }, (res) => {
        let buf = "";
        res.on("data", (part: Buffer) => {
          buf += part.toString("utf8");
          let split = buf.indexOf("\n\n");
          while (split >= 0) {
            const block = buf.slice(0, split);
            buf = buf.slice(split + 2);
            if (block.startsWith(":")) comments += 1;
            else {
              const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
              const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
              pieces.push({ event, data });
            }
            notify();
            split = buf.indexOf("\n\n");
          }
        });
        resolve({ headers: res.headers, stop: () => req.destroy() });
      });
      req.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "ECONNRESET") reject(err); });
      req.end();
    });
    assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
    assert.equal(stream.headers["cache-control"], "no-store");
    const waitFor = async (ready: () => boolean): Promise<void> => {
      if (ready()) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stream timed out: ${JSON.stringify(pieces)} comments=${comments}`)), 2_000);
        notify = () => { if (!ready()) return; clearTimeout(timer); resolve(); };
      });
    };
    await waitFor(() => pieces.some((piece) => piece.event === "hello") && comments >= 1);
    assert.equal(live.watcherCount(), 1);
    const hello = JSON.parse(pieces.find((piece) => piece.event === "hello")?.data ?? "{}") as { machines: { id: string; state: string; cadenceMs: number }[] };
    assert.equal(hello.machines.find((machine) => machine.id === "hub")?.cadenceMs, 3_000);
    assert.equal(hello.machines.find((machine) => machine.id === "laptop")?.cadenceMs, 20_000);
    assert.equal(hello.machines.find((machine) => machine.id === "hub")?.state, "fresh");
    const running = await callOn(livePort, "POST", "/api/services/refresh", { "content-type": "application/json" }, "{\"machineId\":\"hub\",\"slow\":false}");
    assert.equal(running.status, 202);
    assert.deepEqual(JSON.parse(running.body), { started: true, machines: ["hub"] });
    await waitFor(() => pieces.some((piece) => piece.event === "changed"));
    const changed = JSON.parse(pieces.find((piece) => piece.event === "changed")?.data ?? "{}") as { machineId: string; tables: string[] };
    assert.equal(changed.machineId, "hub");
    assert.deepEqual(changed.tables, ["services"]);
    assert.equal(listServices(liveDb, { machine: "hub", q: "Cloudflared" })[0]?.name, "Cloudflared");
    const blocked = await callOn(livePort, "POST", "/api/services/refresh", { "content-type": "application/json" }, "{\"machineId\":1}");
    assert.equal(blocked.status, 400);
    assert.equal((await callOn(livePort, "POST", "/api/services/refresh", { "content-type": "application/json" }, "{\"slow\":\"yes\"}")).status, 400);
    assert.equal((await callOn(livePort, "POST", "/api/services/refresh", { "content-type": "application/json" }, "{\"machineId\":\"missing\"}")).status, 400);
    stream.stop();
    for (let i = 0; i < 300 && live.watcherCount() !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(live.watcherCount(), 0);
    assert.equal(live.status().find((machine) => machine.id === "hub")?.cadenceMs, 120_000);
  } finally {
    live.stop();
    liveServer.close();
    liveDb.close();
    rmSync(liveRoot, { recursive: true, force: true });
  }
});

function callOn(target: number, method: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: target, method, path, headers: { host: `127.0.0.1:${target}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (part: Buffer) => chunks.push(part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a refresh already running for that machine answers running", { timeout: 10_000 }, async () => {
  const liveDb = openCatalog(":memory:");
  let release: (() => void) | undefined;
  const live = new LiveSchedule(liveDb, {
    machines: [{ id: "hub", name: "Hub", os: "windows", transport: { type: "local" } }],
    reader: async (_machine, options) => {
      assert.equal(options.slow, true);
      await new Promise<void>((done) => { release = done; });
      return { changed: false, tables: [], status: "ok", error: null };
    },
  });
  const liveRoot = mkdtempSync(join(tmpdir(), "scout-services-refresh-"));
  const liveServer = createHub({ db: liveDb, webRoot: liveRoot, live });
  await new Promise<void>((resolve) => liveServer.listen(0, "127.0.0.1", resolve));
  const livePort = (liveServer.address() as AddressInfo).port;
  try {
    const started = await callOn(livePort, "POST", "/api/services/refresh", { "content-type": "application/json" }, "{\"slow\":true}");
    assert.equal(started.status, 202);
    assert.deepEqual(JSON.parse(started.body), { started: true, machines: ["hub"] });
    const again = await callOn(livePort, "POST", "/api/services/refresh", { "content-type": "application/json" }, "{}");
    assert.equal(again.status, 200);
    assert.deepEqual(JSON.parse(again.body), { started: false, reason: "running" });
  } finally {
    release?.();
    await settle();
    live.stop();
    liveServer.close();
    liveDb.close();
    rmSync(liveRoot, { recursive: true, force: true });
  }
});
