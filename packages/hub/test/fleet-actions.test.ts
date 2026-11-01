import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fingerprint, openCatalog, type IncidentPacket } from "@scout/core";
import { commandInvestigator, FleetService, runCommandCapture, type FleetServiceOptions } from "../src/fleet.ts";
import { createHub } from "../src/server.ts";

const T = "2026-10-31T18:00:00.000Z";
const token = randomBytes(24).toString("hex");
const authorization = { authorization: `Bearer ${token}` };

function packet(): IncidentPacket {
  return {
    version: 1,
    host: "desktop",
    component: "backup",
    severity: "warning",
    failureClass: "ran-failed",
    firstSeen: T,
    lastSeen: T,
    count: 1,
    fingerprint: fingerprint("desktop", "backup", "ran-failed"),
    summary: "backup failed",
    evidence: {},
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
}

async function listen(t: TestContext, options: { unconfigured?: boolean; access?: boolean; config?: Record<string, unknown>; investigator?: FleetServiceOptions["investigator"]; runCapture?: FleetServiceOptions["runCapture"] } = {}) {
  const dir = mkdtempSync(join(process.cwd(), "fleet-actions-"));
  const configPath = join(dir, "fleet.json");
  const writeConfig = (config: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ ...(options.unconfigured ? {} : { ingestTokenEnv: "SCOUT_FLEET_INGEST_TOKEN" }), ...config }));
  writeConfig(options.config ?? {});
  const db = openCatalog(":memory:");
  const service = new FleetService(db, { configPath, env: () => token, now: () => new Date(T), investigator: options.investigator, runCapture: options.runCapture });
  const server = createHub({
    db, webRoot: ".", control: false, health: false, alerts: { alertsPath: "fixtures/alerts/missing.json" }, fleet: service,
    ...(options.access ? { access: { config: { host: "scout.example.test", teamDomain: "team.example.test", aud: "fleet-test", allowedEmails: [] }, keys: async () => [] } } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => {
    service.stop();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (body?: unknown, headers: Record<string, string> = authorization, method = "POST", path = "/api/fleet/actions"): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: raw.startsWith("{") ? JSON.parse(raw) : raw });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  await service.accept([packet()]);
  const incident = service.incidents({})[0]!;
  return { call, service, db, incident, writeConfig };
}

test("actions require a configured ingest token and reject a wrong or missing token", async (t) => {
  const missing = await listen(t, { unconfigured: true });
  assert.deepEqual(await missing.call({ incidentId: 1, action: "mute" }), { status: 503, body: { error: "ingest token is not configured" } });
  const app = await listen(t);
  for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
    assert.deepEqual(await app.call({ incidentId: app.incident.id, action: "mute" }, headers), { status: 401, body: { error: "unauthorized" } });
  }
});

