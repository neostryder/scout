import { test } from "node:test";
import assert from "node:assert/strict";
import { explainIncident, fingerprint, findNote, incidentById, ingest, isFlapping, openCatalog, resolvePolicy, stamp, type ComponentNote, type IncidentPacket } from "../src/index.ts";

const T = "2026-11-03T18:00:00.000Z";
const MIN = 60_000;
const POLICY = resolvePolicy({ quietHours: { start: "22:00", end: "07:00", timezone: "-07:00" }, resolveAfterCleanChecks: 3 });
const ONE = { resolveAfterCleanChecks: 1, flapReopens: 100 };

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "gamemaster";
  const component = overrides.component ?? "email-reply-watcher";
  const failureClass = overrides.failureClass ?? "dead";
  return {
    version: 1, host, component, severity: "warning", failureClass, firstSeen: T, lastSeen: T, count: 1,
    fingerprint: fingerprint(host, component, failureClass), summary: "keep-alive job is not running", evidence: {},
    redaction: { applied: false, rules: [] }, ownerChat: "Mail", runbook: null, ...overrides,
  };
}

const NOTES: ComponentNote[] = [
  { host: "*", component: "*", description: "Something Scout watches." },
  { host: "gamemaster", component: "email-*", description: "The service that answers incoming mail.", falseAlarm: "launchd is between restarts", nextStep: "Check the service log on gamemaster." },
];

test("a note is matched by host and component with wildcards, first match wins", () => {
  assert.equal(findNote(NOTES, "gamemaster", "email-reply-watcher")?.description, "Something Scout watches.");
  assert.equal(findNote([NOTES[1]!, NOTES[0]!], "gamemaster", "email-reply-watcher")?.nextStep, "Check the service log on gamemaster.");
  assert.equal(findNote([NOTES[1]!], "eru", "email-reply-watcher"), null);
  assert.equal(findNote([], "eru", "x"), null);
});

test("an incident message says what happened, what it is, whether it is real, how often, who owns it, and what to do", () => {
  const db = openCatalog(":memory:");
  try {
    const incident = ingest(db, packet(), T)[0]!.incident;
    const body = explainIncident({ db, incident, now: T, notes: [NOTES[1]!], policy: POLICY, kind: "incident" });
    const lines = body.split("\n");
    assert.deepEqual(lines.map((line) => line.split(":")[0]), ["What happened", "What it is", "Real or false alarm", "How often", "Owner", "Next step"]);
    assert.match(lines[0]!, /keep-alive job is not running\.$/);
    assert.match(lines[1]!, /The service that answers incoming mail\./);
    assert.match(lines[2]!, /^Real or false alarm: Looks real: the process stopped and was still down at the last check\. It can be a false alarm when launchd is between restarts\.$/);
    assert.match(lines[3]!, /^How often: once in the last 24 hours, first seen 2026-11-03 11:00 -07:00\.$/);
    assert.equal(lines[4], "Owner: Mail.");
    assert.equal(lines[5], "Next step: Check the service log on gamemaster.");
    assert.doesNotMatch(body, /[^\x20-\x7e\n]/);
  } finally {
    db.close();
  }
});

test("without a note, an owner or a finding, the message still names a next step and says the owner is missing", () => {
  const db = openCatalog(":memory:");
  try {
    const incident = ingest(db, packet({ ownerChat: null }), T)[0]!.incident;
    const body = explainIncident({ db, incident, now: T, notes: [], policy: POLICY, kind: "incident" });
    assert.doesNotMatch(body, /What it is:/);
    assert.match(body, /Owner: none assigned\./);
    assert.match(body, /Next step: Tap Investigate/);
  } finally {
    db.close();
  }
});

