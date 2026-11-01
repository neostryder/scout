import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, openCatalog, type IncidentPacket } from "@scout/core";
import type { Jwk } from "../src/access.ts";
import { FleetService } from "../src/fleet.ts";
import { createHub } from "../src/server.ts";

const T = "2026-10-31T18:00:00.000Z";

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "desktop";
  const component = overrides.component ?? "backup";
  const failureClass = overrides.failureClass ?? "ran-failed";
  return {
    version: 1,
    host,
    component,
    severity: "warning",
    failureClass,
    firstSeen: T,
    lastSeen: T,
    count: 1,
    fingerprint: fingerprint(host, component, failureClass),
    summary: `${component} failed`,
    evidence: {},
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
    ...overrides,
  };
}

function writeConfig(dir: string, tokenName: string | null): string {
  const path = join(dir, "fleet.json");
  const body: Record<string, unknown> = { notifiers: [] };
  if (tokenName) body.ingestTokenEnv = tokenName;
  writeFileSync(path, JSON.stringify(body));
  return path;
}

async function listen(t: TestContext, options: { token?: string; access?: boolean; investigator?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-api-"));
  const db = openCatalog(":memory:");
  const env: Record<string, string> = {};
  if (options.token) env.SCOUT_FLEET_INGEST_TOKEN = options.token;
  const service = new FleetService(db, {
    configPath: writeConfig(dir, options.token ? "SCOUT_FLEET_INGEST_TOKEN" : null),
    env: (name) => env[name],
    now: () => new Date(T),
    every: () => ({ stop() { /* tests call tick directly */ } }),
    ...(options.investigator ? { investigator: { async investigate() { return { ok: true, reference: "note-1", error: null }; } } } : {}),
  });
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Jwk), kid: "k1", alg: "RS256", use: "sig" };
  const access = options.access ? {
    config: { host: "scout.example.test", teamDomain: "team.example.test", aud: "aud-tag-1", allowedEmails: ["user@example.test"] },
    keys: async () => [jwk],
  } : undefined;
  const server = createHub({ db, webRoot: ".", control: false, alerts: { alertsPath: "fixtures/alerts/missing.json" }, fleet: service, ...(access ? { access } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    service.stop();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: method ?? (body === undefined ? "GET" : "POST"), headers: { host: options.access ? "scout.example.test" : `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => {
        let body: unknown = null;
        if (raw.length > 0 && (raw.startsWith("{") || raw.startsWith("["))) body = JSON.parse(raw);
        else if (raw.length > 0) body = raw;
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const liveToken = (): string => {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ iss: "https://team.example.test", aud: ["aud-tag-1"], email: "user@example.test", sub: "u1", exp: now + 3600, nbf: now - 10 })).toString("base64url");
    return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), pair.privateKey).toString("base64url")}`;
  };
  return { call, liveToken, service };
}

test("packet ingest requires a configured bearer and accepts a mixed batch", async (t) => {
  const missing = await listen(t, {});
  const unconfigured = await missing.call("/api/fleet/packets", packet());
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error, "ingest token is not configured");

  const app = await listen(t, { token: "ingest-secret" });
  const denied = await app.call("/api/fleet/packets", packet());
  assert.equal(denied.status, 401);
  const wrong = await app.call("/api/fleet/packets", packet(), { authorization: "Bearer other-secret" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "unauthorized");
  const bad = packet();
  const ok = await app.call("/api/fleet/packets", [bad, { ...bad, failureClass: "nope" }, { ...packet({ evidence: { snapshot: { taskResult: "0x41301" } } }) }], { authorization: "Bearer ingest-secret" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accepted, 2);
  assert.equal(ok.body.rejected.length, 1);
  assert.equal(ok.body.rejected[0].index, 1);
  const listed = await app.call("/api/fleet/incidents");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.incidents.length, 1);
  const tooMany = await app.call("/api/fleet/packets", Array.from({ length: 101 }, () => packet()), { authorization: "Bearer ingest-secret" });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, "at most 100 packets");
  const junk = await app.call("/api/fleet/packets", "[]", { authorization: "Bearer ingest-secret", "content-type": "text/plain" });
  assert.equal(junk.status, 415);
});

test("incident routes ack, snooze, mute and report a missing investigator", async (t) => {
  const app = await listen(t, { token: "ingest-secret" });
  const posted = await app.call("/api/fleet/packets", packet({ failureClass: "dead", severity: "critical" }), { authorization: "Bearer ingest-secret" });
  assert.equal(posted.body.accepted, 1);
  const listed = await app.call("/api/fleet/incidents?state=open&class=dead");
  const id = listed.body.incidents[0].id as number;
  const acked = await app.call(`/api/fleet/incidents/${id}/ack`, {});
  assert.equal(acked.status, 200);
  assert.equal(acked.body.incident.state, "acknowledged");
  const snoozed = await app.call(`/api/fleet/incidents/${id}/snooze`, { minutes: 15 });
  assert.equal(snoozed.status, 200);
  assert.ok(snoozed.body.incident.snoozedUntil);
  const badMinutes = await app.call(`/api/fleet/incidents/${id}/snooze`, { minutes: 0 });
  assert.equal(badMinutes.status, 400);
  const muted = await app.call(`/api/fleet/incidents/${id}/mute`, { reason: "maintenance" });
  assert.equal(muted.status, 200);
  assert.equal(muted.body.ruleKey, "desktop/backup/dead");
  const investigate = await app.call(`/api/fleet/incidents/${id}/investigate`, {});
  assert.equal(investigate.status, 501);
  assert.equal(investigate.body.error, "no investigator configured");
  const missing = await app.call("/api/fleet/incidents/999/ack", {});
  assert.equal(missing.status, 404);
  const badState = await app.call("/api/fleet/incidents?state=closed");
  assert.equal(badState.status, 400);
});

test("production access gates incident reads and leaves packet ingest on the bearer", async (t) => {
  const app = await listen(t, { token: "ingest-secret", access: true, investigator: true });
  const posted = await app.call("/api/fleet/packets", packet(), { authorization: "Bearer ingest-secret" });
  assert.equal(posted.status, 200);
  const hidden = await app.call("/api/fleet/incidents");
  assert.equal(hidden.status, 403);
  const shown = await app.call("/api/fleet/incidents", undefined, { "cf-access-jwt-assertion": app.liveToken() });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.incidents.length, 1);
  const id = shown.body.incidents[0].id as number;
  const investigated = await app.call(`/api/fleet/incidents/${id}/investigate`, {}, { "cf-access-jwt-assertion": app.liveToken() });
  assert.equal(investigated.status, 200);
  assert.equal(investigated.body.reference, "note-1");
});
