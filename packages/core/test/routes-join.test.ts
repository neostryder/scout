import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  listRoutes,
  openCatalog,
  recordCloudflare,
  recordListeners,
  recordServices,
  upsertMachine,
  type CloudflareSnapshot,
  type Db,
  type ListenerFact,
  type RouteRow,
  type ServiceFact,
} from "../src/index.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function useDb(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  return db;
}

function host(db: Db, id: string, name: string, os: "windows" | "macos" | "linux" = "linux"): void {
  upsertMachine(db, { id, name, os, kind: "host" });
}

function listen(db: Db, machineId: string, facts: (Partial<ListenerFact> & { port: number })[]): void {
  const rows: ListenerFact[] = facts.map((fact) => ({
    protocol: "tcp",
    address: "127.0.0.1",
    bind: "loopback",
    pid: null,
    processName: null,
    processPath: null,
    container: null,
    ...fact,
  }));
  recordListeners(db, machineId, { origin: "listeners", status: "ok", facts: rows }, NOW);
}

function launchd(name: string, state: "running" | "stopped", pid: number | null, program: string | null): ServiceFact {
  return {
    kind: "launchd", name, displayName: name, domain: "system", program, state,
    startMode: null, enabled: true, pid, runAs: null, triggers: null, lastRun: null, lastResult: null,
  };
}

function services(db: Db, machineId: string, facts: ServiceFact[]): void {
  recordServices(db, machineId, { origin: "launchd-state", status: "ok", facts }, NOW);
}

function one(rows: RouteRow[], hostname: string): RouteRow {
  const found = rows.find((row) => row.hostname === hostname);
  if (!found) throw new Error(`missing ${hostname}`);
  return found;
}

function catalog(t: TestContext): Db {
  const db = useDb(t);
  host(db, "server", "Server", "macos");
  host(db, "hub", "Hub", "windows");
  host(db, "laptop", "Laptop", "linux");
  upsertMachine(db, { id: "server/colima", name: "Colima", os: "linux", kind: "guest", parentId: "server", guestType: "colima" });
  const snapshot: CloudflareSnapshot = {
    zones: [{ id: "zone-example", name: "example.test" }, { id: "zone-other", name: "other.test" }],
    tunnels: [
      { id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 4, remoteManaged: true },
      { id: "tunnel-bbbb", name: "beta", status: "healthy", connections: 2, remoteManaged: true },
      { id: "tunnel-cccc", name: "gamma", status: "inactive", connections: 0, remoteManaged: false },
      { id: "tunnel-dddd", name: "delta", status: "down", connections: 0, remoteManaged: true },
      { id: "tunnel-eeee", name: "epsilon", status: "degraded", connections: 1, remoteManaged: true },
    ],
    dns: [
      { zone: "example.test", name: "app.example.test", type: "CNAME", content: "tunnel-aaaa.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "down.example.test", type: "CNAME", content: "tunnel-bbbb.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "gone.example.test", type: "CNAME", content: "tunnel-zzzz.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "local.example.test", type: "CNAME", content: "tunnel-cccc.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "noreule.example.test", type: "CNAME", content: "tunnel-aaaa.cfargotunnel.com", proxied: true },
      { zone: "example.test", name: "bare.example.test", type: "CNAME", content: "tunnel-aaaa.cfargotunnel.com", proxied: false },
      { zone: "example.test", name: "work.example.test", type: "A", content: "203.0.113.10", proxied: true },
      { zone: "example.test", name: "direct.example.test", type: "A", content: "203.0.113.20", proxied: true },
      { zone: "example.test", name: "mail.example.test", type: "A", content: "203.0.113.30", proxied: false },
      { zone: "example.test", name: "empty.example.test", type: "A", content: "", proxied: true },
      { zone: "other.test", name: "a.other.test", type: "A", content: "203.0.113.40", proxied: true },
    ],
    ingress: [
      { tunnelId: "tunnel-aaaa", position: 0, hostname: "app.example.test", path: null, service: "http://localhost:4870" },
      { tunnelId: "tunnel-aaaa", position: 1, hostname: "v6.example.test", path: null, service: "https://[::1]:8443" },
      { tunnelId: "tunnel-aaaa", position: 2, hostname: "colima.example.test", path: null, service: "http://localhost:9090" },
      { tunnelId: "tunnel-aaaa", position: 3, hostname: "plain.example.test", path: null, service: "http://localhost" },
      { tunnelId: "tunnel-aaaa", position: 4, hostname: null, path: null, service: "http_status:404" },
      { tunnelId: "tunnel-bbbb", position: 0, hostname: "down.example.test", path: "/health", service: "http://127.0.0.1:3000" },
      { tunnelId: "tunnel-bbbb", position: 1, hostname: "status.example.test", path: null, service: "http_status:404" },
      { tunnelId: "tunnel-bbbb", position: 2, hostname: "sock.example.test", path: null, service: "unix:/tmp/app.sock" },
      { tunnelId: "tunnel-bbbb", position: 3, hostname: "remote.example.test", path: null, service: "https://origin.example.test:8443" },
      { tunnelId: "tunnel-dddd", position: 0, hostname: "dead.example.test", path: null, service: "http://localhost:9" },
      { tunnelId: "tunnel-eeee", position: 0, hostname: "weak.example.test", path: null, service: "http://localhost:5555" },
    ],
    accessApps: [
      { id: "app-scout", name: "Scout", domain: "app.example.test", policies: 1 },
      { id: "app-wild", name: "Wild", domain: "*.example.test", policies: 2 },
    ],
    workerRoutes: [
      { zone: "example.test", pattern: "work.example.test/*", script: "worker-app" },
      { zone: "example.test", pattern: "idle.example.test/*", script: null },
      { zone: "other.test", pattern: "*.other.test/*", script: "wild-worker" },
    ],
  };
  recordCloudflare(db, snapshot, NOW, null);
  listen(db, "server", [
    { port: 4870, pid: 50, processName: "node", processPath: "/usr/local/bin/node" },
    { port: 8443, processName: "cloudflared", processPath: "/opt/cloudflared" },
  ]);
  listen(db, "server/colima", [{ port: 9090, address: "0.0.0.0", bind: "all" }]);
  listen(db, "hub", [{ port: 5555, pid: 70, processName: "node", processPath: "C:/Tools/node.exe" }]);
  services(db, "server", [
    launchd("cloudflared", "running", 80, "/usr/local/bin/cloudflared"),
    launchd("node-app", "running", 50, "/usr/local/bin/node"),
    launchd("com.example.cloudflared", "running", null, "/opt/cloudflared"),
  ]);
  return db;
}