test("an alert-quality incident reads as a probable false alarm, and a runbook is the next step when nothing else is", () => {
  const db = openCatalog(":memory:");
  try {
    const quality = ingest(db, packet({ failureClass: "alert-quality", component: "onedrive-updater", runbook: "docs/runbooks/onedrive.md" }), T)[0]!.incident;
    const body = explainIncident({ db, incident: quality, now: T, notes: [], policy: POLICY, kind: "incident" });
    assert.match(body, /Probably a false alarm: this reports a problem in Scout's alerting rather than in a service/);
    assert.match(body, /Next step: Follow the runbook\. docs\/runbooks\/onedrive\.md\./);
  } finally {
    db.close();
  }
});

test("an investigation finding supplies the cause and the next step, ahead of the note", () => {
  const db = openCatalog(":memory:");
  try {
    const incident = ingest(db, packet(), T)[0]!.incident;
    db.prepare(`INSERT INTO fleet_investigations (incident_id, fingerprint, opened_at, started_at, finished_at, status, cause, proposed_fix, needs_human)
      VALUES (?, ?, ?, ?, ?, 'done', ?, ?, 0)`).run(incident.id, incident.fingerprint, T, T, T, "The mail token expired.", "Renew the mail token and restart the job.");
    const body = explainIncident({ db, incident, now: T, notes: [NOTES[1]!], policy: POLICY, kind: "incident" });
    assert.match(body, /Investigation found: The mail token expired\./);
    assert.match(body, /Next step: The investigation proposes this fix\. Renew the mail token and restart the job\./);
    assert.doesNotMatch(body, /Check the service log/);
    db.prepare("UPDATE fleet_investigations SET proposed_fix = NULL, needs_human = 1").run();
    assert.match(explainIncident({ db, incident, now: T, notes: [], policy: POLICY, kind: "incident" }), /Next step: The investigation found no clear answer, so a person needs to look\./);
  } finally {
    db.close();
  }
});

test("the count and the flapping call come from the last 24 hours of the incident's own history", () => {
  const db = openCatalog(":memory:");
  try {
    const id = ingest(db, packet(), T)[0]!.incident.id;
    for (let cycle = 1; cycle <= 3; cycle++) {
      ingest(db, packet({ recovered: true }), plus(T, cycle * 20 * MIN), ONE);
      ingest(db, packet(), plus(T, cycle * 20 * MIN + 10 * MIN), ONE);
    }
    const now = plus(T, 2 * 60 * MIN);
    const incident = incidentById(db, id)!;
    assert.equal(isFlapping(db, id, now), true);
    const body = explainIncident({ db, incident, now, notes: [], policy: POLICY, kind: "incident" });
    assert.match(body, /Real but unstable\. It cleared and came back 4 times in the last 24 hours/);
    assert.match(body, /How often: 4 times in the last 24 hours/);
    const later = plus(T, 26 * 60 * MIN);
    assert.equal(isFlapping(db, id, later), false);
    assert.match(explainIncident({ db, incident, now: later, notes: [], policy: POLICY, kind: "incident" }), /How often: once in the last 24 hours/);
  } finally {
    db.close();
  }
});

test("a recovered message names the clean checks and the capped message ends with the muted-until-tomorrow line", () => {
  const db = openCatalog(":memory:");
  try {
    const incident = ingest(db, packet({ severity: "critical" }), T)[0]!.incident;
    const recovered = explainIncident({ db, incident, now: T, notes: [], policy: POLICY, kind: "recovered" });
    assert.match(recovered, /^What happened: it recovered after 3 clean checks in a row\. Before that it reported: keep-alive job is not running\./);
    assert.doesNotMatch(recovered, /Real or false alarm/);
    assert.match(recovered, /Next step: Nothing to do\./);
    const single = explainIncident({ db, incident, now: T, notes: [], policy: { ...POLICY, resolveAfterCleanChecks: 1 }, kind: "recovered" });
    assert.match(single, /after 1 clean check in a row/);
    const capped = explainIncident({ db, incident, now: T, notes: [], policy: POLICY, kind: "capped" });
    const last = capped.split("\n").at(-1)!;
    assert.equal(last, "Still open, once in the last 24 hours. It is muted until tomorrow, and the next digest still lists it.");
    const resolved = { ...incident, state: "resolved" as const };
    assert.match(explainIncident({ db, incident: resolved, now: T, notes: [], policy: POLICY, kind: "capped" }).split("\n").at(-1)!, /^Currently recovered, /);
  } finally {
    db.close();
  }
});

test("a time stamp is written in the policy offset or local time, and a bad value is returned unchanged", () => {
  assert.equal(stamp("2026-11-03T18:00:00.000Z", "-07:00"), "2026-11-03 11:00 -07:00");
  assert.equal(stamp("2026-11-03T03:30:00.000Z", "+05:30"), "2026-11-03 09:00 +05:30");
  assert.match(stamp("2026-11-03T18:00:00.000Z", "local"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} local time$/);
  assert.equal(stamp("not a time", "-07:00"), "not a time");
});
