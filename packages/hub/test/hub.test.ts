import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { linkIdentity, openCatalog, proposeMerges, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { filterFromQuery } from "../src/api.ts";
import { createHub, isLoopbackHost } from "../src/server.ts";

const T = "2026-09-29T12:00:00Z";
const db = openCatalog(":memory:");
upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
recordScan(db, "mini", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: [
  { ecosystem: "brew", key: "redis", name: "redis", kind: "package", version: "8", location: "/opt/homebrew/Cellar/redis/8", description: "Persistent key-value database", details: { onRequest: true } },
  { ecosystem: "brew", key: "openssl@3", name: "openssl@3", kind: "package", version: "3", location: "/opt/homebrew/Cellar/openssl@3/3", details: { onRequest: false } },
] }, T);
linkIdentity(db, T);

const dir = mkdtempSync(join(tmpdir(), "scout-web-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
writeFileSync(join(dir, "manifest.webmanifest"), "{}");
writeFileSync(join(dir, "icon-192.png"), "png");
writeFileSync(join(dir, "sw.js"), "//");
const server = createHub({ db, webRoot: dir });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function get(path: string, host = `127.0.0.1:${port}`, method = "GET", extra: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host, ...extra.headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(extra.body);
  });
}

test("the install manifest and the icon images are served with their own content types", async () => {
  const manifest = await get("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(String(manifest.headers["content-type"]), /^application\/manifest\+json/);
  const icon = await get("/icon-192.png");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/png");
});

test("the install assets may be cached for an hour and the pages and the worker never are", async () => {
  assert.equal((await get("/manifest.webmanifest")).headers["cache-control"], "private, max-age=3600");
  assert.equal((await get("/icon-192.png")).headers["cache-control"], "private, max-age=3600");
  assert.equal((await get("/")).headers["cache-control"], "no-store");
  assert.equal((await get("/sw.js")).headers["cache-control"], "no-store");
});

test("only loopback host names are accepted", () => {
  assert.ok(isLoopbackHost("localhost:4870"));
  assert.ok(isLoopbackHost("127.0.0.1"));
  assert.ok(isLoopbackHost("[::1]:4870"));
  assert.ok(!isLoopbackHost("evil.example:4870"));
  assert.ok(!isLoopbackHost("localhost.evil.example"));
  assert.ok(!isLoopbackHost(undefined));
});

test("query parameters become the shared filter, with libraries hidden by default", () => {
  const f = filterFromQuery(new URLSearchParams("machine=mini,hub&q=redis&usedWithinDays=30&running=1&limit=9999"));
  assert.deepEqual(f.machines, ["mini", "hub"]);
  assert.equal(f.text, "redis");
  assert.equal(f.usedWithinDays, 30);
  assert.equal(f.running, true);
  assert.equal(f.hideLibraries, true);
  assert.equal(f.limit, 500);
  assert.equal(filterFromQuery(new URLSearchParams("libs=1")).hideLibraries, undefined);
});

test("a request with a foreign Host header is refused", async () => {
  assert.equal((await get("/api/summary", "evil.example")).status, 421);
});

test("the API is read only", async () => {
  assert.equal((await get("/api/summary", undefined, "POST")).status, 405);
});

test("installs come back filtered with facets, and the security headers are set", async () => {
  const r = await get("/api/installs?q=key-value");
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body) as { total: number; rows: { name: string }[]; facets: Record<string, { value: string; count: number }[]> };
  assert.equal(body.total, 1);
  assert.equal(body.rows[0]?.name, "redis");
  assert.ok(body.facets["source"]?.some((f) => f.value === "brew"));
  assert.match(String(r.headers["content-security-policy"]), /default-src 'self'/);
  const hidden = JSON.parse((await get("/api/installs")).body) as { total: number };
  assert.equal(hidden.total, 1); // the unrequested dependency is hidden
  const shown = JSON.parse((await get("/api/installs?libs=1")).body) as { total: number };
  assert.equal(shown.total, 2);
});

test("an install's detail lists its usage, constraints and relations", async () => {
  const id = (JSON.parse((await get("/api/installs")).body) as { rows: { installId: number }[] }).rows[0]?.installId;
  const d = JSON.parse((await get(`/api/installs/${id}`)).body) as { name: string; details: { onRequest: boolean }; usage: unknown[]; constraints: unknown[] };
  assert.equal(d.name, "redis");
  assert.equal(d.details.onRequest, true);
  assert.deepEqual([d.usage, d.constraints], [[], []]);
  assert.equal((await get("/api/installs/99999")).status, 404);
});

test("static files are served and paths cannot leave the web root", async () => {
  assert.equal((await get("/")).status, 200);
  assert.notEqual((await get("/..%2f..%2fpackage.json")).status, 200);
  assert.equal((await get("/missing.js")).status, 404);
});

