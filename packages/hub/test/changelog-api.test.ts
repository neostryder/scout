import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { openCatalog, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { DAILY, WEEKLY, type SourceSummary } from "@scout/research";
import { createHub, type HubOptions } from "../src/server.ts";
import { ResearchSchedule, type ScheduleClock } from "../src/schedule.ts";
import type { AccessConfig, Jwk } from "../src/access.ts";

const NOW = "2026-09-30T06:00:00.000Z";

async function hub(options: Pick<HubOptions, "changelog" | "access"> = {}) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "macos", kind: "host" });
  recordScan(db, "test", { sourceKind: "test", location: "", status: "ok", installs: [{ ecosystem: "npm", key: "tool", name: "Tool", kind: "package", version: "1.0.0", location: "/test/tool", homepage: "https://github.com/example/tool" }] }, NOW);
  recordResearch(db, 1, "github", "ok", [{ channel: "stable", version: "2.0.0", installable: false }], null, NOW);
  const server = createHub({ db, webRoot: process.cwd(), ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "GET", body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return { db, call, port, async close() {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  } };
}

test("research2 changelog routes refresh injected summaries and return the stored public fields", async () => {
  let calls = 0;
  let summaries = 0;
  const instance = await hub({ changelog: { fetch: async (url) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/example/tool/releases/tags/v2.0.0");
    return { status: 200, text: async () => JSON.stringify({ body: "The release fixes startup.", html_url: "https://github.com/example/tool/releases/tag/v2.0.0" }) };
  }, summarize: async (input) => {
    summaries++;
    assert.deepEqual(input, { name: "Tool", version: "2.0.0", installed: "1.0.0", text: "The release fixes startup." });
    return { summary: " The release\u2019s startup\u2014works\u2026 ", model: "fixture" };
  } } });
  const path = "/api/changelog?packageId=1&version=2.0.0";
  const headers = { "content-type": "application/json", origin: `http://127.0.0.1:${instance.port}` };
  try {
    assert.equal((await instance.call(path)).status, 404);
    const refresh = await instance.call("/api/changelog/refresh", "POST", "{}", headers);
    assert.equal(refresh.status, 200);
    assert.deepEqual(JSON.parse(refresh.body), { stored: 1, skipped: 0 });
    const stored = await instance.call(path);
    assert.equal(stored.status, 200);
    const body = JSON.parse(stored.body) as { summary: string; sourceUrl: string; model: string; createdAt: string };
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "model", "sourceUrl", "summary"]);
    assert.equal(body.summary, "The release's startup-works...");
    assert.equal(body.sourceUrl, "https://github.com/example/tool/releases/tag/v2.0.0");
    assert.equal(body.model, "fixture");
    assert.ok(Number.isFinite(Date.parse(body.createdAt)));
    assert.equal(stored.headers["cache-control"], "no-store");
    assert.equal(stored.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(JSON.parse((await instance.call("/api/changelog/refresh", "POST", "{}", headers)).body), { stored: 0, skipped: 0 });
    assert.equal(calls, 1);
    assert.equal(summaries, 1);
    assert.equal((await instance.call("/api/changelog?packageId=1&version=3.0.0")).status, 404);
    assert.equal((await instance.call("/api/changelog?packageId=99&version=2.0.0")).status, 404);
    for (const query of ["", "?packageId=1", "?packageId=0&version=2.0.0", "?packageId=-1&version=2.0.0", "?packageId=1.5&version=2.0.0", "?packageId=bad&version=2.0.0", "?packageId=1&version=%20"]) assert.equal((await instance.call(`/api/changelog${query}`)).status, 400);
  } finally { await instance.close(); }
});

test("research2 changelog refresh reports its skipped count without a configured summarizer", async () => {
  let fetched = false;
  const instance = await hub({ changelog: { fetch: async () => { fetched = true; throw new Error("the request must not run"); } } });
  try {
    const response = await instance.call("/api/changelog/refresh", "POST", "{}", { "content-type": "application/json" });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { stored: 0, skipped: 1, reason: "no summarizer configured" });
    assert.equal(fetched, false);
    assert.equal((await instance.call("/api/changelog?packageId=1&version=2.0.0")).status, 404);
  } finally { await instance.close(); }
});

