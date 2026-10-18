import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsResponse, defaultBackupHealthSettings, openCatalog, readBackupHealth, upsertMachine, type BackupReading, type OutageNotice } from "@scout/core";
import { HubAlerts } from "../src/alerts.ts";
import { HubBackupWatch } from "../src/backup-watch.ts";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const read = (level: string, minutesAgo = 1, reasons: unknown[] = []): BackupReading => readBackupHealth(defaultBackupHealthSettings(), NOW, () => ({ text: JSON.stringify({ level, reasons, hours_since_success: 40, updated: new Date(NOW - minutesAgo * 60_000).toISOString() }), mtimeMs: NOW }));
const reasons = [{ kind: "backup_stale", level: "critical", message: "No complete pass in 40 hours." }];

function setup(t: { after: (fn: () => void) => void }) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  let current: BackupReading = read("ok");
  const sent: OutageNotice[] = [];
  const read_ = () => current;
  const alerts = new HubAlerts(db, { loadBackup: read_ });
  const watch = new HubBackupWatch(alerts, { read: read_, notifier: { send: async (notice) => { sent.push(notice); return []; } }, machineName: () => "Eru", now: () => new Date(NOW), log: () => undefined });
  const open = () => alertsResponse(db, new URLSearchParams("kind=backup-unhealthy")).alerts;
  return { watch, sent, open, set: (reading: BackupReading) => { current = reading; } };
}

test("the watch raises one alert and one notice when the backup turns critical, and clears both when it recovers", async (t) => {
  const { watch, sent, open, set } = setup(t);
  await watch.check();
  assert.equal(open().length, 0);
  assert.equal(sent.length, 0);
  set(read("critical", 1, reasons));
  await watch.check();
  await watch.check();
  assert.equal(open().length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.title, "Backup is critical on Eru");
  set(read("ok"));
  await watch.check();
  assert.equal(open().length, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.title, "Backup is healthy again on Eru");
});

test("an unreadable file raises and clears nothing, and a stopped daemon alerts", async (t) => {
  const { watch, sent, open, set } = setup(t);
  set(read("critical", 1, reasons));
  await watch.check();
  set({ state: "unknown", message: "partial write" });
  await watch.check();
  assert.equal(open().length, 1);
  assert.equal(sent.length, 1);
  set(read("ok", 6));
  await watch.check();
  assert.match(open()[0]!.title, /Backup service is not running/);
  assert.equal(sent.length, 1);
});

test("a hub that starts with the backup already critical sends the notice once", async (t) => {
  const { watch, sent, open, set } = setup(t);
  set(read("critical", 1, reasons));
  await watch.check();
  assert.equal(open().length, 1);
  assert.equal(sent.length, 1);
});

test("a missing file is not an alert", async (t) => {
  const { watch, sent, open, set } = setup(t);
  set({ state: "not-installed" });
  await watch.check();
  assert.equal(open().length, 0);
  assert.equal(sent.length, 0);
});
