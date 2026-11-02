import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE_CLASSES as CORE_CLASSES } from "../../core/src/fleet-packet.ts";

const { FAILURE_CLASSES, INCIDENT_PARAMS, incidentFilters, incidentCounts, filterIncidents, sortIncidents, relativeTime, packetSections, snoozeMinutes, investigationSummary, investigationActor, hasRunningInvestigation } = await import(new URL("../public/incidents-model.js", import.meta.url).href);
const now = Date.parse("2026-11-01T12:00:00Z");
const incident = (overrides: Record<string, unknown> = {}) => ({ id: 1, host: "eru", component: "backup", summary: "Worker stopped", state: "open", severity: "critical", failureClass: "dead", acknowledgedAt: null, muted: false, snoozedUntil: null, lastSeen: "2026-11-01T11:00:00Z", ...overrides });

test("incident classes match the core packet contract and filters read their own URL parameters", () => {
  assert.deepEqual(FAILURE_CLASSES, [...CORE_CLASSES]);
  assert.deepEqual(incidentFilters(new URLSearchParams("state=resolved&host=bilbo&q=other")), { state: "active", host: "", failureClass: "", q: "" });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ state: "resolved", host: "bilbo", failureClass: "network-path", q: "sync error" })) params.set(INCIDENT_PARAMS[key], value);
  assert.deepEqual(incidentFilters(params), { state: "resolved", host: "bilbo", failureClass: "network-path", q: "sync error" });
  assert.equal(incidentFilters(new URLSearchParams("incidentState=invalid")).state, "active");
});

test("incident counts separate loaded states from incidents that need attention", () => {
  const rows = [incident(), incident({ host: "bilbo", state: "acknowledged" }), incident({ state: "resolved" }), incident({ muted: true }), incident({ snoozedUntil: "2026-11-01T13:00:00Z" }), incident({ acknowledgedAt: "2026-11-01T11:00:00Z" }), incident({ severity: "warning", snoozedUntil: "2026-11-01T12:00:00Z" })];
  assert.deepEqual(incidentCounts(rows, now), { open: 5, acknowledged: 1, resolved: 1, critical: 4, attention: 2, hosts: { eru: 5, bilbo: 0 } });
  assert.equal(incidentCounts([], now).attention, 0);
  assert.equal(incidentCounts([incident({ snoozedUntil: "invalid" })], now).attention, 1);
  assert.equal(incidentCounts([incident({ host: "__proto__" })], now).hosts.__proto__, 1);
});

test("incident filters combine state, host, class, and component and summary search", () => {
  const rows = [incident(), incident({ id: 2, state: "acknowledged", component: "nightly-backup", host: "bilbo" }), incident({ id: 3, state: "resolved", failureClass: "network-path", component: "sync" })];
  const ids = (filters: Record<string, string>) => filterIncidents(rows, filters).map((row: any) => row.id);
  assert.deepEqual(ids({}), [1, 2]);
  assert.deepEqual(ids({ state: "all" }), [1, 2, 3]);
  assert.deepEqual(ids({ state: "resolved" }), [3]);
  assert.deepEqual(ids({ host: "bilbo", failureClass: "dead", q: "BACKUP stopped" }), [2]);
  assert.deepEqual(ids({ q: "eru" }), []);
  assert.deepEqual(ids({ failureClass: "network-path" }), []);
  assert.deepEqual(ids({ state: "all", failureClass: "network-path" }), [3]);
});

test("open critical incidents sort first, then last seen descending without changing the input", () => {
  const rows = [incident({ id: 1, severity: "warning", lastSeen: "2026-11-01T11:50:00Z" }), incident({ id: 2 }), incident({ id: 3, lastSeen: "2026-11-01T11:20:00Z" }), incident({ id: 4, state: "acknowledged", lastSeen: "2026-11-01T11:55:00Z" }), incident({ id: 5, state: "resolved" })];
  assert.deepEqual(sortIncidents(rows).map((row: any) => row.id), [3, 2, 4, 1, 5]);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3, 4, 5]);
});

