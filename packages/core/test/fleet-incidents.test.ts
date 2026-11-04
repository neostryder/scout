import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION, acknowledge, digest, fingerprint, heartbeatMetaKey, inQuietHours, incidentById, ingest, listIncidents, muteRule, openCatalog, snooze, sweepEscalations, unmuteRule, type IncidentPacket } from "../src/index.ts";

const T = "2026-10-31T18:00:00.000Z";
const QUIET = "2026-10-31T12:00:00.000Z";
const MIN = 60_000;
/** The earlier tests predate the clean-check count, so they resolve on the first clean check. */
const ONE = { resolveAfterCleanChecks: 1 };

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

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

test("ingest routes critical, quiet hours, recovery, repeats, snooze and mute", () => {
  const db = openCatalog(":memory:");
  try {
    const opened = ingest(db, packet({ failureClass: "dead", severity: "critical", summary: "down" }), T);
    assert.equal(opened[0]?.kind, "notify-now");
    assert.equal(opened[0]?.reason, "critical");
    const again = ingest(db, packet({ failureClass: "dead", severity: "critical", summary: "down", count: 2 }), plus(T, MIN));
    assert.deepEqual(again, []);
    assert.equal(incidentById(db, opened[0]!.incident.id)?.count, 2);

    const held = ingest(db, packet({ host: "mini", failureClass: "network-path", severity: "critical" }), QUIET);
    assert.equal(held[0]?.kind, "digest");
    assert.equal(held[0]?.reason, "quiet-hours");
    const interrupt = ingest(db, packet({ host: "mini", component: "disk", failureClass: "resources", severity: "critical" }), QUIET);
    assert.equal(interrupt[0]?.kind, "notify-now");
    const deadQuiet = ingest(db, packet({ host: "mini", component: "agent", failureClass: "dead", severity: "info" }), QUIET);
    assert.equal(deadQuiet[0]?.kind, "notify-now");

    const warning = ingest(db, packet({ host: "mini", component: "sync" }), QUIET);
    assert.equal(warning[0]?.kind, "digest");
    assert.equal(warning[0]?.reason, "warning");

    const recovered = ingest(db, packet({ failureClass: "dead", severity: "critical", recovered: true }), plus(T, 2 * MIN), ONE);
    assert.equal(recovered[0]?.kind, "recovered");
    assert.equal(recovered[0]?.incident.state, "resolved");

    muteRule(db, "*/backup/*", "too noisy", T);
    const muted = ingest(db, packet({ host: "other" }), T);
    assert.equal(muted[0]?.kind, "suppressed");
    assert.equal(muted[0]?.reason, "muted");
    assert.equal(unmuteRule(db, "*/backup/*"), true);

    const fresh = ingest(db, packet({ host: "other", component: "clock", failureClass: "slow-or-timeout" }), T);
    snooze(db, fresh[0]!.incident.id, plus(T, 30 * MIN), T);
    const resolved = ingest(db, packet({ host: "other", component: "clock", failureClass: "slow-or-timeout", recovered: true }), plus(T, MIN), ONE);
    assert.equal(resolved[0]?.kind, "digest");
    assert.equal(resolved[0]?.reason, "recovered");
    const snoozed = ingest(db, packet({ host: "other", component: "clock", failureClass: "slow-or-timeout" }), plus(T, 2 * MIN));
    assert.equal(snoozed[0]?.kind, "suppressed");
    assert.equal(snoozed[0]?.reason, "snoozed");

    assert.equal(ingest(db, packet({ evidence: { snapshot: { taskResult: 267009 } } }), T).length, 0);
    assert.equal(listIncidents(db, { host: "desktop", failureClass: "ran-failed" }).length, 0);
    const beat = packet({ component: "pulse", failureClass: "watcher-failure", severity: "info", evidence: { snapshot: { heartbeat: true } } });
    assert.equal(ingest(db, beat, T).length, 0);
    const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get(heartbeatMetaKey("desktop", "pulse")) as { value: string };
    assert.equal(meta.value, T);

    const secret = ingest(db, packet({ host: "lab", summary: "password=hunter2" }), T);
    assert.equal(secret[0]?.incident.summary.includes("hunter2"), false);
    assert.equal(acknowledge(db, secret[0]!.incident.id, T)?.state, "acknowledged");
    assert.equal(acknowledge(db, secret[0]!.incident.id, plus(T, MIN))?.state, "acknowledged");
  } finally {
    db.close();
  }
});

