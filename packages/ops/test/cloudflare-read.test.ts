import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareCounts, cloudflareReader, listRoutes, openCatalog, type Db } from "@scout/core";
import { readCloudflare } from "../src/cloudflare.ts";

const TOKEN = "token-fake";
const SECRET = "tun-secret-value";
const ACCOUNT = "account-fake";
const MARKER = "body-marker-not-allowed";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/cloudflare");
const FIRST = "2026-01-01T00:00:00.000Z";
const SECOND = "2026-02-02T00:00:00.000Z";

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dump(db: Db): string {
  const tables = ["cf_zones", "cf_dns", "cf_tunnels", "cf_ingress", "cf_access_apps", "cf_worker_routes", "cf_reader"];
  return tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join("\n");
}

function healthyFetch(accessStatus = 200): typeof fetch & { paths: string[] } {
  const paths: string[] = [];
  const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/client\/v4/, "");
    paths.push(route);
    if (route === "/accounts") return jsonResponse(load("accounts.json"));
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
    if (route.endsWith("/tunnel-cccc/configurations")) return jsonResponse({ success: false }, 500);
    if (route === `/accounts/${ACCOUNT}/access/apps`) {
      if (accessStatus === 403) return jsonResponse(load("access-forbidden.json"), 403);
      return jsonResponse(load("access.json"));
    }
    return jsonResponse({ success: false, errors: [{ message: MARKER }] }, 404);
  };
  return Object.assign(impl, { paths });
}

test("a read records the catalog, hides secrets, and a repeat is unchanged", async () => {
  const db = openCatalog(":memory:");
  try {
    const fetchImpl = healthyFetch();
    const first = await readCloudflare(db, { token: TOKEN, fetch: fetchImpl, now: () => FIRST });
    assert.equal(first.state, "fresh");
    assert.equal(first.error, null);
    assert.equal(first.changed, true);
    assert.equal(first.lastReadAt, FIRST);
    assert.deepEqual(first.counts, { zones: 1, dns: 7, tunnels: 3, ingress: 6, access: 2, workers: 1 });
    const stored = dump(db);
    assert.equal(stored.includes(SECRET), false);
    assert.equal(stored.includes(TOKEN), false);
    assert.equal(stored.includes(ACCOUNT), false);
    assert.equal(stored.includes(MARKER), false);
    assert.equal(stored.includes("dropped-txt"), false);
    assert.equal(fetchImpl.paths.some((path) => path.endsWith("/tunnel-cccc/configurations")), false);
    const zone = db.prepare("SELECT name FROM cf_zones").get() as { name: string };
    assert.equal(zone.name, "example.test");
    const mail = db.prepare("SELECT name, proxied FROM cf_dns WHERE content = '203.0.113.30'").get() as { name: string; proxied: number };
    assert.equal(mail.name, "mail.example.test");
    assert.equal(mail.proxied, 0);
    const alpha = db.prepare("SELECT connections, remote_managed FROM cf_tunnels WHERE id = 'tunnel-aaaa'").get() as { connections: number; remote_managed: number };
    assert.equal(alpha.connections, 4);
    assert.equal(alpha.remote_managed, 1);
    const second = await readCloudflare(db, { token: TOKEN, fetch: healthyFetch(), now: () => SECOND });
    assert.equal(second.changed, false);
    assert.equal(second.lastReadAt, SECOND);
    assert.deepEqual(cloudflareCounts(db), first.counts);
  } finally {
    db.close();
  }
});

test("a 403 keeps that part, and the same denial on the next read is quiet", async () => {
  const db = openCatalog(":memory:");
  try {
    await readCloudflare(db, { token: TOKEN, fetch: healthyFetch(), now: () => FIRST });
    const denied = await readCloudflare(db, { token: TOKEN, fetch: healthyFetch(403), now: () => SECOND });
    assert.equal(denied.state, "fresh");
    assert.equal(denied.error, "Access apps: not permitted");
    assert.equal(denied.changed, true);
    assert.equal(denied.counts.access, 2);
    assert.equal(denied.error?.includes(MARKER), false);
    assert.equal(denied.error?.includes(TOKEN), false);
    const again = await readCloudflare(db, { token: TOKEN, fetch: healthyFetch(403), now: () => "2026-03-03T00:00:00.000Z" });
    assert.equal(again.changed, false);
    assert.equal(again.error, "Access apps: not permitted");
    assert.equal(cloudflareReader(db, true).state, "fresh");
  } finally {
    db.close();
  }
});