test("every route state is named from the catalog and the live listeners", (t) => {
  const rows = listRoutes(catalog(t));
  const app = one(rows, "app.example.test");
  assert.equal(app.state, "ok");
  assert.equal(app.via, "tunnel");
  assert.equal(app.machineId, "server");
  assert.equal(app.machineConfidence, "listener");
  assert.equal(app.stateText, "Tunnel healthy and port 4870 is listening on Server");
  assert.deepEqual(app.origin, { service: "http://localhost:4870", scheme: "http", host: "localhost", port: 4870 });
  assert.equal(app.listener?.serviceName, "node-app");
  assert.equal(app.listener?.processName, "node");
  assert.equal(app.access?.appId, "app-scout");
  assert.equal(app.access?.policies, 1);
  assert.equal(app.worker, null);
  assert.deepEqual(app.dns, { type: "CNAME", content: "tunnel-aaaa.cfargotunnel.com", proxied: true });

  const weak = one(rows, "weak.example.test");
  assert.equal(weak.state, "ok");
  assert.equal(weak.machineId, "hub");
  assert.equal(weak.machineConfidence, "listener");
  assert.equal(weak.stateText, "Tunnel degraded and port 5555 is listening on Hub");

  const down = one(rows, "down.example.test");
  assert.equal(down.state, "origin-down");
  assert.equal(down.path, "/health");
  assert.equal(down.machineConfidence, "cloudflared");
  assert.equal(down.machineId, "server");
  assert.equal(down.listener, null);
  assert.equal(down.stateText, "Tunnel healthy and port 3000 is not listening on Server");
  assert.equal(down.access?.appId, "app-wild");
  assert.equal(down.access?.policies, 2);

  const plain = one(rows, "plain.example.test");
  assert.equal(plain.state, "origin-down");
  assert.equal(plain.origin?.port, 80);
  assert.equal(plain.stateText, "Tunnel healthy and port 80 is not listening on Server");

  const dead = one(rows, "dead.example.test");
  assert.equal(dead.state, "unknown");
  assert.equal(dead.stateText, "Tunnel down and port 9 is not listening on Server");

  assert.equal(one(rows, "gone.example.test").state, "dns-dangling");
  assert.equal(one(rows, "gone.example.test").stateText, "Proxied CNAME points at a tunnel that is gone");
  assert.equal(one(rows, "gone.example.test").tunnel, null);
  assert.equal(one(rows, "noreule.example.test").stateText, "Proxied CNAME has no ingress rule");
  assert.equal(one(rows, "noreule.example.test").tunnel?.id, "tunnel-aaaa");
  assert.equal(one(rows, "empty.example.test").stateText, "Record points at nothing Scout can resolve");
  assert.equal(one(rows, "empty.example.test").via, "proxied-origin");

  const local = one(rows, "local.example.test");
  assert.equal(local.state, "unknown");
  assert.equal(local.stateText, "Tunnel gamma is locally managed, so its origin is not in the catalog");

  assert.equal(one(rows, "status.example.test").state, "no-origin");
  assert.equal(one(rows, "status.example.test").stateText, "Ingress answers HTTP 404 and names no origin");
  assert.equal(one(rows, "sock.example.test").stateText, "Ingress targets a unix socket");
  assert.equal(one(rows, "remote.example.test").stateText, "Ingress targets a remote origin");
  assert.equal(one(rows, "remote.example.test").origin, null);

  const v6 = one(rows, "v6.example.test");
  assert.equal(v6.state, "ok");
  assert.deepEqual(v6.origin, { service: "https://[::1]:8443", scheme: "https", host: "::1", port: 8443 });
  assert.equal(v6.listener?.serviceName, "com.example.cloudflared");

  const colima = one(rows, "colima.example.test");
  assert.equal(colima.state, "ok");
  assert.equal(colima.machineId, "server");
  assert.equal(colima.machineConfidence, "listener");
  assert.equal(colima.listener?.bind, "all");

  const work = one(rows, "work.example.test");
  assert.equal(work.via, "worker");
  assert.equal(work.state, "ok");
  assert.equal(work.stateText, "Worker worker-app serves work.example.test");
  assert.deepEqual(work.worker, { pattern: "work.example.test/*", script: "worker-app" });
  assert.equal(work.dns?.type, "A");

  assert.equal(one(rows, "idle.example.test").state, "no-origin");
  assert.equal(one(rows, "idle.example.test").stateText, "Worker route has no script");
  assert.equal(one(rows, "direct.example.test").via, "proxied-origin");
  assert.equal(one(rows, "direct.example.test").stateText, "Proxied to 203.0.113.20");
  assert.equal(one(rows, "mail.example.test").via, "dns-only");
  assert.equal(one(rows, "mail.example.test").stateText, "DNS only, points at 203.0.113.30");

  const bare = one(rows, "bare.example.test");
  assert.equal(bare.via, "dns-only");
  assert.equal(bare.state, "ok");
  assert.equal(bare.tunnel, null);

  const wild = one(rows, "*.other.test");
  assert.equal(wild.via, "worker");
  assert.equal(wild.stateText, "Worker wild-worker serves *.other.test");
  const other = one(rows, "a.other.test");
  assert.equal(other.via, "proxied-origin");
  assert.equal(other.worker?.script, "wild-worker");
  assert.equal(rows.some((row) => row.hostname === ""), false);
});

