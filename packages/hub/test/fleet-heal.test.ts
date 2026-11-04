import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, openCatalog, type FleetNotice, type IncidentPacket } from "@scout/core";
import { FleetService, type FleetServiceOptions } from "../src/fleet.ts";

const T = "2026-10-31T18:00:00.000Z";
const MIN = 60_000;
const healer = { id: "restart-backup", command: ["restart", "backup"], host: "desktop", component: "backup", failureClass: "dead", cooldownMinutes: 60, maxPerDay: 3, timeoutSeconds: 120 };

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "desktop";
  const component = overrides.component ?? "backup";
  const failureClass = overrides.failureClass ?? "dead";
  return {
    version: 1, host, component, severity: "critical", failureClass, firstSeen: T, lastSeen: T, count: 1,
    fingerprint: fingerprint(host, component, failureClass), summary: "backup failed", evidence: {},
    redaction: { applied: false, rules: [] }, ownerChat: null, runbook: null, ...overrides,
  };
}

function setup(t: TestContext, options: { healers?: unknown[]; runCapture?: FleetServiceOptions["runCapture"]; run?: FleetServiceOptions["run"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-heal-"));
  const configPath = join(dir, "fleet.json");
  writeFileSync(configPath, JSON.stringify({ healers: options.healers ?? [healer], policy: { escalateAfterMinutes: 1, escalateEveryMinutes: 1, resolveAfterCleanChecks: 1 }, digestTimes: ["03:33"], notifiers: [{ type: "command", command: ["notify"] }] }));
  const db = openCatalog(":memory:");
  let now = new Date(T);
  const notices: FleetNotice[] = [];
  const calls: { program: string; args: string[]; stdin: string; timeoutMs: number }[] = [];
  const logs: string[] = [];
  const service = new FleetService(db, {
    configPath, now: () => now, log: (line) => logs.push(line),
    run: options.run ?? (async (_program, _args, stdin) => { notices.push(JSON.parse(stdin) as FleetNotice); return { code: 0, error: null }; }),
    runCapture: async (program, args, stdin, timeoutMs) => {
      calls.push({ program, args, stdin, timeoutMs });
      return options.runCapture ? options.runCapture(program, args, stdin, timeoutMs) : { code: 0, stdout: '{"ok":true}', error: null };
    },
  });
  t.after(() => { service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const events = (kind: string) => db.prepare("SELECT incident_id, at, detail FROM fleet_events WHERE kind = ? ORDER BY id").all(kind) as { incident_id: number | null; at: string; detail: string }[];
  const advance = (minutes: number) => { now = new Date(Date.parse(T) + minutes * MIN); };
  const seed = (kind: string, at: string, detail: string, incidentId: number) => db.prepare("INSERT INTO fleet_events (incident_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(incidentId, at, kind, detail);
  return { db, service, notices, calls, logs, events, advance, seed };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("an exact allowlist match heals after the incident notice and audits the attempt", async (t) => {
  const app = setup(t, { healers: [healer, { ...healer, id: "second", command: ["unused"] }] });
  await app.service.accept([packet()]);
  await drain();
  const incident = app.service.incidents({})[0]!;
  const { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count } = incident;
  assert.deepEqual(app.calls, [{ program: "restart", args: ["backup"], stdin: JSON.stringify({ incident: { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count }, packet: incident.packet }), timeoutMs: 120_000 }]);
  assert.equal(app.events("heal-start")[0]?.detail, "desktop/backup/dead restart-backup");
  assert.equal(app.events("heal")[0]?.detail, "desktop/backup/dead restart-backup");
  assert.deepEqual(app.notices.map((notice) => notice.kind), ["incident", "healed"]);
  assert.equal(app.notices[1]?.title, "healed attempt: desktop backup");
  assert.equal(app.notices[1]?.severity, "info");
  assert.deepEqual(app.notices[1]?.actions, []);
  assert.equal(app.service.incidents({})[0]?.state, "open");
  const kinds = app.db.prepare("SELECT kind FROM fleet_events ORDER BY id").all() as { kind: string }[];
  assert.ok(kinds.findIndex((row) => row.kind === "delivered") < kinds.findIndex((row) => row.kind === "heal-start"));
});

test("healers require exact host, component and class matches", async (t) => {
  const app = setup(t);
  for (const overrides of [{ host: "Desktop" }, { host: "desktop-other" }, { component: "Backup" }, { component: "backup-other" }, { failureClass: "wedged" as const }]) {
    await app.service.accept([packet(overrides)]);
  }
  await drain();
  assert.equal(app.calls.length, 0);
  assert.equal(app.events("heal-start").length, 0);
});

test("digest, recovered and suppressed decisions never heal", async (t) => {
  const app = setup(t, { healers: [{ ...healer, failureClass: "ran-failed" }] });
  await app.service.accept([packet({ failureClass: "ran-failed", severity: "warning" })]);
  await app.service.accept([packet({ failureClass: "ran-failed", severity: "warning", recovered: true })]);
  await drain();
  assert.equal(app.calls.length, 0);
  assert.equal(app.events("heal-start").length, 0);
  assert.equal(app.notices.length, 0);
  const muted = setup(t);
  muted.db.prepare("INSERT INTO fleet_rules (rule_key, reason, muted_at) VALUES (?, ?, ?)").run("desktop/backup/dead", "muted", T);
  await muted.service.accept([packet()]);
  await drain();
  assert.equal(muted.calls.length, 0);
});

test("a resolved or acknowledged incident cannot heal while its initial notice is pending", async (t) => {
  for (const state of ["resolved", "acknowledged"] as const) {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = setup(t, { run: async () => { await gate; return { code: 0, error: null }; } });
    await app.service.accept([packet()]);
    const incident = app.service.incidents({})[0]!;
    if (state === "resolved") await app.service.accept([packet({ recovered: true })]);
    else app.service.ack(incident.id);
    release?.();
    await drain();
    assert.equal(app.calls.length, 0);
  }
});

test("escalations heal only after cooldown and respect the rolling daily limit", async (t) => {
  const app = setup(t, { healers: [{ ...healer, maxPerDay: 2 }] });
  await app.service.accept([packet()]);
  await drain();
  app.advance(1);
  app.service.tick();
  await drain();
  assert.equal(app.calls.length, 1);
  assert.equal(app.events("heal-skipped").length, 0);
  app.advance(60);
  app.service.tick();
  await drain();
  assert.equal(app.calls.length, 2);
  app.advance(120);
  app.service.tick();
  await drain();
  app.advance(121);
  app.service.tick();
  await drain();
  assert.equal(app.calls.length, 2);
  assert.equal(app.events("heal-skipped").length, 1);
  app.advance(6 * 60);
  app.service.tick();
  await drain();
  assert.equal(app.events("heal-skipped").length, 2);
  app.advance(24 * 60 + 61);
  app.service.tick();
  await drain();
  assert.equal(app.calls.length, 3);
  assert.equal(app.events("heal").length, 3);
});

test("rate limits include failed attempts on other incidents with the same exact key", async (t) => {
  const app = setup(t, { healers: [{ ...healer, maxPerDay: 1 }] });
  await app.service.accept([packet({ component: "other" })]);
  await drain();
  const other = app.service.incidents({}).find((row) => row.component === "other")!;
  app.seed("heal-failed", T, "desktop/backup/dead failed", other.id);
  app.advance(61);
  await app.service.accept([packet()]);
  await drain();
  assert.equal(app.calls.length, 0);
  assert.equal(app.events("heal-skipped").length, 1);
  const incident = app.service.incidents({}).find((row) => row.component === "backup")!;
  assert.equal(app.events("heal-skipped")[0]?.incident_id, incident.id);
  app.advance(25 * 60);
  app.service.tick();
  await drain();
  assert.equal(app.calls.length, 1);
});

test("healer failures are audited, redacted and sent as warning notices", async (t) => {
  const results = [
    { code: 0, stdout: 'progress\n{"ok":false,"error":"declined"}\n\n', error: null },
    { code: 3, stdout: '{"ok":true}', error: null },
    { code: null, stdout: "", error: "timeout" },
    { code: 0, stdout: '{"ok":"true"}', error: null },
    { code: 0, stdout: '[]', error: null },
  ];
  for (const result of results) {
    const app = setup(t, { healers: [{ ...healer, timeoutSeconds: 7 }], runCapture: async () => result });
    await app.service.accept([packet()]);
    await drain();
    assert.equal(app.calls[0]?.timeoutMs, 7000);
    assert.equal(app.events("heal-start").length, 1);
    assert.equal(app.events("heal-failed").length, 1);
    assert.equal(app.events("heal").length, 0);
    assert.equal(app.notices[1]?.title, "heal failed: desktop backup");
    assert.equal(app.notices[1]?.severity, "warning");
    assert.deepEqual(app.notices[1]?.actions.map((action) => action.id), ["investigate", "snooze", "mute"]);
  }
  const thrown = setup(t, { runCapture: async () => { throw new Error("failed https://example.test/private Bearer hidden"); } });
  assert.equal((await thrown.service.accept([packet()])).accepted, 1);
  await drain();
  assert.equal(thrown.events("heal-failed")[0]?.detail, "desktop/backup/dead failed [redacted:url] [redacted:bearer]");
  assert.equal(thrown.notices[1]?.body, "failed [redacted:url] [redacted:bearer]");
  thrown.advance(60);
  assert.doesNotThrow(() => thrown.service.tick());
  await drain();
  assert.equal(thrown.events("heal-failed").length, 2);
});

test("an exit zero without JSON counts as a completed heal attempt", async (t) => {
  for (const stdout of ["", "command completed", 'progress\n{"ok":true}\n \n']) {
    const app = setup(t, { runCapture: async () => ({ code: 0, stdout, error: null }) });
    await app.service.accept([packet()]);
    await drain();
    assert.equal(app.events("heal").length, 1);
  }
});

test("one in-flight heal per incident does not block later ticks", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = setup(t, { runCapture: async () => { await gate; return { code: 0, stdout: "", error: null }; } });
  assert.equal((await app.service.accept([packet()])).accepted, 1);
  await drain();
  app.advance(61);
  app.service.tick();
  await drain();
  assert.equal(app.calls.length, 1);
  assert.equal(app.events("heal-start").length, 1);
  assert.equal(app.events("heal").length, 0);
  release?.();
  await drain();
  assert.equal(app.events("heal").length, 1);
});