test("relative incident times cover boundaries, future times, and invalid input", () => {
  const time = (seconds: number) => relativeTime(new Date(now - seconds * 1000).toISOString(), now);
  assert.deepEqual([-60, 0, 59, 60, 3599, 3600, 86399, 86400, 172800].map(time), ["Just now", "Just now", "Just now", "1 min ago", "59 min ago", "1 h ago", "23 h ago", "1 d ago", "2 d ago"]);
  assert.equal(relativeTime("invalid", now), "Unknown");
});

test("evidence sections order known tails before other keys and cap plain text", () => {
  const sections = packetSections({ evidence: { snapshot: { healthy: false }, stderrTail: "<script>alert(1)</script>", recentChanges: ["updated", "restarted"], journalTail: "journal", exitCode: 0, other: "x".repeat(9000) } });
  assert.deepEqual(sections.map((section: any) => section.key), ["journalTail", "stderrTail", "recentChanges", "exitCode", "other", "snapshot"]);
  assert.equal(sections[1].text, "<script>alert(1)</script>");
  assert.equal(sections[2].text, "updated\nrestarted");
  assert.equal(sections[3].text, "0");
  assert.equal(sections[4].text.length, 8000);
  assert.ok(sections[4].text.endsWith("..."));
  assert.match(sections[5].text, /"healthy": false/);
  assert.equal(packetSections({ evidence: { stderrTail: "x".repeat(30) } }, 20)[0].text.length, 20);
  assert.deepEqual(packetSections(null), []);
});

test("snooze choices send minutes and reject unsupported durations", () => {
  assert.deepEqual(["1", "4", "24", 1, "2", "", null, "toString"].map(snoozeMinutes), [60, 240, 1440, 60, null, null, null, null]);
});

test("investigation summaries describe running, finished, and failed investigations", () => {
  assert.equal(investigationSummary(null), null);
  assert.equal(investigationSummary({ status: "running", startedAt: "2026-11-01T11:55:00Z" }, now), "Investigating since 5 min ago.");
  assert.equal(investigationSummary({ status: "done", finishedAt: "2026-11-01T11:58:00Z", rounds: 2, costUsd: 0.0374 }, now), "Finished 2 min ago, 2 analyst calls, cost $0.0374.");
  assert.equal(investigationSummary({ status: "incomplete", finishedAt: "2026-11-01T11:58:00Z", rounds: 1, costUsd: 1 }, now), "Finished 2 min ago, 1 analyst call, cost $1.0000.");
  assert.equal(investigationSummary({ status: "done" }, now), "Finished Unknown, 0 analyst calls, cost $0.0000.");
  assert.equal(investigationSummary({ status: "failed", error: "The analyst tool timed out." }, now), "The analyst tool timed out.");
  assert.equal(investigationSummary({ status: "failed" }, now), "The investigation failed.");
  assert.equal(investigationActor({ actor: "operations" }), "Asked by operations");
  assert.equal(investigationActor({ actor: "" }), "");
  assert.equal(investigationActor(null), "");
});

test("running investigations are found in a details collection", () => {
  assert.equal(hasRunningInvestigation([]), false);
  assert.equal(hasRunningInvestigation(null), false);
  assert.equal(hasRunningInvestigation([{ investigation: null }]), false);
  assert.equal(hasRunningInvestigation([{ investigation: { status: "done" } }]), false);
  assert.equal(hasRunningInvestigation([{ investigation: { status: "done" } }, { investigation: { status: "running" } }]), true);
  assert.equal(hasRunningInvestigation(new Map([[1, { investigation: { status: "running" } }]])), true);
  assert.equal(hasRunningInvestigation(new Map([[1, { investigation: { status: "done" } }]])), false);
});
