import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgeAlerts, alertsResponse, backupAlert, backupAlertState, backupNotice, defaultBackupHealthSettings, evaluateAlerts, openCatalog, parseBackupHealthSettings, readBackupHealth, upsertMachine, type BackupReading } from "@scout/core";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const doc = (overrides: Record<string, unknown> = {}, updatedMinutesAgo = 1) => JSON.stringify({
  level: "ok", reasons: [], last_success: iso(120), hours_since_success: 2, destination_present: true, destination_absent_hours: 0, open_warnings: 0, open_errors: 0, updated: iso(updatedMinutesAgo), ...overrides,
});
const reading = (text: string | null, mtimeMinutesAgo = 1): BackupReading => readBackupHealth(defaultBackupHealthSettings(), NOW, () => text === null ? null : { text, mtimeMs: NOW - mtimeMinutesAgo * 60_000 });
const critical = doc({ level: "critical", hours_since_success: 40, reasons: [{ kind: "backup_stale", level: "critical", message: "No complete pass in 40 hours." }, { kind: "open_warnings", level: "warn", message: "One warning is open." }] });

test("a missing health file means the backup is not installed and never alerts", () => {
  const result = reading(null);
  assert.equal(result.state, "not-installed");
  assert.equal(backupAlertState(result), "clear");
  assert.equal(backupAlert(result, "Eru"), null);
});

test("ok and warn readings clear the alert, and only critical raises it", () => {
  assert.equal(backupAlertState(reading(doc())), "clear");
  assert.equal(backupAlertState(reading(doc({ level: "warn", reasons: [{ kind: "open_warnings", level: "warn", message: "One warning is open." }] }))), "clear");
  const result = reading(critical);
  assert.equal(backupAlertState(result), "alert");
  const alert = backupAlert(result, "Eru")!;
  assert.equal(alert.severity, "high");
  assert.equal(alert.title, "Backup is critical on Eru");
  assert.equal(alert.detail, "No complete pass in 40 hours. The last complete pass was 40 hours ago.");
});

test("an updated stamp older than the limit means the daemon is down, whatever level the file still shows", () => {
  const result = reading(doc({}, 4));
  assert.equal(result.state, "daemon-down");
  assert.equal(backupAlertState(result), "alert");
  const alert = backupAlert(result, "Eru")!;
  assert.equal(alert.severity, "high");
  assert.match(alert.detail, /has not been rewritten for 3 minutes/);
  assert.equal(reading(doc({}, 2.5)).state, "ok");
});

test("an unreadable file is unknown while it is fresh and a stopped daemon once nobody has touched it", () => {
  assert.equal(reading("{ half a documen", 0.5).state, "unknown");
  assert.equal(backupAlertState(reading("{ half a documen", 0.5)), "hold");
  assert.equal(reading("{ half a documen", 10).state, "daemon-down");
  assert.equal(reading(JSON.stringify({ level: "fine", updated: iso(0) }), 0.5).state, "unknown");
  assert.equal(reading(JSON.stringify([]), 0.5).state, "unknown");
});

test("text from the file is trimmed of control characters and capped", () => {
  const result = reading(doc({ level: "critical", reasons: [{ kind: "x", level: "critical", message: `bad\u0007 ${"y".repeat(500)}` }] }));
  assert.equal(result.state, "critical");
  assert.ok(backupAlert(result, "Eru")!.detail.startsWith("bad  yyyy"));
  assert.ok(backupAlert(result, "Eru")!.detail.length < 360);
});

test("a critical reading with no critical reason still says something", () => {
  assert.match(backupAlert(reading(doc({ level: "critical" })), "Eru")!.detail, /^The backup reports a critical problem\./);
});

test("notices go out when the alert is raised and when it clears, and never for a hold", () => {
  const bad = reading(critical);
  assert.equal(backupNotice("clear", "alert", bad, "Eru")!.severity, "high");
  assert.equal(backupNotice("alert", "alert", bad, "Eru"), null);
  assert.equal(backupNotice("clear", "clear", reading(doc()), "Eru"), null);
  assert.equal(backupNotice("alert", "clear", reading(doc()), "Eru")!.title, "Backup is healthy again on Eru");
  assert.equal(backupNotice("alert", "hold", reading("{", 0.5), "Eru"), null);
});

test("the settings file accepts a path and a limit and rejects anything else", () => {
  assert.deepEqual(parseBackupHealthSettings({ path: "D:/b/health.json", staleMinutes: 10 }), { enabled: true, path: "D:/b/health.json", staleMinutes: 10, fileError: null });
  assert.throws(() => parseBackupHealthSettings({ staleMinutes: 0 }), /staleMinutes/);
  assert.throws(() => parseBackupHealthSettings({ extra: 1 }), /unknown field extra/);
  assert.equal(readBackupHealth({ ...defaultBackupHealthSettings(), enabled: false }, NOW, () => ({ text: critical, mtimeMs: NOW })).state, "not-installed");
});

test("the alert is raised once, updates in place, clears on recovery, and a hold keeps it open", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  let current: BackupReading = reading(doc());
  const options = { loadBackup: () => current };
  const T = (n: number) => new Date(NOW + n * 60_000).toISOString();
  const list = () => alertsResponse(db, new URLSearchParams("state=all&kind=backup-unhealthy"), T(9)).alerts;
  assert.deepEqual(evaluateAlerts(db, T(0), options).filter((c) => c.alert.kind === "backup-unhealthy"), []);
  current = reading(critical);
  const raised = evaluateAlerts(db, T(1), options).filter((c) => c.alert.kind === "backup-unhealthy");
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.alert.key, "backup-unhealthy:galadriel");
  assert.equal(raised[0]!.alert.severity, "high");
  assert.equal(raised[0]!.alert.machineName, "Hub");
  assert.equal(evaluateAlerts(db, T(2), options).filter((c) => c.alert.kind === "backup-unhealthy").length, 0);
  current = reading(doc({ level: "critical", hours_since_success: 41, reasons: [{ kind: "backup_stale", level: "critical", message: "No complete pass in 41 hours." }] }));
  assert.equal(evaluateAlerts(db, T(3), options).filter((c) => c.alert.kind === "backup-unhealthy").length, 1);
  assert.equal(list().length, 1);
  assert.match(list()[0]!.detail, /41 hours/);
  current = reading("{", 0.5);
  evaluateAlerts(db, T(4), options);
  assert.equal(list()[0]!.state, "open");
  assert.equal(acknowledgeAlerts(db, { all: true, kind: "backup-unhealthy" }, T(5))!.length, 1);
  assert.equal(list()[0]!.state, "acknowledged");
  current = reading(doc({}, 5));
  assert.equal(evaluateAlerts(db, T(6), options).filter((c) => c.alert.kind === "backup-unhealthy").length, 1);
  assert.equal(list()[0]!.state, "acknowledged");
  assert.match(list()[0]!.title, /Backup service is not running/);
  current = reading(doc());
  const cleared = evaluateAlerts(db, T(7), options).filter((c) => c.alert.kind === "backup-unhealthy");
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.change, "resolved");
  assert.equal(list()[0]!.state, "resolved");
  current = reading(critical);
  evaluateAlerts(db, T(8), options);
  assert.equal(list().length, 2);
});

test("without a backup reader no backup alert is raised", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  assert.deepEqual(evaluateAlerts(db, new Date(NOW).toISOString()).filter((c) => c.alert.kind === "backup-unhealthy"), []);
});
