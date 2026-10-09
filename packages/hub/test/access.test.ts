import { test, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { openCatalog } from "@scout/core";
import { certsKeySource, verifyAccessJwt, type AccessConfig, type Jwk, type KeySource } from "../src/access.ts";
import { createHub } from "../src/server.ts";

const config: AccessConfig = { host: "scout.example.test", teamDomain: "team.example.test", aud: "aud-tag-1", allowedEmails: ["user@example.test"] };
const NOW = 1_800_000_000;

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (kid: string, key = pair.publicKey): Jwk => ({ ...(key.export({ format: "jwk" }) as Jwk), kid, alg: "RS256", use: "sig" });
const keys = async (): Promise<Jwk[]> => [jwk("k1")];

const b64 = (v: unknown): string => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = pair.privateKey): string {
  const h = b64({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const p = b64({ iss: `https://${config.teamDomain}`, aud: [config.aud], email: "user@example.test", sub: "u1", exp: NOW + 3600, nbf: NOW - 10, ...claims });
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}
const check = (t: string | undefined, k: KeySource = keys) => verifyAccessJwt(t, config, k, NOW);

test("a correctly signed token for this application is accepted", async () => {
  const r = await check(token());
  assert.ok(r.ok);
  assert.equal(r.ok && r.claims.email, "user@example.test");
});

test("every way a token can be wrong is refused with a reason", async () => {
  const reason = async (t: string | undefined, k: KeySource = keys): Promise<string> => {
    const r = await check(t, k);
    return r.ok ? "accepted" : r.reason;
  };
  assert.equal(await reason(undefined), "no Access token");
  assert.equal(await reason("not.a.jwt.at.all"), "token is not a JWT");
  assert.equal(await reason(token({}, {}, other.privateKey)), "signature does not verify");
  assert.equal(await reason(token({ aud: ["someone-else"] })), "wrong audience");
  assert.equal(await reason(token({ aud: "aud-tag-1" })), "accepted"); // a string audience is fine too
  assert.equal(await reason(token({ iss: "https://evil.example.test" })), "wrong issuer");
  assert.equal(await reason(token({ exp: NOW - 120 })), "token expired");
  assert.equal(await reason(token({ nbf: NOW + 600 })), "token not yet valid");
  assert.equal(await reason(token({ email: "someone@example.test" })), "email is not allowed");
  assert.equal(await reason(token({ email: undefined })), "token has no email");
  assert.equal(await reason(token({}, { kid: "unknown" })), "unknown key id");
  assert.match(await reason(token({}, { alg: "none" })), /algorithm none is not accepted/);
  assert.match(await reason(token({}, { alg: "HS256" })), /algorithm HS256 is not accepted/);
  assert.match(await reason(token(), async () => { throw new Error("offline"); }), /keys unavailable: offline/);
});

test("an unknown key id forces one key refresh, and a rotated key is then found", async () => {
  let calls = 0;
  const rotating = async (force: boolean): Promise<Jwk[]> => {
    calls++;
    return force ? [jwk("k2")] : [jwk("k1", other.publicKey)];
  };
  const r = await check(token({}, { kid: "k2" }), rotating);
  assert.ok(r.ok);
  assert.equal(calls, 2);
});

test("the certs key source caches and refuses a bad response", async () => {
  let n = 0;
  const source = certsKeySource("team.example.test", async (url) => {
    n++;
    assert.equal(url, "https://team.example.test/cdn-cgi/access/certs");
    return { status: 200, json: async () => ({ keys: [jwk("k1")] }) };
  });
  assert.equal((await source(false)).length, 1);
  await source(false);
  await source(true); // a forced refresh inside a minute is ignored
  assert.equal(n, 1);
  const broken = certsKeySource("team.example.test", async () => ({ status: 503, json: async () => ({}) }));
  await assert.rejects(() => broken(false), /HTTP 503/);
});

const dir = mkdtempSync(join(tmpdir(), "scout-access-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>scout</title>");
const db = openCatalog(":memory:");
const log: string[] = [];
const server = createHub({ db, webRoot: dir, access: { config, keys, log: (l) => log.push(l) } });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
after(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// The server checks the real clock, so these tokens carry real-time claims.
const real = Math.floor(Date.now() / 1000);
const live = (claims: Record<string, unknown> = {}): string => token({ exp: real + 3600, nbf: real - 10, ...claims });

test("in production mode the hub answers the public host only, and only with a valid Access token", async () => {
  const host = { host: config.host };
  assert.equal((await call("GET", "/api/summary", { host: "127.0.0.1" })).status, 421); // not the public host, even from loopback
  assert.equal((await call("GET", "/api/summary", host)).status, 403); // no token
  assert.equal((await call("GET", "/api/summary", { ...host, "cf-access-jwt-assertion": live({ aud: ["x"] }) })).status, 403);
  assert.equal((await call("GET", "/", { ...host, "cf-access-jwt-assertion": live() })).status, 200);
  const ok = await call("GET", "/api/summary", { ...host, "cf-access-jwt-assertion": live() });
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.body).installs === 0);
  assert.ok(log.some((l) => l.includes("no Access token")));
});

test("a decision post needs the token and an origin on the public host", async () => {
  const headers = { host: config.host, "content-type": "application/json", "cf-access-jwt-assertion": live() };
  assert.equal((await call("POST", "/api/proposals/1", { host: config.host, "content-type": "application/json" }, "{\"accept\":true}")).status, 403);
  assert.equal((await call("POST", "/api/proposals/1", { ...headers, origin: "https://evil.example.test" }, "{\"accept\":true}")).status, 403);
  assert.equal((await call("POST", "/api/proposals/1", { ...headers, origin: `https://${config.host}` }, "{\"accept\":true}")).status, 400); // passes the gates; no such proposal
});
