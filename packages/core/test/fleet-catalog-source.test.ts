import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CATALOG_SCOPE, FALSE_ALARMS, catalogPackets, fingerprint, isFalseAlarm, parsePacket, reconcileCatalog, type CatalogServiceRow } from "../src/index.ts";

const T = "2026-10-31T18:00:00.000Z";
const row: CatalogServiceRow = { machine: "desktop", kind: "scheduled-task", name: "\\Backup", state: "stopped", startMode: null, enabled: true, lastRun: "2026-10-31T17:59:00.000Z", lastResult: "1", keepAlive: null, lastSeenAt: T };

test("a failed root task carries catalog evidence and a warning", () => {
  const packets = catalogPackets([row], DEFAULT_CATALOG_SCOPE, T);
  assert.equal(packets.length, 1);
  const item = packets[0]!;
  assert.equal(item.host, "desktop");
  assert.equal(item.component, "Backup");
  assert.equal(item.failureClass, "ran-failed");
  assert.equal(item.severity, "warning");
  assert.equal(item.fingerprint, fingerprint("desktop", "Backup", "ran-failed"));
  assert.equal(item.firstSeen, T);
  assert.equal(item.lastSeen, T);
  assert.equal(item.count, 1);
  assert.deepEqual(item.redaction, { applied: false, rules: [] });
  assert.equal(item.ownerChat, null);
  assert.equal(item.runbook, null);
  assert.deepEqual(item.evidence, { exitCode: 1, snapshot: { taskResult: "1", lastRun: row.lastRun, state: "stopped", running: false, kind: "scheduled-task" } });
  assert.equal(parsePacket(item).ok, true);
  assert.ok(item.summary.length < 300);
});

test("success and benign Task Scheduler results do not become failures", () => {
  for (const lastResult of ["0", "267009", "267010", "267014", "267011", "0x41301", null, "", "invalid", "0x1oops"]) {
    assert.deepEqual(catalogPackets([{ ...row, lastResult }], DEFAULT_CATALOG_SCOPE, T), [], String(lastResult));
  }
});

test("folder tasks and vendor updaters are outside the default task scope", () => {
  for (const name of ["\\Microsoft\\Windows\\Backup", "\\Folder\\Backup", "\\BraveUpdate", "GoogleUpdate", "Adobe Acrobat Update Task", "CCleaner Update", "Driver Easy Scheduled Scan", "OneDrive Update", "MicrosoftEdgeUpdateTaskMachine"]) {
    assert.deepEqual(catalogPackets([{ ...row, name }], DEFAULT_CATALOG_SCOPE, T), [], name);
  }
});

test("matching never-run tasks carry a warning and catalog evidence", () => {
  const scope = { ...DEFAULT_CATALOG_SCOPE, neverRan: [/^backup$/i] };
  for (const lastResult of ["267011", "0x41303"]) {
    const packets = catalogPackets([{ ...row, lastResult, lastRun: null }], scope, T);
    assert.equal(packets.length, 1);
    const item = packets[0]!;
    assert.equal(item.component, "Backup");
    assert.equal(item.failureClass, "never-ran");
    assert.equal(item.severity, "warning");
    assert.equal(item.summary, "task has never run");
    assert.equal(item.fingerprint, fingerprint("desktop", "Backup", "never-ran"));
    assert.deepEqual(item.evidence, { snapshot: { taskResult: lastResult, lastRun: null, state: "stopped", running: false, kind: "scheduled-task" } });
    assert.equal(parsePacket(item).ok, true);
  }
});

