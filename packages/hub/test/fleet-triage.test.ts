import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, openCatalog, type IncidentPacket } from "@scout/core";
import { commandTriage, FleetService, type FleetServiceOptions } from "../src/fleet.ts";

const T = "2026-10-31T18:00:00.000Z";
const MIN = 60_000;

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  return {
    version: 1, host: "desktop", component: "backup", severity: "warning", failureClass: "ran-failed",
    firstSeen: T, lastSeen: T, count: 1, fingerprint: fingerprint("desktop", "backup", "ran-failed"),
    summary: "backup failed pid 123", evidence: {}, redaction: { applied: false, rules: [] }, ownerChat: null, runbook: null,
    ...overrides,
  };
}

test("command triage sends JSON and validates every verdict field", async () => {
  const verdict = { noise: true, failureClass: "resources", severity: "critical", ownerChat: "x".repeat(220), groupWith: "backup", healSafe: false, cause: "c".repeat(330), extra: true };
  const triage = commandTriage({ command: ["triage", "--stdin"], timeoutMs: 4321, run: async (program, args, stdin, timeoutMs) => {
    assert.equal(program, "triage");
    assert.deepEqual(args, ["--stdin"]);
    assert.deepEqual(JSON.parse(stdin), { packet: packet() });
    assert.equal(timeoutMs, 4321);
    return { code: 0, stdout: `progress\n${JSON.stringify(verdict)}\n \n`, error: null };
  } });
  assert.deepEqual(await triage.classify(packet()), { noise: true, failureClass: "resources", severity: "critical", ownerChat: "x".repeat(200), groupWith: "backup", healSafe: false, cause: "c".repeat(300) });
  for (const value of [null, 1, [], {}, true, "unknown"]) {
    const triage = commandTriage({ command: ["triage"], run: async () => ({ code: 0, error: null, stdout: JSON.stringify({ noise: false, failureClass: value, severity: value, ownerChat: value, groupWith: value, healSafe: value, cause: value }) }) });
    const result = await triage.classify(packet());
    assert.equal(result.noise, false);
    assert.equal(result.failureClass, undefined);
    assert.equal(result.severity, undefined);
    assert.equal(result.ownerChat, typeof value === "string" ? value : undefined);
    assert.equal(result.groupWith, typeof value === "string" ? value : undefined);
    assert.equal(result.healSafe, typeof value === "boolean" ? value : undefined);
    assert.equal(result.cause, typeof value === "string" ? value : undefined);
  }
});

test("command triage fails open for exits, timeouts, spawn errors and invalid output", async () => {
  for (const result of [
    { code: 7, stdout: '{"noise":true}', error: null },
    { code: null, stdout: "", error: "timeout" },
    ...["garbage", "", "[]", "null", "{}", '{"noise":"true"}', '{"noise":1}'].map((stdout) => ({ code: 0, stdout, error: null })),
  ]) {
    assert.deepEqual(await commandTriage({ command: ["triage"], run: async () => result }).classify(packet()), { noise: false });
  }
  assert.deepEqual(await commandTriage({ command: ["triage"], run: async () => { throw new Error("spawn failed"); } }).classify(packet()), { noise: false });
  assert.deepEqual(await commandTriage({ command: [] }).classify(packet()), { noise: false });
});

test("triage caches normalized keys, expires successful verdicts and bounds the oldest entries", async () => {
  let calls = 0;
  let now = new Date(T);
  const triage = commandTriage({ command: ["triage"], now: () => now, ttlMs: 1000, run: async (_program, _args, _stdin, timeoutMs) => {
    calls += 1;
    assert.equal(timeoutMs, 30_000);
    return { code: 0, stdout: '{"noise":false}', error: null };
  } });
  await triage.classify(packet());
  await triage.classify(packet({ summary: "backup failed pid 98765" }));
  assert.equal(calls, 1);
  now = new Date(Date.parse(T) + 999);
  await triage.classify(packet());
  assert.equal(calls, 1);
  now = new Date(Date.parse(T) + 1000);
  await triage.classify(packet());
  assert.equal(calls, 2);
  await triage.classify(packet({ summary: "a different failure" }));
  await triage.classify(packet({ fingerprint: "other" }));
  assert.equal(calls, 4);
  for (let index = 0; index < 498; index += 1) await triage.classify(packet({ fingerprint: `unique-${index}` }));
  await triage.classify(packet({ fingerprint: "unique-497" }));
  assert.equal(calls, 502);
  await triage.classify(packet());
  assert.equal(calls, 503);
});

