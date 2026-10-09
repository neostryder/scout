import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openCatalog,
  recordCloudflare,
  recordListeners,
  recordServices,
  upsertMachine,
  type CloudflareSnapshot,
  type Db,
} from "@scout/core";
import { readCloudflare } from "@scout/ops";
import { CloudflareSchedule, type EdgeEvent } from "../src/cloudflare.ts";
import { createHub } from "../src/server.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const TOKEN = "token-fake";
const ACCOUNT = "account-fake";
const SECRET = "tun-secret-value";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/cloudflare");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function seed(db: Db): void {
  upsertMachine(db, { id: "server", name: "Server", os: "macos", kind: "host" });
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const snapshot: CloudflareSnapshot = {
    zones: [{ id: "zone-example", name: "example.test" }],
    tunnels: [
      { id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true },
      { id: "tunnel-bbbb", name: "beta", status: "healthy", connections: 1, remoteManaged: true },
    ],
    dns: [
      { zone: "example.test", name: "app.example.test", type: "CNAME", content: "tunnel-aaaa.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "down.example.test", type: "CNAME", content: "tunnel-bbbb.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "gone.example.test", type: "CNAME", content: "tunnel-zzzz.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "mail.example.test", type: "A", content: "203.0.113.30", proxied: false },
    ],
    ingress: [
      { tunnelId: "tunnel-aaaa", position: 0, hostname: "app.example.test", path: null, service: "http://localhost:4870" },
      { tunnelId: "tunnel-bbbb", position: 0, hostname: "down.example.test", path: null, service: "http://127.0.0.1:3000" },
      { tunnelId: "tunnel-aaaa", position: 1, hostname: "hub.example.test", path: null, service: "http://localhost:5555" },
    ],
  };
  recordCloudflare(db, snapshot, NOW, null);
  recordListeners(db, "server", { origin: "listeners", status: "ok", facts: [{ port: 4870, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 50, processName: "node", processPath: "/usr/local/bin/node", container: null }] }, NOW);
  recordListeners(db, "hub", { origin: "listeners", status: "ok", facts: [{ port: 5555, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 70, processName: "node", processPath: "C:/Tools/node.exe", container: null }] }, NOW);
  recordServices(db, "server", {
    origin: "launchd-state",
    status: "ok",
    facts: [{
      kind: "launchd", name: "cloudflared", displayName: "cloudflared", domain: "system", program: "/usr/local/bin/cloudflared",
      state: "running", startMode: null, enabled: true, pid: 80, runAs: null, triggers: null, lastRun: null, lastResult: null,
    }],
  }, NOW);
}