test("flap suppression latches on the third reopen inside 60 minutes and clears after an hour resolved", () => {
  const db = openCatalog(":memory:");
  try {
    const fail = (at: string) => ingest(db, packet(), at);
    const recover = (at: string) => ingest(db, packet({ recovered: true }), at, ONE);
    fail(plus(T, -MIN));
    recover(plus(T, -30_000));
    assert.equal(fail(T)[0]?.kind, "digest");
    recover(plus(T, MIN));
    assert.equal(fail(plus(T, 30 * MIN))[0]?.kind, "digest");
    recover(plus(T, 31 * MIN));
    const third = fail(plus(T, 60 * MIN));
    assert.equal(third[0]?.kind, "suppressed");
    assert.equal(third[0]?.reason, "flapping");
    recover(plus(T, 61 * MIN));
    assert.deepEqual(fail(plus(T, 62 * MIN)), []);
    recover(plus(T, 63 * MIN));
    const cleared = fail(plus(T, 63 * MIN + 60 * MIN));
    assert.equal(cleared[0]?.kind, "digest");
  } finally {
    db.close();
  }
});

test("a reopen one millisecond outside the window does not latch", () => {
  const db = openCatalog(":memory:");
  try {
    ingest(db, packet(), plus(T, -MIN));
    ingest(db, packet({ recovered: true }), plus(T, -30_000), ONE);
    ingest(db, packet(), T);
    ingest(db, packet({ recovered: true }), plus(T, MIN), ONE);
    ingest(db, packet(), plus(T, 30 * MIN));
    ingest(db, packet({ recovered: true }), plus(T, 31 * MIN), ONE);
    const outside = ingest(db, packet(), plus(T, 60 * MIN + 1));
    assert.equal(outside[0]?.kind, "digest");
    assert.notEqual(outside[0]?.reason, "flapping");
  } finally {
    db.close();
  }
});

test("escalation waits 30 minutes, repeats every 2 hours, and stops once acknowledged or snoozed", () => {
  const db = openCatalog(":memory:");
  try {
    const opened = ingest(db, packet({ failureClass: "dead", severity: "critical" }), T);
    const id = opened[0]!.incident.id;
    assert.deepEqual(sweepEscalations(db, plus(T, 30 * MIN - 1)), []);
    const first = sweepEscalations(db, plus(T, 30 * MIN));
    assert.equal(first[0]?.kind, "escalate");
    assert.equal(first[0]?.reason, "unacknowledged");
    assert.deepEqual(sweepEscalations(db, plus(T, 30 * MIN + 120 * MIN - 1)), []);
    assert.equal(sweepEscalations(db, plus(T, 30 * MIN + 120 * MIN))[0]?.kind, "escalate");
    acknowledge(db, id, plus(T, 200 * MIN));
    assert.deepEqual(sweepEscalations(db, plus(T, 400 * MIN)), []);

    const other = ingest(db, packet({ component: "disk", failureClass: "wedged", severity: "critical" }), T);
    snooze(db, other[0]!.incident.id, plus(T, 60 * MIN), T);
    assert.deepEqual(sweepEscalations(db, plus(T, 40 * MIN)), []);
  } finally {
    db.close();
  }
});

test("quiet hours cross midnight for a fixed offset and for local time", () => {
  const quiet = { start: "22:00", end: "07:00", timezone: "-07:00" };
  assert.equal(inQuietHours(new Date("2026-11-01T06:30:00.000Z"), quiet), true);
  assert.equal(inQuietHours(new Date("2026-10-31T13:59:00.000Z"), quiet), true);
  assert.equal(inQuietHours(new Date("2026-10-31T14:00:00.000Z"), quiet), false);
  assert.equal(inQuietHours(new Date("2026-10-31T04:59:00.000Z"), quiet), false);
  assert.equal(inQuietHours(new Date("2026-10-31T05:00:00.000Z"), quiet), true);
  const evening = new Date(2026, 9, 31, 23, 30, 0, 0);
  const morning = new Date(2026, 9, 31, 7, 0, 0, 0);
  const before = new Date(2026, 9, 31, 21, 59, 0, 0);
  const local = { start: "22:00", end: "07:00", timezone: "local" };
  assert.equal(inQuietHours(evening, local), true);
  assert.equal(inQuietHours(morning, local), false);
  assert.equal(inQuietHours(before, local), false);
});

test("digest groups pending incidents by host", () => {
  const db = openCatalog(":memory:");
  try {
    ingest(db, packet({ host: "mini", component: "a" }), T);
    ingest(db, packet({ host: "mini", component: "b" }), T);
    ingest(db, packet({ host: "desktop", component: "c" }), T);
    const built = digest(db, plus(T, MIN));
    assert.deepEqual(built.groups.map((group) => [group.host, group.count]), [["desktop", 1], ["mini", 2]]);
    assert.equal(digest(db, plus(T, 2 * MIN)).groups.length, 0);
  } finally {
    db.close();
  }
});