test("text, machine and state filters apply to the joined rows", (t) => {
  const db = catalog(t);
  const alpha = listRoutes(db, { q: "alpha" }).map((row) => row.hostname);
  assert.ok(alpha.includes("app.example.test"));
  assert.equal(alpha.includes("mail.example.test"), false);
  assert.deepEqual(listRoutes(db, { q: "worker-app" }).map((row) => row.hostname), ["work.example.test"]);
  assert.ok(listRoutes(db, { q: "localhost:4870" }).some((row) => row.hostname === "app.example.test"));
  assert.ok(listRoutes(db, { machine: "hub" }).every((row) => row.machineId === "hub"));
  assert.ok(listRoutes(db, { state: "origin-down" }).every((row) => row.state === "origin-down"));
  assert.equal(listRoutes(db, { state: "origin-down" }).some((row) => row.hostname === "down.example.test"), true);
});

test("an exact worker pattern beats a wildcard on the same hostname", (t) => {
  const db = useDb(t);
  recordCloudflare(db, {
    zones: [{ id: "zone-example", name: "example.test" }],
    workerRoutes: [
      { zone: "example.test", pattern: "*.example.test/*", script: "wild-app" },
      { zone: "example.test", pattern: "work.example.test/*", script: "exact-app" },
    ],
  }, NOW, null);
  const work = one(listRoutes(db), "work.example.test");
  assert.equal(work.worker?.script, "exact-app");
  assert.equal(work.worker?.pattern, "work.example.test/*");
});