async function serve(setup: (db: Db) => CloudflareSchedule | undefined, run: (port: number) => Promise<void>): Promise<void> {
  const db = openCatalog(":memory:");
  const root = mkdtempSync(join(tmpdir(), "scout-routes-"));
  const cloudflare = setup(db);
  const server = createHub({ db, webRoot: root, streamHeartbeatMs: 60_000, ...(cloudflare ? { cloudflare } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(port);
  } finally {
    cloudflare?.stop();
    server.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function call(port: number, method: string, path: string, headers: Record<string, string>, body = ""): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (part: Buffer) => chunks.push(part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

interface RoutesBody {
  reader: { state: string; lastReadAt: string | null; error: string | null; zones: number; tunnels: number };
  total: number;
  rows: { hostname: string; state: string; via: string; machineId: string | null }[];
  facets: { machine: { value: string; label?: string; count: number }[]; state: { value: string; count: number }[]; via: { value: string; count: number }[] };
  generatedAt: string;
}

test("filters, facets, paging and overview follow the route catalog", async () => {
  await serve((db) => {
    seed(db);
    return new CloudflareSchedule(db, { read: async () => ({ changed: false, state: "fresh", error: null, lastReadAt: NOW }) });
  }, async (port) => {
    const all = await call(port, "GET", "/api/services/routes", {});
    assert.equal(all.status, 200);
    const body = JSON.parse(all.body) as RoutesBody;
    assert.equal(body.reader.state, "fresh");
    assert.equal(body.reader.zones, 1);
    assert.equal(body.reader.tunnels, 2);
    assert.equal(body.total, 5);
    assert.deepEqual(body.rows.map((row) => row.hostname), ["app.example.test", "down.example.test", "gone.example.test", "hub.example.test", "mail.example.test"]);
    assert.deepEqual(body.facets.machine.map((item) => [item.value, item.label, item.count]), [["server", "Server", 2], ["hub", "Hub", 1]]);
    assert.deepEqual(body.facets.state.map((item) => [item.value, item.count]), [["ok", 3], ["dns-dangling", 1], ["origin-down", 1]]);
    assert.deepEqual(body.facets.via.map((item) => [item.value, item.count]), [["tunnel", 4], ["dns-only", 1]]);
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const ok = JSON.parse((await call(port, "GET", "/api/services/routes?state=ok", {})).body) as RoutesBody;
    assert.equal(ok.total, 3);
    assert.deepEqual(ok.facets.state.map((item) => [item.value, item.count]), [["ok", 3], ["dns-dangling", 1], ["origin-down", 1]]);
    assert.deepEqual(ok.facets.machine.map((item) => [item.value, item.count]), [["hub", 1], ["server", 1]]);
    assert.deepEqual(ok.facets.via.map((item) => [item.value, item.count]), [["tunnel", 2], ["dns-only", 1]]);

    const hub = JSON.parse((await call(port, "GET", "/api/services/routes?machine=hub", {})).body) as RoutesBody;
    assert.equal(hub.total, 1);
    assert.equal(hub.rows[0]?.hostname, "hub.example.test");
    assert.deepEqual(hub.facets.machine.map((item) => item.value), ["server", "hub"]);
    assert.deepEqual(hub.facets.state.map((item) => [item.value, item.count]), [["ok", 1]]);

    const found = JSON.parse((await call(port, "GET", "/api/services/routes?q=mail", {})).body) as RoutesBody;
    assert.deepEqual(found.rows.map((row) => row.hostname), ["mail.example.test"]);

    const page = JSON.parse((await call(port, "GET", "/api/services/routes?limit=1&offset=1", {})).body) as RoutesBody;
    assert.equal(page.total, 5);
    assert.deepEqual(page.rows.map((row) => row.hostname), ["down.example.test"]);

    const overview = JSON.parse((await call(port, "GET", "/api/services/routes/overview", {})).body) as { totals: Record<string, number>; reader: { state: string } };
    assert.equal(overview.reader.state, "fresh");
    assert.deepEqual(overview.totals, { domains: 5, ok: 3, originDown: 1, dnsDangling: 1, noOrigin: 0, unknown: 0 });
    assert.equal(all.body.includes(TOKEN), false);
    assert.equal(all.body.includes(ACCOUNT), false);
  });
});

test("a hub with no reader serves rows as off and refresh answers 404", async () => {
  await serve((db) => {
    seed(db);
    return undefined;
  }, async (port) => {
    const listed = JSON.parse((await call(port, "GET", "/api/services/routes", {})).body) as RoutesBody;
    assert.equal(listed.reader.state, "off");
    assert.equal(listed.reader.error, null);
    assert.equal(listed.total, 5);
    const refresh = await call(port, "POST", "/api/services/routes/refresh", { "content-type": "application/json" }, "{}");
    assert.equal(refresh.status, 404);
    assert.deepEqual(JSON.parse(refresh.body), { error: "cloudflare reader is off" });
    const kind = await call(port, "POST", "/api/services/routes/refresh", {}, "");
    assert.equal(kind.status, 415);
    const events = await hello(port);
    const edge = JSON.parse(events.find((piece) => piece.event === "hello")?.data ?? "{}") as { edge: { state: string } };
    assert.equal(edge.edge.state, "off");
  });
});

test("refresh answers 202, then running, and the stream reports the edge", async () => {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { entered = resolve; });
  await serve((db) => new CloudflareSchedule(db, {
    read: async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return { changed: true, state: "fresh", error: null, lastReadAt: NOW };
    },
  }), async (port) => {
    const stream = openStream(port);
    await stream.waitFor(() => stream.pieces.some((piece) => piece.event === "hello"));
    const helloEdge = JSON.parse(stream.pieces.find((piece) => piece.event === "hello")?.data ?? "{}") as { edge: { state: string; lastReadAt: string | null; error: string | null } };
    assert.deepEqual(helloEdge.edge, { state: "never", lastReadAt: null, error: null });
    const started = await call(port, "POST", "/api/services/routes/refresh", { "content-type": "application/json" }, "{}");
    assert.equal(started.status, 202);
    assert.deepEqual(JSON.parse(started.body), { started: true });
    await opened;
    const again = await call(port, "POST", "/api/services/routes/refresh", { "content-type": "application/json" }, "{}");
    assert.equal(again.status, 200);
    assert.deepEqual(JSON.parse(again.body), { started: false, reason: "running" });
    release();
    await stream.waitFor(() => stream.pieces.some((piece) => piece.event === "edge"));
    const edge = JSON.parse(stream.pieces.find((piece) => piece.event === "edge")?.data ?? "{}") as EdgeEvent;
    assert.deepEqual(edge, { state: "fresh", lastReadAt: NOW, error: null, changed: true });
    stream.stop();
  });
});

test("an edge event from the fake client reaches the loopback stream", async () => {
  await serve((db) => new CloudflareSchedule(db, {
    read: () => readCloudflare(db, { token: TOKEN, accountId: ACCOUNT, fetch: fakeClient(), now: () => NOW }),
  }), async (port) => {
    const stream = openStream(port);
    await stream.waitFor(() => stream.pieces.some((piece) => piece.event === "hello"));
    const started = await call(port, "POST", "/api/services/routes/refresh", { "content-type": "application/json" }, "{}");
    assert.equal(started.status, 202);
    await stream.waitFor(() => stream.pieces.some((piece) => piece.event === "edge"));
    const edge = JSON.parse(stream.pieces.find((piece) => piece.event === "edge")?.data ?? "{}") as EdgeEvent;
    assert.equal(edge.state, "fresh");
    assert.equal(edge.changed, true);
    assert.equal(edge.error, null);
    assert.equal(edge.lastReadAt, NOW);
    const listed = await call(port, "GET", "/api/services/routes", {});
    assert.equal(listed.status, 200);
    assert.match(listed.body, /app\.example\.test/);
    assert.equal(listed.body.includes(TOKEN), false);
    assert.equal(listed.body.includes(ACCOUNT), false);
    assert.equal(listed.body.includes(SECRET), false);
    assert.equal(JSON.stringify(stream.pieces).includes(TOKEN), false);
    assert.equal(JSON.stringify(stream.pieces).includes(SECRET), false);
    stream.stop();
  });
});

function fakeClient(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/client\/v4/, "");
    if (route === "/zones") return jsonResponse(load("zones.json"));
    if (route === "/zones/zone-example/dns_records") {
      const type = url.searchParams.get("type");
      if (type === "A") return jsonResponse(load("dns-a.json"));
      if (type === "AAAA") return jsonResponse(load("dns-aaaa.json"));
      if (type === "CNAME") return jsonResponse(load("dns-cname.json"));
    }
    if (route === "/zones/zone-example/workers/routes") return jsonResponse(load("workers.json"));
    if (route === `/accounts/${ACCOUNT}/cfd_tunnel`) return jsonResponse(load("tunnels.json"));
    if (route === `/accounts/${ACCOUNT}/cfd_tunnel/tunnel-aaaa/configurations`) return jsonResponse(load("config-healthy.json"));
    if (route === `/accounts/${ACCOUNT}/cfd_tunnel/tunnel-bbbb/configurations`) return jsonResponse(load("config-down.json"));
    if (route === `/accounts/${ACCOUNT}/access/apps`) return jsonResponse(load("access.json"));
    return jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } });
  };
}