test("research2 changelog refresh uses the research host, origin, content type and body rules", async () => {
  let calls = 0;
  const instance = await hub({ changelog: { summarize: async () => { calls++; return null; }, fetch: async () => { calls++; throw new Error("the request must not run"); } } });
  const json = { "content-type": "application/json" };
  try {
    assert.equal((await instance.call("/api/changelog?packageId=1&version=2.0.0", "GET", undefined, { host: "evil.example" })).status, 421);
    assert.equal((await instance.call("/api/changelog/refresh", "POST", "{}", { ...json, host: "evil.example" })).status, 421);
    for (const origin of ["https://evil.example", "broken"]) assert.equal((await instance.call("/api/changelog/refresh", "POST", "{}", { ...json, origin })).status, 403);
    assert.equal((await instance.call("/api/changelog/refresh", "POST", "{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await instance.call("/api/changelog/refresh", "POST", " ".repeat(4097), json)).status, 413);
    for (const body of ["broken", "null", "[]", "true"]) assert.equal((await instance.call("/api/changelog/refresh", "POST", body, json)).status, 400);
    assert.equal((await instance.call("/api/changelog", "POST", "{}", json)).status, 405);
    assert.equal((await instance.call("/api/changelog/refresh")).status, 404);
    assert.equal((await instance.call("/api/changelog", "DELETE")).status, 405);
    assert.equal(calls, 0);
  } finally { await instance.close(); }
});

test("research2 changelog routes require Access credentials and the configured production origin", async () => {
  const config: AccessConfig = { host: "scout.example.test", teamDomain: "team.example.test", aud: "changelog-test", allowedEmails: ["test@example.test"] };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key: Jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Jwk), kid: "changelog-key", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: `https://${config.teamDomain}`, aud: config.aud, email: "test@example.test", exp: now + 3600, nbf: now - 10 })).toString("base64url");
  const credential = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
  const instance = await hub({ access: { config, keys: async () => [key] } });
  const headers = { host: config.host, "content-type": "application/json", "cf-access-jwt-assertion": credential };
  try {
    assert.equal((await instance.call("/api/changelog?packageId=1&version=2.0.0")).status, 421);
    assert.equal((await instance.call("/api/changelog?packageId=1&version=2.0.0", "GET", undefined, { host: config.host })).status, 403);
    assert.equal((await instance.call("/api/changelog/refresh", "POST", "{}", { host: config.host, "content-type": "application/json" })).status, 403);
    assert.equal((await instance.call("/api/changelog?packageId=1&version=2.0.0", "GET", undefined, headers)).status, 404);
    assert.equal((await instance.call("/api/changelog/refresh", "POST", "{}", { ...headers, origin: "http://127.0.0.1" })).status, 403);
    assert.equal((await instance.call("/api/changelog/refresh", "POST", "{}", { ...headers, origin: `https://${config.host}` })).status, 200);
  } finally { await instance.close(); }
});

test("research2 schedule reports daily support windows and weekly vendor cadence", async () => {
  const db = openCatalog(":memory:");
  const clock: ScheduleClock = { now: () => Date.parse(NOW), setTimeout: () => undefined, clearTimeout: () => {} };
  let failed = false;
  const schedule = new ResearchSchedule(db, { clock, run: async (_db, researchers): Promise<SourceSummary[]> => researchers.map((source) => ({ source: source.source, asked: 1, ok: failed ? 0 : 1, notfound: 0, failed: failed ? 1 : 0, skipped: 0, answers: failed ? 0 : 1 })) });
  try {
    assert.ok(schedule.status().some((state) => state.source === "vendor"));
    assert.ok(schedule.status().some((state) => state.source === "endoflife"));
    await schedule.runNow(["vendor", "endoflife"]);
    assert.equal(schedule.status().find((state) => state.source === "vendor")?.nextDueAt, new Date(Date.parse(NOW) + WEEKLY).toISOString());
    assert.equal(schedule.status().find((state) => state.source === "endoflife")?.nextDueAt, new Date(Date.parse(NOW) + DAILY).toISOString());
    failed = true;
    await schedule.runNow(["vendor"]);
    assert.equal(schedule.status().find((state) => state.source === "vendor")?.nextDueAt, new Date(Date.parse(NOW) + 3_600_000).toISOString());
  } finally { schedule.stop(); db.close(); }
});