test("two listening machines and two cloudflared processes leave the machine empty", (t) => {
  const db = useDb(t);
  host(db, "hub", "Hub", "windows");
  host(db, "laptop", "Laptop", "linux");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "tie.example.test", path: null, service: "http://localhost:4870" }],
  }, NOW, null);
  listen(db, "hub", [{ port: 4870, pid: 1, processName: "node" }]);
  listen(db, "laptop", [{ port: 4870, pid: 2, processName: "node" }]);
  services(db, "hub", [launchd("cloudflared", "running", 3, null)]);
  services(db, "laptop", [launchd("cloudflared", "running", 4, null)]);
  const row = one(listRoutes(db), "tie.example.test");
  assert.equal(row.machineId, null);
  assert.equal(row.machineConfidence, null);
  assert.equal(row.state, "unknown");
  assert.equal(row.stateText, "Several machines qualify for port 4870, so Scout names none");
});

test("one running cloudflared breaks a listener tie", (t) => {
  const db = useDb(t);
  host(db, "hub", "Hub", "windows");
  host(db, "laptop", "Laptop", "linux");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "tie.example.test", path: null, service: "http://localhost:4870" }],
  }, NOW, null);
  listen(db, "hub", [{ port: 4870, pid: 1, processName: "node" }]);
  listen(db, "laptop", [{ port: 4870, pid: 2, processName: "node" }]);
  services(db, "hub", [launchd("cloudflared", "running", 3, null)]);
  const row = one(listRoutes(db), "tie.example.test");
  assert.equal(row.machineId, "hub");
  assert.equal(row.machineConfidence, "cloudflared");
  assert.equal(row.state, "ok");
  assert.equal(row.listener?.port, 4870);
});

test("a stopped cloudflared does not claim the route", (t) => {
  const db = useDb(t);
  host(db, "hub", "Hub", "windows");
  host(db, "laptop", "Laptop", "linux");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "tie.example.test", path: null, service: "http://localhost:2222" }],
  }, NOW, null);
  services(db, "hub", [launchd("cloudflared", "stopped", null, null)]);
  const row = one(listRoutes(db), "tie.example.test");
  assert.equal(row.machineId, null);
  assert.equal(row.stateText, "No machine matches this tunnel");
});

test("a launchd label containing cloudflared counts, including a hidden Apple label", (t) => {
  const db = useDb(t);
  host(db, "mini", "Mini", "macos");
  host(db, "hub", "Hub", "windows");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "edge.example.test", path: null, service: "http://localhost:2222" }],
  }, NOW, null);
  services(db, "mini", [launchd("com.apple.cloudflared", "running", null, "/usr/libexec/cloudflared")]);
  const row = one(listRoutes(db), "edge.example.test");
  assert.equal(row.machineId, "mini");
  assert.equal(row.machineConfidence, "cloudflared");
  assert.equal(row.state, "origin-down");
});

test("the only host is used when nothing else matches", (t) => {
  const db = useDb(t);
  host(db, "mini", "Mini", "macos");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "only.example.test", path: null, service: "http://localhost:2222" }],
  }, NOW, null);
  const row = one(listRoutes(db), "only.example.test");
  assert.equal(row.machineId, "mini");
  assert.equal(row.machineConfidence, "single-host");
  assert.equal(row.state, "origin-down");
  assert.equal(row.stateText, "Tunnel healthy and port 2222 is not listening on Mini");
});

test("two hosts and no connector leave the machine empty", (t) => {
  const db = useDb(t);
  host(db, "mini", "Mini", "macos");
  host(db, "hub", "Hub", "windows");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "none.example.test", path: null, service: "http://localhost:2222" }],
  }, NOW, null);
  const row = one(listRoutes(db), "none.example.test");
  assert.equal(row.machineId, null);
  assert.equal(row.state, "unknown");
  assert.equal(row.stateText, "No machine matches this tunnel");
});