test("never-run tasks stay silent without a match or outside the enabled fresh task scope", () => {
  const task = { ...row, lastResult: "267011", lastRun: null };
  const scope = { ...DEFAULT_CATALOG_SCOPE, neverRan: [/^backup$/i] };
  assert.deepEqual(catalogPackets([task], DEFAULT_CATALOG_SCOPE, T), []);
  assert.deepEqual(catalogPackets([{ ...task, name: "\\Other" }], scope, T), []);
  assert.deepEqual(catalogPackets([{ ...task, enabled: false }], scope, T), []);
  assert.deepEqual(catalogPackets([{ ...task, lastSeenAt: "2026-10-31T17:29:59.999Z" }], scope, T), []);
  assert.equal(catalogPackets([{ ...task, lastSeenAt: "2026-10-31T17:30:00.000Z" }], scope, T).length, 1);
  assert.deepEqual(catalogPackets([task], { ...scope, tasks: { include: [], exclude: [] } }, T), []);
  assert.deepEqual(catalogPackets([task], { ...scope, tasks: { include: [/backup/i], exclude: [/backup/i] } }, T), []);
});

test("Task Scheduler refusals while running and minute watchdog refusals are false alarms", () => {
  const alarm = FALSE_ALARMS.find((item) => item.id === "task-found-running");
  assert.ok(alarm);
  for (const lastResult of ["2147946720", "0x800710E0"]) {
    assert.deepEqual(catalogPackets([{ ...row, name: "\\Cogitator", lastResult, state: "running" }], DEFAULT_CATALOG_SCOPE, T), []);
    assert.deepEqual(catalogPackets([{ ...row, name: "\\minute-watchdog", lastResult }], DEFAULT_CATALOG_SCOPE, T), []);
    const item = catalogPackets([{ ...row, name: "\\Cogitator", lastResult }], DEFAULT_CATALOG_SCOPE, T)[0]!;
    assert.equal(item.evidence.exitCode, 2147946720);
    assert.equal(isFalseAlarm(item), false);
    assert.equal(alarm.matches({ ...item, evidence: { ...item.evidence, snapshot: { ...item.evidence.snapshot, running: true } } }), true);
  }
});

test("hex results decode and unsafe integers stay in the snapshot", () => {
  const hex = catalogPackets([{ ...row, lastResult: "0x10" }], DEFAULT_CATALOG_SCOPE, T)[0]!;
  assert.equal(hex.evidence.exitCode, 16);
  const large = catalogPackets([{ ...row, lastResult: "9007199254740993" }], DEFAULT_CATALOG_SCOPE, T)[0]!;
  assert.equal(large.evidence.exitCode, undefined);
  assert.equal(large.evidence.snapshot?.taskResult, "9007199254740993");
  assert.equal(parsePacket(large).ok, true);
});

test("a stopped keep-alive launchd job becomes critical and dead", () => {
  const item = catalogPackets([{ ...row, kind: "launchd", name: "org.example.agent", keepAlive: true }], DEFAULT_CATALOG_SCOPE, T)[0]!;
  assert.equal(item.failureClass, "dead");
  assert.equal(item.severity, "critical");
  assert.equal(item.summary, "keep-alive job is not running");
  assert.deepEqual(item.evidence.snapshot, { launchdStatus: "1", state: "stopped", running: false, kind: "launchd" });
});

test("launchd reports failed non-keep-alive jobs and skips running jobs, stop signals, and excluded labels", () => {
  const job = { ...row, kind: "launchd", name: "org.example.job", keepAlive: false };
  assert.equal(catalogPackets([job], DEFAULT_CATALOG_SCOPE, T)[0]?.failureClass, "ran-failed");
  for (const lastResult of ["0", "-9", "-15", null]) {
    assert.deepEqual(catalogPackets([{ ...job, lastResult }], DEFAULT_CATALOG_SCOPE, T), []);
    assert.deepEqual(catalogPackets([{ ...job, lastResult, state: "running" }], DEFAULT_CATALOG_SCOPE, T), []);
  }
  assert.deepEqual(catalogPackets([{ ...job, state: "running" }], DEFAULT_CATALOG_SCOPE, T), []);
  for (const name of ["com.apple.job", "application.job", "gui/501/job", "user/501/job"]) {
    assert.deepEqual(catalogPackets([{ ...job, name, keepAlive: true }], DEFAULT_CATALOG_SCOPE, T), []);
  }
});