test("a version 3 catalog gains the fleet tables at version 4", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-schema-"));
  const path = join(dir, "catalog.db");
  try {
    const prior = new DatabaseSync(path);
    prior.exec(SCHEMA_SQL);
    prior.exec("DROP TABLE IF EXISTS fleet_events");
    prior.exec("DROP TABLE IF EXISTS fleet_rules");
    prior.exec("DROP TABLE IF EXISTS fleet_incidents");
    prior.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3') ON CONFLICT(key) DO UPDATE SET value = '3'").run();
    prior.close();
    const db = openCatalog(path);
    try {
      assert.equal(SCHEMA_VERSION, 4);
      assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "4");
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_incidents'").get());
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_rules'").get());
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_events'").get());
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an incident needs several clean checks in a row before it resolves, and a failure in between starts the count over", () => {
  const db = openCatalog(":memory:");
  try {
    const critical = (overrides: Partial<IncidentPacket> = {}) => packet({ failureClass: "dead", severity: "critical", ...overrides });
    const id = ingest(db, critical(), T)[0]!.incident.id;
    assert.deepEqual(ingest(db, critical({ recovered: true }), plus(T, MIN)), []);
    assert.deepEqual(ingest(db, critical({ recovered: true }), plus(T, 2 * MIN)), []);
    assert.equal(incidentById(db, id)?.state, "open");
    assert.equal(incidentById(db, id)?.cleanChecks, 2);
    assert.deepEqual(ingest(db, critical(), plus(T, 3 * MIN)), []);
    assert.equal(incidentById(db, id)?.cleanChecks, 0);
    assert.deepEqual(ingest(db, critical({ recovered: true }), plus(T, 4 * MIN)), []);
    assert.deepEqual(ingest(db, critical({ recovered: true }), plus(T, 5 * MIN)), []);
    const done = ingest(db, critical({ recovered: true }), plus(T, 6 * MIN));
    assert.equal(done[0]?.kind, "recovered");
    assert.equal(done[0]?.incident.state, "resolved");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_events WHERE incident_id = ? AND kind = 'reopen'").get(id)?.n, 0);
    const wider = ingest(db, critical({ host: "mini" }), T)[0]!.incident.id;
    for (let at = 1; at <= 4; at++) assert.deepEqual(ingest(db, critical({ host: "mini", recovered: true }), plus(T, at * MIN), { resolveAfterCleanChecks: 5 }), []);
    assert.equal(ingest(db, critical({ host: "mini", recovered: true }), plus(T, 5 * MIN), { resolveAfterCleanChecks: 5 })[0]?.kind, "recovered");
    assert.equal(incidentById(db, wider)?.state, "resolved");
  } finally {
    db.close();
  }
});

test("a warning that recovers goes to the digest and sends no recovery notice", () => {
  const db = openCatalog(":memory:");
  try {
    const id = ingest(db, packet({ failureClass: "dead", severity: "warning" }), T)[0]!.incident.id;
    digest(db, plus(T, MIN));
    const decisions = ingest(db, packet({ failureClass: "dead", severity: "warning", recovered: true }), plus(T, 2 * MIN), ONE);
    assert.equal(decisions[0]?.kind, "digest");
    assert.equal(decisions[0]?.reason, "recovered");
    assert.equal(incidentById(db, id)?.state, "resolved");
    const built = digest(db, plus(T, 3 * MIN));
    assert.deepEqual(built.groups.map((group) => group.incidents.map((incident) => incident.state)), [["resolved"]]);
  } finally {
    db.close();
  }
});

test("an incident sends at most the daily cap of notices, then one capped notice, then nothing until the next day", () => {
  const db = openCatalog(":memory:");
  try {
    const policy = { resolveAfterCleanChecks: 1, maxNoticesPerDay: 3, flapReopens: 100 };
    const dead = (recovered = false) => packet({ failureClass: "dead", severity: "critical", recovered });
    const kinds: string[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      const at = plus(T, cycle * 20 * MIN);
      kinds.push(...ingest(db, dead(), at, policy).map((decision) => `${decision.kind}${decision.kind === "suppressed" ? `:${decision.reason}` : ""}`));
      kinds.push(...ingest(db, dead(true), plus(at, 10 * MIN), policy).map((decision) => `${decision.kind}${decision.kind === "suppressed" ? `:${decision.reason}` : ""}`));
    }
    assert.deepEqual(kinds, ["notify-now", "recovered", "notify-now", "capped", ...Array(8).fill("suppressed:daily-cap")]);
    const id = listIncidents(db)[0]!.id;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_events WHERE incident_id = ? AND kind = 'capped'").get(id)?.n, 1);
    assert.equal(digest(db, plus(T, 3 * 60 * MIN)).groups.length, 1);
    const nextDay = ingest(db, dead(), plus(T, 24 * 60 * MIN), policy);
    assert.equal(nextDay[0]?.kind, "notify-now");
  } finally {
    db.close();
  }
});
