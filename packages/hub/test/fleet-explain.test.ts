import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, openCatalog, type FleetNotice, type IncidentPacket } from "@scout/core";
import { FleetService } from "../src/fleet.ts";

const T = "2026-11-03T18:00:00.000Z";
const MIN = 60_000;
/** The digest fires on the machine's local clock, so the slot is the local time half an hour after T. */
const SLOT = (() => {
  const at = new Date(Date.parse(T) + 30 * MIN);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
})();

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "gamemaster";
  const component = overrides.component ?? "email-reply-watcher";
  const failureClass = overrides.failureClass ?? "dead";
  return {
    version: 1, host, component, severity: "critical", failureClass, firstSeen: T, lastSeen: T, count: 1,
    fingerprint: fingerprint(host, component, failureClass), summary: "keep-alive job is not running", evidence: {},
    redaction: { applied: false, rules: [] }, ownerChat: "Mail", runbook: null, ...overrides,
  };
}

function setup(t: TestContext, file: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-explain-"));
  const configPath = join(dir, "fleet.json");
  writeFileSync(configPath, JSON.stringify({
    digestTimes: [SLOT],
    notifiers: [{ type: "command", command: ["notify"] }],
    components: [{ host: "gamemaster", component: "email-*", description: "The service that answers incoming mail.", falseAlarm: "launchd is between restarts", nextStep: "Check the service log on gamemaster." }],
    ...file,
    policy: { quietHours: { start: "23:00", end: "23:01", timezone: "+00:00" }, escalateAfterMinutes: 600, escalateEveryMinutes: 600, ...(file.policy as object | undefined) },
  }));
  const db = openCatalog(":memory:");
  let now = new Date(T);
  const notices: FleetNotice[] = [];
  const service = new FleetService(db, {
    configPath, now: () => now,
    every: () => ({ stop() { /* ticks are called directly */ } }),
    run: async (_program, _args, stdin) => { notices.push(JSON.parse(stdin) as FleetNotice); return { code: 0, error: null }; },
  });
  t.after(() => { service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const advance = (minutes: number) => { now = new Date(Date.parse(T) + minutes * MIN); };
  return { db, service, notices, advance };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test("an incident notice carries the full explanation built from the private component note", async (t) => {
  const app = setup(t);
  await app.service.accept([packet()]);
  await drain();
  assert.equal(app.notices.length, 1);
  const notice = app.notices[0]!;
  assert.equal(notice.kind, "incident");
  assert.equal(notice.title, "critical: gamemaster email-reply-watcher");
  const labels = notice.body.split("\n").map((line) => line.split(":")[0]);
  assert.deepEqual(labels, ["What happened", "What it is", "Real or false alarm", "How often", "Owner", "Next step"]);
  assert.match(notice.body, /Next step: Check the service log on gamemaster\./);
  assert.match(notice.body, /Owner: Mail\./);
});

test("a critical recovery sends a recovered notice only after the configured clean checks", async (t) => {
  const app = setup(t, { policy: { resolveAfterCleanChecks: 2 } });
  await app.service.accept([packet()]);
  await app.service.accept([packet({ recovered: true })]);
  await drain();
  assert.deepEqual(app.notices.map((notice) => notice.kind), ["incident"]);
  assert.equal(app.service.incidents({})[0]?.state, "open");
  await app.service.accept([packet({ recovered: true })]);
  await drain();
  assert.deepEqual(app.notices.map((notice) => notice.kind), ["incident", "recovered"]);
  assert.match(app.notices[1]!.body, /recovered after 2 clean checks in a row/);
});

test("a warning that recovers sends no notice and appears in the next digest marked recovered", async (t) => {
  const app = setup(t, { policy: { resolveAfterCleanChecks: 1 } });
  await app.service.accept([packet({ severity: "warning", failureClass: "ran-failed", summary: "backup failed" })]);
  await app.service.accept([packet({ severity: "warning", failureClass: "ran-failed", summary: "backup failed", recovered: true })]);
  await drain();
  assert.equal(app.notices.length, 0);
  app.advance(30);
  app.service.tick();
  await drain();
  assert.deepEqual(app.notices.map((notice) => notice.kind), ["digest"]);
  assert.match(app.notices[0]!.body, /- email-reply-watcher: backup failed \(recovered\)/);
});

test("past the daily cap one capped notice goes out with the muted line, and the digest still lists the incident", async (t) => {
  const app = setup(t, { policy: { resolveAfterCleanChecks: 1, maxNoticesPerDay: 2, flapReopens: 100 } });
  for (let cycle = 0; cycle < 4; cycle++) {
    await app.service.accept([packet()]);
    await app.service.accept([packet({ recovered: true })]);
  }
  await drain();
  assert.deepEqual(app.notices.map((notice) => notice.kind), ["incident", "recovered", "capped"]);
  const capped = app.notices[2]!;
  assert.equal(capped.title, "capped: gamemaster email-reply-watcher");
  assert.equal(capped.body.split("\n").at(-1), "Still open, 2 times in the last 24 hours. It is muted until tomorrow, and the next digest still lists it.");
  app.advance(30);
  app.service.tick();
  await drain();
  assert.equal(app.notices.at(-1)?.kind, "digest");
  assert.match(app.notices.at(-1)!.body, /email-reply-watcher/);
});