test("stale scans and disabled rows produce no packets", () => {
  assert.deepEqual(catalogPackets([{ ...row, lastSeenAt: "2026-10-31T17:29:59.999Z" }], DEFAULT_CATALOG_SCOPE, T), []);
  assert.equal(catalogPackets([{ ...row, lastSeenAt: "2026-10-31T17:30:00.000Z" }], DEFAULT_CATALOG_SCOPE, T).length, 1);
  assert.deepEqual(catalogPackets([{ ...row, enabled: false }], DEFAULT_CATALOG_SCOPE, T), []);
  assert.deepEqual(catalogPackets([{ ...row, lastSeenAt: "invalid" }], DEFAULT_CATALOG_SCOPE, T), []);
  assert.deepEqual(catalogPackets([row], DEFAULT_CATALOG_SCOPE, "invalid"), []);
});

test("systemd and Windows services require explicit scope and the matching startup mode", () => {
  const unit = { ...row, kind: "systemd", name: "backup.service", startMode: "auto" };
  const service = { ...row, kind: "windows-service", name: "Backup", startMode: "auto" };
  assert.deepEqual(catalogPackets([unit, service], DEFAULT_CATALOG_SCOPE, T), []);
  const scope = { ...DEFAULT_CATALOG_SCOPE, systemd: { include: [/^backup/i], exclude: [] }, windowsServices: { include: [/^backup$/i] } };
  assert.deepEqual(catalogPackets([unit, service], scope, T).map((item) => item.failureClass), ["dead", "dead"]);
  assert.equal(catalogPackets([{ ...unit, state: "other" }], scope, T).length, 1);
  assert.deepEqual(catalogPackets([{ ...unit, startMode: "disabled" }, { ...service, startMode: "manual" }, { ...unit, state: "running" }, { ...service, enabled: false }], scope, T), []);
  assert.deepEqual(catalogPackets([unit], { ...scope, systemd: { include: [/backup/], exclude: [/backup/] } }, T), []);
});

test("custom scope replaces defaults without mutating regular expression state", () => {
  const include = /folder\\backup/gi;
  include.lastIndex = 10;
  const scope = { ...DEFAULT_CATALOG_SCOPE, tasks: { include: [include], exclude: [] }, staleScanMinutes: 1 };
  const task = { ...row, name: "\\Folder\\Backup" };
  assert.equal(catalogPackets([task], scope, T).length, 1);
  assert.equal(catalogPackets([task], scope, T).length, 1);
  assert.equal(include.lastIndex, 10);
  assert.deepEqual(catalogPackets([{ ...task, lastSeenAt: "2026-10-31T17:58:59.999Z" }], scope, T), []);
});

test("fingerprints stay stable when result codes change and current packets refresh", () => {
  const first = catalogPackets([row], DEFAULT_CATALOG_SCOPE, T);
  const later = "2026-10-31T18:01:00.000Z";
  const current = catalogPackets([{ ...row, lastResult: "2" }], DEFAULT_CATALOG_SCOPE, later);
  assert.equal(first[0]?.fingerprint, current[0]?.fingerprint);
  const previous = reconcileCatalog(new Map(), first, T).next;
  const result = reconcileCatalog(previous, current, later);
  assert.deepEqual(result.send, current);
  assert.equal(result.next.size, 1);
  assert.equal(result.send[0]?.lastSeen, later);
});

test("reconciliation sends recovery once and never recovers an unreported failure", () => {
  const failures = catalogPackets([row], DEFAULT_CATALOG_SCOPE, T);
  const first = reconcileCatalog(new Map(), failures, T);
  assert.deepEqual(first.send, failures);
  const now = "2026-10-31T18:01:00.000Z";
  const recovery = reconcileCatalog(first.next, [], now);
  assert.deepEqual(recovery.send, [{ ...failures[0], recovered: true, lastSeen: now, summary: "recovered" }]);
  assert.equal(recovery.next.size, 0);
  assert.equal(first.next.size, 1);
  assert.equal(failures[0]?.recovered, undefined);
  assert.deepEqual(reconcileCatalog(recovery.next, [], now).send, []);
  assert.deepEqual(reconcileCatalog(new Map(), [], now).send, []);
});