test("a failed read keeps previous rows and a first failure is failed", async () => {
  const empty = openCatalog(":memory:");
  const db = openCatalog(":memory:");
  try {
    const firstFail = await readCloudflare(empty, {
      token: TOKEN,
      accountId: ACCOUNT,
      fetch: async () => { throw new Error(`down ${TOKEN}`); },
    });
    assert.equal(firstFail.state, "failed");
    assert.equal(firstFail.changed, true);
    assert.equal(firstFail.error, "Cloudflare request failed");
    assert.equal(firstFail.counts.zones, 0);
    await readCloudflare(db, { token: TOKEN, fetch: healthyFetch(), now: () => FIRST });
    const failed = await readCloudflare(db, {
      token: TOKEN,
      fetch: async () => { throw new Error(`down ${TOKEN} ${SECRET}`); },
      now: () => SECOND,
    });
    assert.equal(failed.state, "stale");
    assert.equal(failed.changed, true);
    assert.equal(failed.error, "Cloudflare request failed");
    assert.equal(failed.lastReadAt, FIRST);
    assert.equal(failed.counts.dns, 7);
    assert.equal(dump(db).includes(TOKEN), false);
    assert.equal(dump(db).includes(SECRET), false);
    const repeat = await readCloudflare(db, {
      token: TOKEN,
      fetch: async () => { throw new Error("down"); },
    });
    assert.equal(repeat.changed, false);
    assert.equal(repeat.state, "stale");
  } finally {
    empty.close();
    db.close();
  }
});

test("a null remote config is locally managed and is fetched", async () => {
  const db = openCatalog(":memory:");
  const seen: string[] = [];
  try {
    const result = await readCloudflare(db, {
      token: TOKEN,
      accountId: ACCOUNT,
      now: () => FIRST,
      fetch: async (input) => {
        const url = new URL(String(input));
        const route = url.pathname.replace(/^\/client\/v4/, "");
        seen.push(route);
        if (route === "/zones") return jsonResponse({ success: true, result: [{ id: "zone-example", name: "example.test" }], result_info: { total_pages: 1 } });
        if (route.includes("/dns_records") || route.endsWith("/workers/routes") || route.endsWith("/access/apps")) {
          return jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } });
        }
        if (route.endsWith("/cfd_tunnel")) {
          return jsonResponse({ success: true, result: [{ id: "tunnel-cccc", name: "gamma", status: "inactive", connections: [] }], result_info: { total_pages: 1 } });
        }
        if (route.endsWith("/configurations")) return jsonResponse(load("config-local.json"));
        return jsonResponse({ success: false }, 404);
      },
    });
    assert.equal(result.state, "fresh");
    assert.equal(seen.some((path) => path.endsWith("/tunnel-cccc/configurations")), true);
    const row = db.prepare("SELECT remote_managed FROM cf_tunnels WHERE id = 'tunnel-cccc'").get() as { remote_managed: number };
    assert.equal(row.remote_managed, 0);
    assert.equal(result.counts.ingress, 0);
  } finally {
    db.close();
  }
});

test("stored rows join without a machine catalog", async () => {
  const db = openCatalog(":memory:");
  try {
    await readCloudflare(db, { token: TOKEN, fetch: healthyFetch(), now: () => FIRST });
    const rows = listRoutes(db);
    const by = (hostname: string) => rows.find((row) => row.hostname === hostname);
    assert.equal(by("status.example.test")?.state, "no-origin");
    assert.equal(by("sock.example.test")?.state, "no-origin");
    assert.equal(by("remote.example.test")?.state, "no-origin");
    assert.equal(by("gone.example.test")?.state, "dns-dangling");
    assert.equal(by("local.example.test")?.state, "unknown");
    assert.match(by("local.example.test")?.stateText ?? "", /locally managed/);
    assert.equal(by("work.example.test")?.state, "ok");
    assert.equal(by("work.example.test")?.via, "worker");
    assert.equal(by("direct.example.test")?.via, "proxied-origin");
    assert.equal(by("mail.example.test")?.via, "dns-only");
    assert.equal(by("app.example.test")?.state, "unknown");
    assert.equal(by("app.example.test")?.stateText, "No machine matches this tunnel");
    assert.equal(rows.some((row) => row.hostname === ""), false);
  } finally {
    db.close();
  }
});