test("triage caches failures for five minutes and shares concurrent work", async () => {
  let now = new Date(T);
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const triage = commandTriage({ command: ["triage"], now: () => now, ttlMs: 1, run: async () => {
    calls += 1;
    await gate;
    return { code: null, stdout: "", error: "timeout" };
  } });
  const first = triage.classify(packet());
  const second = triage.classify(packet({ summary: "backup failed pid 5" }));
  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), [{ noise: false }, { noise: false }]);
  now = new Date(Date.parse(T) + 5 * MIN - 1);
  await triage.classify(packet());
  assert.equal(calls, 1);
  now = new Date(Date.parse(T) + 5 * MIN);
  await triage.classify(packet());
  assert.equal(calls, 2);
});

function setup(t: TestContext, options: FleetServiceOptions["runCapture"], triage?: FleetServiceOptions["triage"]) {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-triage-"));
  const configPath = join(dir, "fleet.json");
  writeFileSync(configPath, JSON.stringify({ triage: { command: ["triage"] } }));
  const db = openCatalog(":memory:");
  let now = new Date(T);
  const service = new FleetService(db, { configPath, runCapture: options, triage, now: () => now });
  t.after(() => { service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const events = (kind: string) => db.prepare("SELECT incident_id, detail FROM fleet_events WHERE kind = ?").all(kind).map((row) => ({ ...row }));
  return { service, events, setNow: (date: Date) => { now = date; }, configPath };
}

test("config triage drops noise once per cached key and preserves its cache across ticks", async (t) => {
  let calls = 0;
  const app = setup(t, async () => { calls += 1; return { code: 0, stdout: '{"noise":true,"cause":"expected shutdown"}', error: null }; });
  await app.service.accept([packet(), packet({ summary: "backup failed pid 8" })]);
  app.service.tick();
  writeFileSync(app.configPath, JSON.stringify({ triage: { command: ["triage"] }, digestTimes: ["03:33"] }));
  await app.service.accept([packet()]);
  assert.equal(calls, 1);
  assert.equal(app.service.incidents({}).length, 0);
  assert.deepEqual(app.events("triage-noise"), [{ incident_id: null, detail: "desktop backup: expected shutdown" }]);
  app.setNow(new Date(Date.parse(T) + 6 * 60 * MIN));
  await app.service.accept([packet()]);
  assert.equal(calls, 2);
  assert.equal(app.events("triage-noise").length, 2);
});

test("config triage rewrites classification and records each incident cause once", async (t) => {
  const app = setup(t, async () => ({ code: 0, stdout: '{"noise":false,"failureClass":"credentials-quota","severity":"info","ownerChat":"ops","cause":"token expired"}', error: null }));
  await app.service.accept([packet(), packet(), packet({ summary: "new summary" })]);
  const incident = app.service.incidents({})[0]!;
  assert.equal(incident.failureClass, "credentials-quota");
  assert.equal(incident.fingerprint, fingerprint("desktop", "backup", "credentials-quota"));
  assert.equal(incident.severity, "info");
  assert.equal(incident.ownerChat, "ops");
  assert.deepEqual(app.events("triage"), [{ incident_id: incident.id, detail: "token expired" }]);
});

test("an injected triage takes precedence over the configured command", async (t) => {
  const app = setup(t, async () => { assert.fail("the configured command must not run"); }, { classify: async () => ({ noise: true }) });
  await app.service.accept([packet(), packet()]);
  assert.equal(app.service.incidents({}).length, 0);
  assert.equal(app.events("triage-noise").length, 1);
});