test("a merge proposal shows its evidence and is decided only by a JSON post from a loopback origin", async () => {
  const pdb = openCatalog(":memory:");
  upsertMachine(pdb, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const r = (ecosystem: string, key: string, name: string) => ({ ecosystem, key, name, kind: "package" as const, version: "26.01", location: "C:/7z" });
  recordScan(pdb, "hub", { sourceKind: "arp", location: "HKLM", status: "ok", installs: [r("arp", "HKLM/7-Zip", "7-Zip 26.01 (x64)")] }, T);
  recordScan(pdb, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [r("winget", "7zip.7zip", "7-Zip")] }, T);
  linkIdentity(pdb, T);
  proposeMerges(pdb, T);
  const dir2 = mkdtempSync(join(tmpdir(), "scout-web-"));
  const s2 = createHub({ db: pdb, webRoot: dir2 });
  await new Promise<void>((res) => s2.listen(0, "127.0.0.1", res));
  const p2 = (s2.address() as AddressInfo).port;
  const call = (method: string, path: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const q = request({ host: "127.0.0.1", port: p2, path, method, headers: { host: `127.0.0.1:${p2}`, ...headers } }, (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      });
      q.on("error", reject);
      q.end(body);
    });
  try {
    const list = JSON.parse((await call("GET", "/api/proposals", {})).body) as { id: number; rule: string; packages: { name: string; installs: { machineId: string }[] }[] }[];
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]?.packages.map((p) => p.name).sort(), ["7-Zip", "7-Zip 26.01 (x64)"]);
    assert.equal(list[0]?.packages[0]?.installs[0]?.machineId, "hub");
    const path = `/api/proposals/${list[0]?.id}`;
    const json = { "content-type": "application/json" };
    assert.equal((await call("POST", path, { "content-type": "text/plain" }, "{\"accept\":true}")).status, 415);
    assert.equal((await call("POST", path, { ...json, origin: "https://evil.example" }, "{\"accept\":true}")).status, 403);
    assert.equal((await call("POST", path, json, "{\"accept\":\"yes\"}")).status, 400);
    assert.equal(JSON.parse((await call("GET", "/api/proposals", {})).body).length, 1); // nothing was decided yet
    assert.equal((await call("POST", path, { ...json, origin: `http://127.0.0.1:${p2}` }, "{\"accept\":true}")).status, 200);
    assert.equal(JSON.parse((await call("GET", "/api/proposals", {})).body).length, 0);
    assert.equal((await call("POST", path, json, "{\"accept\":true}")).status, 400); // already decided
    assert.equal((await call("POST", "/api/installs", json, "{}")).status, 405);
  } finally {
    s2.close();
    pdb.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("the updates route lists installs behind the latest answer, with the update verdict", async () => {
  const pid = (db.prepare("SELECT id FROM packages WHERE key = 'redis'").get() as { id: number }).id;
  recordResearch(db, pid, "brew-api", "ok", [{ channel: "stable", version: "8.2", installable: true }], null, T);
  const body = JSON.parse((await get("/api/updates")).body) as { total: number; updatable: number; rows: { name: string; installed: string; available: string; updatable: boolean }[] };
  assert.deepEqual([body.total, body.updatable], [1, 1]);
  assert.deepEqual([body.rows[0]?.name, body.rows[0]?.installed, body.rows[0]?.available], ["redis", "8", "8.2"]);
  assert.equal(JSON.parse((await get("/api/updates?q=nothing")).body).total, 0);
  assert.equal(JSON.parse((await get("/api/updates?machine=hub")).body).total, 0);
});

test("an API read carries an ETag and a poll that already holds the answer gets a 304 without a body", async () => {
  const first = await get("/api/summary");
  assert.equal(first.status, 200);
  const etag = String(first.headers["etag"]);
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.equal(first.headers["cache-control"], "private, no-cache");
  const again = await get("/api/summary", undefined, "GET", { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body, "");
  assert.equal(again.headers["etag"], etag);
  assert.equal(again.headers["x-content-type-options"], "nosniff");
  const weak = await get("/api/summary", undefined, "GET", { headers: { "if-none-match": `"other", W/${etag}` } });
  assert.equal(weak.status, 304);
  const stale = await get("/api/summary", undefined, "GET", { headers: { "if-none-match": '"0000"' } });
  assert.equal(stale.status, 200);
  assert.equal(stale.body, first.body);
});

test("only the polled reads are validated, and everything else stays no-store", async () => {
  const page = await get("/");
  assert.equal(page.headers["etag"], undefined);
  const research = await get("/api/research/status");
  assert.equal(research.headers["etag"], undefined);
  assert.equal(research.headers["cache-control"], "no-store");
  const refused = await get("/api/does-not-exist");
  assert.equal(refused.status, 404);
  assert.equal(refused.headers["etag"], undefined);
});
