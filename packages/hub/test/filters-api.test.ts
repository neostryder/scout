import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { openCatalog, recordScan, upsertMachine, type Db } from "@scout/core";
import { createHub, type HubOptions } from "../src/server.ts";
import type { Jwk } from "../src/access.ts";

async function start(access?: HubOptions["access"]) {
  const db = openCatalog(":memory:");
  const server = createHub({ db, webRoot: fileURLToPath(new URL("../../web/public/", import.meta.url)), access });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "GET", body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let out = "";
      res.on("data", (part) => out += part);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, "POST", JSON.stringify(body), { "content-type": "application/json", ...headers });
  const close = async () => { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); db.close(); };
  return { db, call, post, close, port };
}

const counts = (db: Db) => ["coverage", "events", "jobs"].map((table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

test("filter routes save, list, replay, upsert, rename and delete by view without starting scans", async () => {
  const hub = await start();
  try {
    upsertMachine(hub.db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
    recordScan(hub.db, "hub", { sourceKind: "npm", location: "C:/Tools", status: "ok", installs: [
      { ecosystem: "npm", key: "alpha", name: "Alpha", kind: "package", version: "1", location: "C:/Tools/alpha" },
      { ecosystem: "npm", key: "beta", name: "Beta", kind: "package", version: "1", location: "C:/Tools/beta" },
    ] }, "2026-09-30T12:00:00Z");
    const before = counts(hub.db);
    assert.deepEqual(JSON.parse((await hub.call("/api/filters?view=catalog")).body), []);
    const saved = await hub.post("/api/filters", { name: " Work ", view: "catalog", params: { q: "Alpha", sort: "name", dir: "desc", limit: "1", offset: "9", unknown: "ignored" } });
    assert.equal(saved.status, 200);
    assert.match(String(saved.headers["content-security-policy"]), /default-src 'self'/);
    assert.equal(saved.headers["cache-control"], "no-store");
    const filter = JSON.parse(saved.body) as { name: string; view: string; spec: Record<string, string> };
    assert.deepEqual(filter, { name: "Work", view: "catalog", spec: { q: "Alpha", sort: "name", dir: "desc" } });
    const replay = await hub.call(`/api/installs?${new URLSearchParams(filter.spec)}`);
    assert.equal(replay.status, 200);
    assert.equal(JSON.parse(replay.body).total, 1);
    assert.equal(JSON.parse(replay.body).rows[0].name, "Alpha");
    assert.equal((await hub.post("/api/filters", { name: "Work", view: "updates", params: { status: "blocked" } })).status, 200);
    assert.equal((await hub.post("/api/filters", { name: "Work", view: "catalog", params: { q: "Beta" } })).status, 200);
    assert.deepEqual(JSON.parse((await hub.call("/api/filters?view=catalog")).body), [{ name: "Work", view: "catalog", spec: { q: "Beta" } }]);
    assert.equal((await hub.post("/api/filters/rename", { from: " Work ", to: " New ", view: "updates" })).status, 200);
    assert.deepEqual(JSON.parse((await hub.call("/api/filters?view=updates")).body), [{ name: "New", view: "updates", spec: { status: "blocked" } }]);
    assert.equal((await hub.post("/api/filters/delete", { name: "New", view: "updates" })).status, 200);
    assert.deepEqual(JSON.parse((await hub.call("/api/filters?view=updates")).body), []);
    assert.equal(JSON.parse((await hub.call("/api/filters?view=catalog")).body).length, 1);
    assert.deepEqual(counts(hub.db), before);
  } finally { await hub.close(); }
});

test("every filter POST follows the loopback Host, Origin and JSON rules", async () => {
  const hub = await start();
  try {
    const paths = ["/api/filters", "/api/filters/rename", "/api/filters/delete"];
    for (const path of paths) {
      assert.equal((await hub.post(path, {}, { host: "scout.example.test" })).status, 421);
      assert.equal((await hub.post(path, {}, { host: "localhost.evil.example" })).status, 421);
      assert.equal((await hub.post(path, {}, { origin: "https://evil.example" })).status, 403);
      assert.equal((await hub.post(path, {}, { origin: "null" })).status, 403);
      assert.equal((await hub.call(path, "POST", "{}", { "content-type": "text/plain" })).status, 415);
      assert.equal((await hub.call(path, "POST", "{}")).status, 415);
    }
    assert.deepEqual(JSON.parse((await hub.call("/api/filters?view=catalog")).body), []);
    const headers = { origin: `http://127.0.0.1:${hub.port}` };
    assert.equal((await hub.post(paths[0]!, { name: "Local", view: "catalog", params: {} }, headers)).status, 200);
    assert.equal((await hub.post(paths[1]!, { from: "Local", to: "Changed", view: "catalog" }, headers)).status, 200);
    assert.equal((await hub.post(paths[2]!, { name: "Changed", view: "catalog" }, headers)).status, 200);
    assert.equal((await hub.post(paths[0]!, { name: "No origin", view: "updates", params: {} })).status, 200);
  } finally { await hub.close(); }
});

test("filter routes refuse invalid input, collisions, oversized bodies and unsupported methods", async () => {
  const hub = await start();
  try {
    for (const path of ["/api/filters", "/api/filters?view=review"]) assert.equal((await hub.call(path)).status, 400);
    for (const body of [null, [], {}, { name: "", view: "catalog", params: {} }, { name: "Bad\n", view: "catalog", params: {} }, { name: "Bad", view: "catalog", params: [] }, { name: "Bad", view: "catalog", params: { q: 1 } }, { name: "Bad", view: "catalog", params: { q: "x".repeat(501) } }, { name: "Bad", view: "jobs", params: {} }]) {
      assert.equal((await hub.post("/api/filters", body)).status, 400);
    }
    assert.equal((await hub.call("/api/filters", "POST", "{", { "content-type": "application/json" })).status, 400);
    assert.equal((await hub.call("/api/filters", "POST", "x".repeat(32769), { "content-type": "application/json" })).status, 413);
    assert.equal((await hub.call("/api/filters?view=catalog", "PUT")).status, 405);
    assert.equal((await hub.call("/api/filters/delete?view=catalog")).status, 405);
    assert.equal((await hub.post("/api/filters/missing", {})).status, 404);
    assert.equal((await hub.post("/api/filters", { name: "One", view: "catalog", params: {} })).status, 200);
    assert.equal((await hub.post("/api/filters", { name: "Two", view: "catalog", params: {} })).status, 200);
    assert.equal((await hub.post("/api/filters/rename", { from: "One", to: "Two", view: "catalog" })).status, 400);
    assert.equal((await hub.post("/api/filters/rename", { from: "Missing", to: "New", view: "catalog" })).status, 400);
    assert.equal((await hub.post("/api/filters/delete", { name: "One", view: "updates" })).status, 400);
    assert.equal(JSON.parse((await hub.call("/api/filters?view=catalog")).body).length, 2);
  } finally { await hub.close(); }
});

test("production filter routes require Access and the configured host for POST origins", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { host: "scout.example.test", teamDomain: "team.example.test", aud: "filters-test", allowedEmails: ["reader@example.test"] };
  const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "filters", alg: "RS256", use: "sig" } as Jwk;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "filters" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: `https://${config.teamDomain}`, aud: config.aud, email: config.allowedEmails[0], exp: now + 3600, nbf: now - 10 })).toString("base64url");
  const token = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
  const hub = await start({ config, keys: async () => [jwk] });
  try {
    const host = { host: config.host };
    const auth = { ...host, "cf-access-jwt-assertion": token };
    assert.equal((await hub.call("/api/filters?view=catalog", "GET", undefined, host)).status, 403);
    assert.equal((await hub.call("/api/filters?view=catalog", "GET", undefined, auth)).status, 200);
    for (const path of ["/api/filters", "/api/filters/rename", "/api/filters/delete"]) {
      assert.equal((await hub.post(path, {}, host)).status, 403);
      assert.equal((await hub.post(path, {}, { ...auth, origin: "http://localhost" })).status, 403);
      assert.equal((await hub.post(path, {}, { ...auth, origin: "https://evil.example" })).status, 403);
    }
    const headers = { ...auth, origin: `https://${config.host}` };
    assert.equal((await hub.post("/api/filters", { name: "Public", view: "updates", params: {} }, headers)).status, 200);
    assert.equal((await hub.post("/api/filters/rename", { from: "Public", to: "Renamed", view: "updates" }, headers)).status, 200);
    assert.equal((await hub.post("/api/filters/delete", { name: "Renamed", view: "updates" }, headers)).status, 200);
  } finally { await hub.close(); }
});