function hello(port: number): Promise<{ event: string; data: string }[]> {
  const stream = openStream(port);
  return stream.waitFor(() => stream.pieces.some((piece) => piece.event === "hello")).then(() => {
    stream.stop();
    return stream.pieces;
  });
}

function openStream(port: number): { pieces: { event: string; data: string }[]; waitFor: (ready: () => boolean) => Promise<void>; stop: () => void } {
  const pieces: { event: string; data: string }[] = [];
  let notify = (): void => undefined;
  let stop = (): void => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/services/live", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = "";
      res.on("data", (part: Buffer) => {
        buf += part.toString("utf8");
        let split = buf.indexOf("\n\n");
        while (split >= 0) {
          const block = buf.slice(0, split);
          buf = buf.slice(split + 2);
          if (!block.startsWith(":")) {
            pieces.push({
              event: /^event: (.*)$/m.exec(block)?.[1] ?? "",
              data: /^data: (.*)$/m.exec(block)?.[1] ?? "",
            });
          }
          notify();
          split = buf.indexOf("\n\n");
        }
      });
      resolve();
    });
    stop = () => req.destroy();
    req.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "ECONNRESET") reject(err); });
    req.end();
  });
  return {
    pieces,
    stop: () => stop(),
    waitFor: async (readyCheck) => {
      await ready;
      if (readyCheck()) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stream timed out: ${JSON.stringify(pieces)}`)), 2_000);
        const finish = (): void => { if (!readyCheck()) return; clearTimeout(timer); resolve(); };
        notify = finish;
        finish();
      });
    },
  };
}