test("a forwarded Colima listener counts as the host and a guest loopback does not", (t) => {
  const db = useDb(t);
  host(db, "server", "Server", "macos");
  upsertMachine(db, { id: "server/colima", name: "Colima", os: "linux", kind: "guest", parentId: "server", guestType: "colima" });
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [
      { tunnelId: "tunnel-aaaa", position: 0, hostname: "box.example.test", path: null, service: "http://localhost:9090" },
      { tunnelId: "tunnel-aaaa", position: 1, hostname: "loop.example.test", path: null, service: "http://localhost:4870" },
    ],
  }, NOW, null);
  listen(db, "server/colima", [
    { port: 9090, bind: "loopback", container: { name: "app", image: "app:1", containerPort: 9090 } },
    { port: 4870, bind: "loopback" },
  ]);
  const rows = listRoutes(db);
  const box = one(rows, "box.example.test");
  assert.equal(box.machineId, "server");
  assert.equal(box.machineConfidence, "listener");
  assert.equal(box.state, "ok");
  const loop = one(rows, "loop.example.test");
  assert.equal(loop.machineId, "server");
  assert.equal(loop.machineConfidence, "single-host");
  assert.equal(loop.state, "origin-down");
  assert.equal(loop.listener, null);
});

test("a hidden loopback listener still joins the route", (t) => {
  const db = useDb(t);
  host(db, "hub", "Hub", "windows");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "sys.example.test", path: null, service: "http://localhost:4870" }],
  }, NOW, null);
  listen(db, "hub", [{ port: 4870, processName: "svchost", processPath: null }]);
  const row = one(listRoutes(db), "sys.example.test");
  assert.equal(row.machineConfidence, "listener");
  assert.equal(row.state, "ok");
  assert.equal(row.listener?.processName, "svchost");
});

function twoConnectors(db: Db): void {
  host(db, "hub", "Hub", "windows");
  host(db, "server", "Server", "macos");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "server", status: "healthy", connections: 1, remoteManaged: true }, { id: "tunnel-bbbb", name: "other", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [
      { tunnelId: "tunnel-aaaa", position: 0, hostname: "named.example.test", path: null, service: "http://localhost:3310" },
      { tunnelId: "tunnel-bbbb", position: 0, hostname: "other.example.test", path: null, service: "http://localhost:3310" },
    ],
  }, NOW, null);
  listen(db, "hub", [{ port: 3310, pid: 1, processName: "node" }]);
  services(db, "hub", [launchd("cloudflared", "running", 3, null)]);
  services(db, "server", [launchd("cloudflared", "running", 4, null)]);
}

test("a tunnel named after a machine that runs cloudflared lives there, so an origin that listens elsewhere is down", (t) => {
  const db = useDb(t);
  twoConnectors(db);
  const row = one(listRoutes(db), "named.example.test");
  assert.equal(row.machineId, "server");
  assert.equal(row.machineConfidence, "cloudflared");
  assert.equal(row.state, "origin-down");
});

test("a configured tunnel host places a tunnel the join cannot place", (t) => {
  const db = useDb(t);
  twoConnectors(db);
  const row = one(listRoutes(db, { tunnelHosts: { OTHER: "hub" } }), "other.example.test");
  assert.equal(row.machineId, "hub");
  assert.equal(row.machineConfidence, "configured");
  assert.equal(row.state, "ok");
});

test("a listener only counts on a machine that runs cloudflared, and a cloudflared metrics listener shows the machine", (t) => {
  const db = useDb(t);
  host(db, "hub", "Hub", "windows");
  host(db, "server", "Server", "macos");
  host(db, "laptop", "Laptop", "macos");
  recordCloudflare(db, {
    tunnels: [{ id: "tunnel-aaaa", name: "alpha", status: "healthy", connections: 1, remoteManaged: true }],
    ingress: [{ tunnelId: "tunnel-aaaa", position: 0, hostname: "metrics.example.test", path: null, service: "http://localhost:4870" }],
  }, NOW, null);
  listen(db, "hub", [{ port: 4870, pid: 1, processName: "node" }]);
  listen(db, "laptop", [{ port: 4870, pid: 2, processName: "node" }]);
  listen(db, "server", [{ port: 20241, pid: 5, processName: "cloudflared", processPath: "/opt/homebrew/bin/cloudflared" }]);
  const row = one(listRoutes(db), "metrics.example.test");
  assert.equal(row.machineId, "server");
  assert.equal(row.machineConfidence, "cloudflared");
  assert.equal(row.state, "origin-down");
});
