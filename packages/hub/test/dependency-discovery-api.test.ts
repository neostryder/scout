import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { linkIdentity, openCatalog, proposeMerges, recordScan, upsertMachine, type Db } from "@scout/core";
import { createHub, type HubOptions } from "../src/server.ts";
import { decideProposalRequest, proposalsResponse } from "../src/api.ts";
import type { AccessConfig, Jwk } from "../src/access.ts";

const T = "2026-09-30T12:00:00Z";
const answer = JSON.stringify([{ from: "npm:language-server", to: "brew:node", kind: "runtime", constraint: ">=26", together: false, evidence: "The language server requires Node.", confidence: "medium" }]);

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "test-host", name: "Test host", kind: "host", os: "windows" });
  recordScan(db, "test-host", { sourceKind: "test", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "node", name: "Node", kind: "runtime", version: "26.1.0", location: "" },
    { ecosystem: "npm", key: "language-server", name: "Language server", kind: "package", version: "1.0.0", location: "" },
    { ecosystem: "winget", key: "editor", name: "Editor", kind: "app", version: "1.0.0", location: "" },
    { ecosystem: "cask", key: "editor", name: "Editor", kind: "app", version: "1.0.0", location: "" },
  ] }, T);
  linkIdentity(db, T);
  proposeMerges(db, T);
  return db;
}

async function hub(t: TestContext, db: Db, options: Partial<HubOptions> = {}) {
  const server = createHub({ db, webRoot: "packages/web/public", ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "POST", body = "{}", headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => { let parsed: unknown; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : body);
  });
  return { call, port };
}

test("the discover route uses one injected runner and lists dependency and merge proposals", async (t) => {
  const db = seed(t);
  let calls = 0;
  const { call, port } = await hub(t, db, { discoverModel: async (request) => { calls++; assert.equal(request.task, "dependency-discovery"); assert.equal(request.dataClass, "internal"); return answer; } });
  const result = await call("/api/dependencies/discover", "POST", "{}", { origin: `http://127.0.0.1:${port}` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "ok", proposed: 1, skipped: 0, omitted: 0 });
  assert.equal(calls, 1);
  const response = await call("/api/proposals", "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((p: any) => p.kind), ["merge_proposal", "dependency_proposal"]);
  const dependency = response.body[1];
  assert.deepEqual(dependency.packages.map((p: any) => p.name), ["Language server", "Node"]);
  assert.deepEqual(dependency.subject.machines, ["test-host"]);
  assert.equal(dependency.packages[0].installs[0].machineId, "test-host");
  assert.equal((await call(`/api/proposals/${dependency.id}`, "POST", '{"accept":"yes"}')).status, 400);
  assert.equal((await call(`/api/proposals/${dependency.id}`, "POST", '{"accept":true}', { origin: "https://foreign.test" })).status, 403);
  assert.equal(db.prepare("SELECT id FROM dependency_edges").all().length, 0);
  assert.equal((await call(`/api/proposals/${dependency.id}`, "POST", '{"accept":true}')).status, 200);
  assert.equal((await call(`/api/proposals/${dependency.id}`, "POST", '{"accept":true}')).status, 200);
  assert.equal(db.prepare("SELECT id FROM dependency_edges WHERE source = 'ai-reviewed'").all().length, 1);
  assert.equal((await call("/api/proposals", "GET")).body.length, 1);
  assert.equal((await call("/api/dependencies/discover")).body.proposed, 0);
});

test("the discover route refuses foreign hosts and origins and validates JSON before calling the runner", async (t) => {
  const db = seed(t);
  let calls = 0;
  const { call } = await hub(t, db, { discoverModel: async () => { calls++; return "[]"; } });
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { host: "foreign.test" })).status, 421);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { origin: "https://foreign.test" })).status, 403);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { origin: "invalid" })).status, 403);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("/api/dependencies/discover", "POST", "x".repeat(4097))).status, 413);
  for (const body of ["garbage", "null", "[]", "1", '{"extra":true}']) assert.equal((await call("/api/dependencies/discover", "POST", body)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await call("/api/dependencies/discover")).status, 200);
  assert.equal(calls, 1);
  assert.equal((await call("/api/dependencies/discover", "GET")).status, 404);
});

test("the discover route reports no configured runner and keeps findings intact", async (t) => {
  const db = seed(t);
  const original = db.prepare("SELECT * FROM findings").all();
  const { call } = await hub(t, db);
  assert.deepEqual(await call("/api/dependencies/discover"), { status: 200, body: { status: "no_model", proposed: 0 } });
  assert.deepEqual(db.prepare("SELECT * FROM findings").all(), original);
});

test("dependency rejection uses the existing decision route and suppresses another discovery", async (t) => {
  const db = seed(t);
  const { call } = await hub(t, db, { discoverModel: async () => answer });
  await call("/api/dependencies/discover");
  const dependency = (proposalsResponse(db) as any[]).find((p) => p.kind === "dependency_proposal");
  assert.deepEqual(decideProposalRequest(db, dependency.id, { accept: false }), { ok: true });
  assert.equal((await call(`/api/proposals/${dependency.id}`, "POST", '{"accept":false}')).status, 200);
  assert.equal((await call("/api/dependencies/discover")).body.skipped, 1);
  assert.equal(db.prepare("SELECT id FROM dependency_edges").all().length, 0);
  const merge = (proposalsResponse(db) as any[]).find((p) => p.kind === "merge_proposal");
  assert.equal((await call(`/api/proposals/${merge.id}`, "POST", '{"accept":false}')).status, 200);
  assert.deepEqual(proposalsResponse(db), []);
});

test("the discover route uses Access verification and the configured origin in production", async (t) => {
  const db = seed(t);
  const config: AccessConfig = { host: "scout.example.test", teamDomain: "team.example.test", aud: "discovery-test", allowedEmails: ["reviewer@example.test"] };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" } as Jwk;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", kid: "test" })}.${encode({ iss: `https://${config.teamDomain}`, aud: config.aud, email: "reviewer@example.test", exp: now + 3600, nbf: now - 10 })}`;
  const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), pair.privateKey).toString("base64url")}`;
  let calls = 0;
  const { call } = await hub(t, db, { access: { config, keys: async () => [key] }, discoverModel: async () => { calls++; return "[]"; } });
  const headers = { host: config.host, "cf-access-jwt-assertion": assertion };
  assert.equal((await call("/api/dependencies/discover")).status, 421);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { host: config.host })).status, 403);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { ...headers, "cf-access-jwt-assertion": "invalid" })).status, 403);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { ...headers, origin: "http://127.0.0.1" })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await call("/api/dependencies/discover", "POST", "{}", { ...headers, origin: `https://${config.host}` })).status, 200);
  assert.equal(calls, 1);
});
