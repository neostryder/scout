import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE_CLASSES, FALSE_ALARMS, SEVERITY_FOR_CLASS, defaultSeverity, fingerprint, isFalseAlarm, parsePacket, type IncidentPacket } from "../src/index.ts";

const AT = "2026-10-31T18:00:00.000Z";

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "desktop";
  const component = overrides.component ?? "backup";
  const failureClass = overrides.failureClass ?? "ran-failed";
  return {
    version: 1,
    host,
    component,
    severity: overrides.severity ?? "warning",
    failureClass,
    firstSeen: AT,
    lastSeen: AT,
    count: 1,
    fingerprint: overrides.fingerprint ?? fingerprint(host, component, failureClass),
    summary: "backup failed",
    evidence: {},
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
    ...overrides,
  };
}

test("failure classes and severities are the fleet set", () => {
  assert.deepEqual(FAILURE_CLASSES, ["dead", "wedged", "never-ran", "ran-failed", "degraded-output", "slow-or-timeout", "resources", "credentials-quota", "network-path", "ai-agent", "watcher-failure", "alert-quality"]);
  assert.equal(SEVERITY_FOR_CLASS.dead, "critical");
  assert.equal(SEVERITY_FOR_CLASS.wedged, "critical");
  assert.equal(SEVERITY_FOR_CLASS.resources, "critical");
  assert.equal(SEVERITY_FOR_CLASS["alert-quality"], "info");
  assert.equal(SEVERITY_FOR_CLASS["ran-failed"], "warning");
  assert.equal(defaultSeverity("dead"), "critical");
  assert.equal(defaultSeverity("ran-failed", { dataAtRisk: true }), "critical");
  assert.equal(defaultSeverity("ran-failed", { severity: "info" }), "info");
});

test("fingerprint ignores pid and timestamp shape and keeps host case folded only", () => {
  const left = fingerprint("Desktop", "Backup", "ran-failed", "pid 1234 at 2026-10-31T01:02:03Z");
  const right = fingerprint("desktop", "backup", "ran-failed", "pid 9999 at 1999-01-01T00:00:00Z");
  assert.equal(left, right);
  assert.equal(left.length, 16);
  assert.notEqual(left, fingerprint("desktop", "backup", "ran-failed"));
  assert.equal(fingerprint("desktop", "backup", "ran-failed", "pid deadbeef"), fingerprint("desktop", "backup", "ran-failed", "pid cafebabe"));
  assert.notEqual(fingerprint("desktop", "backup", "ran-failed", "pid 5"), fingerprint("desktop", "backup", "ran-failed", "pid 9"));
});

test("parsePacket rejects unknown class, severity, version and fields", () => {
  const good = packet();
  assert.equal(parsePacket(good).ok, true);
  assert.equal(parsePacket({ ...good, failureClass: "nope" }).ok, false);
  assert.equal(parsePacket({ ...good, severity: "high" }).ok, false);
  assert.equal(parsePacket({ ...good, version: "1" }).ok, false);
  assert.equal(parsePacket({ ...good, extra: true }).ok, false);
  assert.equal(parsePacket(null).ok, false);
  assert.equal(parsePacket({ ...good, fingerprint: "abcd" }).ok, false);
  const long = parsePacket({ ...good, summary: "x".repeat(301) });
  assert.equal(long.ok && long.packet.summary.length, 300);
  const tail = parsePacket({ ...good, evidence: { stderrTail: "y".repeat(4001), recentChanges: ["z".repeat(301)] } });
  assert.equal(tail.ok && tail.packet.evidence.stderrTail?.length, 4000);
  assert.equal(tail.ok && tail.packet.evidence.recentChanges?.[0]?.length, 300);
});

test("false alarms match the scheduler and launchd cases", () => {
  assert.equal(FALSE_ALARMS.length, 4);
  const running = packet({ evidence: { snapshot: { taskResult: 267009 } } });
  assert.equal(isFalseAlarm(running), true);
  assert.equal(isFalseAlarm(packet({ evidence: { snapshot: { taskResult: "0x41301" } } })), true);
  assert.equal(isFalseAlarm(packet({ component: "minute-watchdog", evidence: { snapshot: { taskResult: 2147946720 } } })), true);
  assert.equal(isFalseAlarm(packet({ component: "backup", evidence: { snapshot: { taskResult: 2147946720 } } })), false);
  assert.equal(isFalseAlarm(packet({ component: "backup", evidence: { snapshot: { taskResult: 2147946720, running: true } } })), true);
  assert.equal(isFalseAlarm(packet({ evidence: { snapshot: { launchdStatus: -9, running: true } } })), true);
  assert.equal(isFalseAlarm(packet({ evidence: { snapshot: { launchdStatus: "-15", running: "true" } } })), true);
  assert.equal(isFalseAlarm(packet({ evidence: { snapshot: { launchdStatus: -9, running: false } } })), false);
  assert.equal(isFalseAlarm(packet()), false);
});