test("actions reject malformed JSON, invalid fields, and GET", async (t) => {
  const app = await listen(t);
  const valid = { incidentId: app.incident.id, action: "mute" };
  for (const body of ["{", null, [], 1, {}, ...[undefined, null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((incidentId) => ({ ...valid, incidentId })), ...[undefined, null, "ack", 1].map((action) => ({ ...valid, action })), ...[null, 1, "", "x".repeat(41), "invalid/name", "actor\n"].map((actor) => ({ ...valid, actor }))]) {
    const result = await app.call(body);
    assert.equal(result.status, 400);
    assert.equal(typeof result.body.error, "string");
  }
  assert.deepEqual(await app.call(undefined, authorization, "GET"), { status: 405, body: { error: "method not allowed" } });
});

test("actions enforce the 4 KB body limit in bytes", async (t) => {
  const app = await listen(t);
  const body = JSON.stringify({ incidentId: app.incident.id, action: "snooze" });
  assert.equal((await app.call(body + " ".repeat(4096 - body.length))).status, 200);
  for (const raw of [body + " ".repeat(4097 - body.length), JSON.stringify({ incidentId: app.incident.id, action: "mute", actor: "\u00e9".repeat(2048) })]) {
    assert.deepEqual(await app.call(raw), { status: 413, body: { error: "body too large" } });
  }
});

test("actions snooze for an hour and mute with the supplied or default actor", async (t) => {
  const app = await listen(t);
  const incidentId = app.incident.id;
  assert.deepEqual(await app.call({ incidentId, action: "snooze" }), { status: 200, body: { ok: true, message: "Snoozed for an hour." } });
  assert.equal(app.service.incidents({})[0]!.snoozedUntil, "2026-10-31T19:00:00.000Z");
  for (const actor of [undefined, "Test_actor 1.-", "x".repeat(40)]) {
    assert.deepEqual(await app.call({ incidentId, action: "mute", actor }), { status: 200, body: { ok: true, message: "Muted this rule." } });
    const rule = app.db.prepare("SELECT reason FROM fleet_rules WHERE rule_key = ?").get("desktop/backup/ran-failed") as { reason: string };
    assert.equal(rule.reason, `muted from channel by ${actor ?? "api"}`);
    assert.equal(app.service.incidents({})[0]!.muted, true);
  }
});

test("actions report investigation success with an optional reference trimmed to 120 characters", async (t) => {
  let reference: string | null = null;
  const app = await listen(t, { investigator: { async investigate() { return { ok: true, reference, error: null }; } } });
  const body = { incidentId: app.incident.id, action: "investigate" };
  assert.deepEqual(await app.call(body), { status: 200, body: { ok: true, message: "Investigation started." } });
  reference = `  note-${"x".repeat(200)}  `;
  assert.deepEqual(await app.call(body), { status: 200, body: { ok: true, message: `Investigation started: ${reference.trim().slice(0, 120)}` } });
});

test("actions report missing incidents, missing investigators, and investigator errors", async (t) => {
  const app = await listen(t);
  for (const action of ["investigate", "snooze", "mute"]) {
    assert.deepEqual(await app.call({ incidentId: 999, action }), { status: 200, body: { ok: false, message: "not found" } });
  }
  assert.deepEqual(await app.call({ incidentId: app.incident.id, action: "investigate" }), { status: 200, body: { ok: false, message: "no investigator configured" } });
  const failed = await listen(t, { investigator: { async investigate() { return { ok: false, reference: null, error: "investigation failed" }; } } });
  assert.deepEqual(await failed.call({ incidentId: failed.incident.id, action: "investigate" }), { status: 200, body: { ok: false, message: "investigation failed" } });
});

test("only the actions route accepts loopback hosts before the Access gate", async (t) => {
  const app = await listen(t, { access: true });
  const body = { incidentId: app.incident.id, action: "snooze" };
  for (const host of ["127.0.0.1", "127.0.0.1:4870", "localhost", "localhost:4870", "[::1]", "[::1]:4870", "scout.example.test"]) {
    assert.equal((await app.call(body, { ...authorization, host })).status, 200);
    assert.equal((await app.call(body, { host })).status, 401);
    if (host !== "scout.example.test") {
      assert.equal((await app.call(undefined, { host }, "GET", "/api/fleet/incidents")).status, 421);
      assert.equal((await app.call(packet(), { ...authorization, host }, "POST", "/api/fleet/packets")).status, 421);
    }
  }
  for (const host of ["other.example.test", "localhost.example.test", "127.0.0.2"]) {
    assert.equal((await app.call(body, { ...authorization, host })).status, 421);
  }
  assert.equal((await app.call(undefined, { host: "scout.example.test" }, "GET", "/api/fleet/incidents")).status, 403);
});

test("the command investigator receives incident JSON and reloads the command for both entry points", async (t) => {
  const seen: { program: string; args: string[]; stdin: string; timeoutMs: number }[] = [];
  const app = await listen(t, {
    config: { investigator: { command: ["investigate", "--stdin"] } },
    runCapture: async (program, args, stdin, timeoutMs) => { seen.push({ program, args, stdin, timeoutMs }); return { code: 0, stdout: 'progress\n{"ok":true,"reference":"note-1"}\n  \n', error: null }; },
  });
  const incidentId = app.incident.id;
  assert.deepEqual(await app.call({ incidentId, action: "investigate" }), { status: 200, body: { ok: true, message: "Investigation started: note-1" } });
  const { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count } = app.incident;
  assert.deepEqual(seen[0], { program: "investigate", args: ["--stdin"], stdin: JSON.stringify({ incident: { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count }, packet: app.incident.packet }), timeoutMs: 90_000 });
  app.writeConfig({ investigator: { command: ["investigate-reloaded", "--json"] } });
  assert.deepEqual(await app.service.investigateHttp(incidentId), { status: 200, body: { ok: true, reference: "note-1", error: null } });
  assert.equal(seen[1]!.program, "investigate-reloaded");
  assert.deepEqual(seen[1]!.args, ["--json"]);
  app.writeConfig({ investigator: { command: ["investigate-reloaded-again"] } });
  assert.equal((await app.service.handleAction(incidentId, "investigate", "test")).ok, true);
  assert.equal(seen[2]!.program, "investigate-reloaded-again");
  app.writeConfig({});
  assert.deepEqual(await app.service.handleAction(incidentId, "investigate", "test"), { ok: false, error: "no investigator configured" });
  assert.deepEqual(await app.service.investigateHttp(incidentId), { status: 501, body: { error: "no investigator configured" } });
});

test("an injected investigator takes precedence over the configured command", async (t) => {
  const app = await listen(t, {
    config: { investigator: { command: ["unused"] } },
    investigator: { async investigate() { return { ok: true, reference: "injected", error: null }; } },
    runCapture: async () => { assert.fail("the configured command must not run"); },
  });
  assert.equal((await app.call({ incidentId: app.incident.id, action: "investigate" })).body.message, "Investigation started: injected");
  assert.deepEqual(await app.service.investigateHttp(app.incident.id), { status: 200, body: { ok: true, reference: "injected", error: null } });
});

test("the command investigator parses JSON, plain stdout, exits, timeouts, and rejected runners", async (t) => {
  const app = await listen(t);
  const cases = [
    { code: 0, stdout: '{"ok":true}\n', error: null, expected: { ok: true, reference: null, error: null } },
    { code: 0, stdout: '{"ok":false,"error":"declined"}', error: null, expected: { ok: false, reference: null, error: "declined" } },
    { code: 0, stdout: "note-" + "x".repeat(300), error: null, expected: { ok: true, reference: ("note-" + "x".repeat(300)).slice(0, 200), error: null } },
    { code: 7, stdout: '{"ok":true}', error: null, expected: { ok: false, reference: null, error: "exit 7" } },
    { code: null, stdout: "", error: "timeout", expected: { ok: false, reference: null, error: "timeout" } },
    { code: 1, stdout: "", error: "failed https://example.test/private Bearer hidden", expected: { ok: false, reference: null, error: "failed [redacted:url] [redacted:bearer]" } },
    { code: 0, stdout: '{"ok":false,"error":"failed Bearer hidden"}', error: null, expected: { ok: false, reference: null, error: "failed [redacted:bearer]" } },
  ];
  for (const { expected, ...result } of cases) {
    const investigator = commandInvestigator({ command: ["investigate"], run: async () => result });
    assert.deepEqual(await investigator.investigate(app.incident, app.incident.packet), expected);
  }
  const rejected = commandInvestigator({ command: ["investigate"], run: async () => { throw new Error("failed Bearer hidden"); } });
  assert.deepEqual(await rejected.investigate(app.incident, app.incident.packet), { ok: false, reference: null, error: "failed [redacted:bearer]" });
});

test("command failures reach the actions response after secret cleaning", async (t) => {
  const app = await listen(t, { config: { investigator: { command: ["investigate"] } }, runCapture: async () => ({ code: 4, stdout: "", error: "failed Bearer hidden" }) });
  assert.deepEqual(await app.call({ incidentId: app.incident.id, action: "investigate" }), { status: 200, body: { ok: false, message: "failed [redacted:bearer]" } });
});

test("command capture passes stdin, caps stdout at 64 KB, and reports exit and timeout", async () => {
  const echoed = await runCommandCapture(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], "input JSON", 15_000);
  assert.deepEqual(echoed, { code: 0, stdout: "input JSON", error: null });
  const capped = await runCommandCapture(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], "", 15_000);
  assert.equal(capped.code, 0);
  assert.equal(capped.error, null);
  assert.equal(capped.stdout, "x".repeat(65_536));
  assert.deepEqual(await runCommandCapture(process.execPath, ["-e", "process.exit(3)"], "", 15_000), { code: 3, stdout: "", error: "exit 3" });
  assert.deepEqual(await runCommandCapture(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], "", 100), { code: null, stdout: "", error: "timeout" });
});
