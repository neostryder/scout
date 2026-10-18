import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The panel's model is plain JavaScript with no declaration file.
import { actionOutcome, applyRule, connectAfterSnapshot, contextEntries, fill, needsConfirm, pickTab, planBody, rowActions, sparkRuns, tabs, totals, visibleRows } from "../ui/model.js";

const row = (over: Record<string, unknown> = {}) => ({ key: "service:eru:x", target: "service", id: 7, name: "x", label: "X", machineId: "eru", kind: "windows-service", vendor: "other", state: "up", port: null, detail: null, mine: false, pinned: false, actions: [{ action: "start", available: false }, { action: "stop", available: true }, { action: "restart", available: true }], ...over });
const snapshot = () => ({ machines: [
  { id: "bilbo", name: "Bilbo", worst: "up", counts: { up: 2, changed: 0, down: 0, stopped: 0, unknown: 0 }, hidden: 1, rows: [] },
  { id: "stacks", name: "Stacks", worst: "changed", counts: { up: 0, changed: 1, down: 0, stopped: 0, unknown: 0 }, hidden: 0, rows: [] },
  { id: "eru", name: "Eru", worst: "down", counts: { up: 1, changed: 0, down: 2, stopped: 0, unknown: 0 }, hidden: 2, rows: [] },
] });

test("fill replaces named placeholders and leaves unknown ones visible", () => {
  assert.equal(fill("Stop {name}? {n} left", { name: "Redis", n: 3 }), "Stop Redis? 3 left");
  assert.equal(fill("{missing}", {}), "{missing}");
});

test("tabs put Stacks last, and the first tab shown is the one that needs a look", () => {
  assert.deepEqual(tabs(snapshot()).map((m: { id: string }) => m.id), ["bilbo", "eru", "stacks"]);
  assert.equal(pickTab(snapshot(), null), "eru");
  assert.equal(pickTab(snapshot(), "bilbo"), "bilbo");
  assert.equal(pickTab(snapshot(), "gone"), "eru");
  assert.deepEqual(totals(snapshot()), { down: 2, changed: 1 });
});

test("the first tab shown is this computer's own, whatever its state", () => {
  assert.equal(pickTab(snapshot(), null, "bilbo"), "bilbo");
  assert.equal(pickTab(snapshot(), null, " Eru "), "eru");
  assert.equal(pickTab(snapshot(), "eru", "bilbo"), "eru");
  assert.equal(pickTab(snapshot(), null, "stacks"), "eru");
  assert.equal(pickTab(snapshot(), null, "nobody"), "eru");
  assert.equal(pickTab(snapshot(), null, ""), "eru");
});

test("search and chips narrow the rows", () => {
  const machine = { rows: [row({ label: "Redis", state: "down" }), row({ label: "Nginx", mine: true }), row({ label: "Dev server", state: "changed", port: 3000 })] };
  assert.equal(visibleRows(machine, { query: "red" }).length, 1);
  assert.equal(visibleRows(machine, { query: "3000" }).length, 1);
  assert.deepEqual(visibleRows(machine, { chip: "down" }).map((r: { label: string }) => r.label), ["Redis", "Dev server"]);
  assert.deepEqual(visibleRows(machine, { chip: "mine" }).map((r: { label: string }) => r.label), ["Nginx"]);
});

test("a running row offers Restart and Stop, a stopped one offers Start, and availability comes from the hub", () => {
  assert.deepEqual(rowActions(row()).map((a: { action: string }) => a.action), ["restart", "stop"]);
  assert.deepEqual(rowActions(row({ state: "stopped" })).map((a: { action: string }) => a.action), ["start"]);
  const protectedRow = row({ actions: [{ action: "stop", available: false, reason: "Protected" }, { action: "restart", available: false, reason: "Protected" }] });
  assert.ok(rowActions(protectedRow).every((a: { available: boolean }) => !a.available));
  assert.equal(needsConfirm("start"), false);
  assert.equal(needsConfirm("stop"), true);
  assert.equal(needsConfirm("restart"), true);
  assert.equal(needsConfirm("disable"), true);
  assert.equal(needsConfirm("enable"), false);
});

test("plan bodies name a stack by name and everything else by id", () => {
  assert.deepEqual(planBody(row(), "stop"), { target: "service", id: 7, action: "stop" });
  assert.deepEqual(planBody(row({ target: "stack", id: null, name: "augur-dev" }), "start"), { target: "stack", name: "augur-dev", action: "start" });
});

test("a missed check breaks the sparkline instead of bridging it", () => {
  assert.deepEqual(sparkRuns(null), []);
  assert.equal(sparkRuns([10, 20, 30, 40]).length, 1);
  assert.equal(sparkRuns([10, 20, null, 30, 40]).length, 2);
  assert.deepEqual(sparkRuns([10, null, 30, null, 50]), []);
});

test("right-click entries and rule changes", () => {
  const entries = contextEntries(row({ vendor: "apple" }));
  assert.deepEqual(entries.map((e: { id: string }) => e.id), ["hide", "hide-kind", "hide-vendor", "pin", "open"]);
  assert.deepEqual(contextEntries(row({ kind: "stack", pinned: true })).map((e: { id: string }) => e.id), ["hide", "unpin", "open"]);
  const empty = { hide: { kinds: [], classes: [], machines: [], vendors: [], names: [] }, pins: [] };
  const hidden = applyRule(empty, { id: "hide", scope: "row" }, row());
  assert.deepEqual(hidden.hide.names, [{ machine: "eru", match: "x" }]);
  assert.deepEqual(applyRule(hidden, { id: "hide", scope: "row" }, row()).hide.names.length, 1);
  assert.deepEqual(applyRule(empty, { id: "hide-kind", scope: "kind", value: "launchd" }, row()).hide.kinds, ["launchd"]);
  const pinned = applyRule(empty, { id: "pin", scope: "pin" }, row());
  assert.deepEqual(pinned.pins, [{ machine: "eru", key: "service:eru:x" }]);
  assert.deepEqual(applyRule(pinned, { id: "unpin", scope: "pin" }, row()).pins, []);
  // Hiding a row removes its pin so the two never fight.
  assert.deepEqual(applyRule(pinned, { id: "hide", scope: "row" }, row()).pins, []);
  assert.deepEqual(empty.pins, []);
});

test("action records map to running, done, and failed", () => {
  assert.equal(actionOutcome(undefined).done, false);
  assert.equal(actionOutcome({ state: "waiting" }).done, false);
  assert.deepEqual(actionOutcome({ state: "done" }), { done: true, ok: true });
  assert.deepEqual(actionOutcome({ state: "failed", message: "It would not stop." }), { done: true, ok: false, reason: "It would not stop." });
  assert.equal(actionOutcome({ state: "expired" }).ok, false);
});

test("the right-click menu offers Disable or Enable first, only when the hub says the row can take it", () => {
  const actions = (disable: boolean, enable: boolean) => [{ action: "start", available: false, reason: null }, { action: "disable", available: disable, reason: null }, { action: "enable", available: enable, reason: null }];
  const ids = (r: Record<string, unknown>) => contextEntries(r).map((e: { id: string }) => e.id);
  assert.deepEqual(ids(row({ actions: actions(true, false) })), ["disable", "hide", "hide-kind", "pin", "open"]);
  assert.deepEqual(ids(row({ actions: actions(false, true) })), ["enable", "hide", "hide-kind", "pin", "open"]);
  assert.deepEqual(ids(row({ actions: actions(false, false) })), ["hide", "hide-kind", "pin", "open"]);
  assert.deepEqual(contextEntries(row({ actions: actions(true, false) }))[0], { id: "disable", scope: "startup", action: "disable" });
  assert.deepEqual(planBody(row(), "disable"), { target: "service", id: 7, action: "disable" });
});

test("every startup string the panel looks up exists", async () => {
  const { readFileSync } = await import("node:fs");
  const text = JSON.parse(readFileSync(new URL("../ui/text.json", import.meta.url), "utf8"));
  for (const key of ["menuDisable", "menuEnable", "confirmDisable", "confirmYesDisable", "workingDisable", "workingEnable", "resultDisabled", "resultEnabled", "failedDisable", "failedEnable"]) assert.equal(typeof text[key], "string", key);
  assert.equal(fill(text.confirmDisable, { name: "Redis" }), "Disable Redis? It stops now and will not start at login until you enable it.");
});

// @ts-expect-error The panel's model is plain JavaScript with no declaration file.
import { meterStrip } from "../ui/model.js";

test("the meter strip lists processor, memory, the busiest disk, and video memory with a tone, and shows nothing without a reading", () => {
  assert.deepEqual(meterStrip(undefined), []);
  assert.deepEqual(meterStrip({ meters: null }), []);
  const strip = meterStrip({ meters: { ageSeconds: 4, cpuPct: 12.4, memPct: 70, diskPct: 90, diskMount: "D:", vramPct: null, netBps: 2048 } });
  assert.deepEqual(strip.map((r: any) => [r.key, r.label, r.value, r.tone, r.pct]), [
    ["cpu", "meterCpu", "12%", "ok", 12.4],
    ["mem", "meterMem", "70%", "warn", 70],
    ["disk", "meterDisk", "90%", "danger", 90],
  ]);
  assert.equal(strip[2].mount, "D:");
  assert.equal(meterStrip({ meters: { ageSeconds: 4, cpuPct: null, memPct: null, diskPct: null, diskMount: null, vramPct: 86, netBps: null } })[0].tone, "danger");
});

test("a meter reading older than 150 seconds is stale", () => {
  assert.equal(meterStrip({ meters: { ageSeconds: 151, cpuPct: 1, memPct: 1, diskPct: null, diskMount: null, vramPct: null, netBps: null } })[0].stale, true);
  assert.equal(meterStrip({ meters: { ageSeconds: 150, cpuPct: 1, memPct: 1, diskPct: null, diskMount: null, vramPct: null, netBps: null } })[0].stale, false);
});

test("the connection screen opens by itself for a missing or refused token and closes once the link works", () => {
  const was = (before: string, after: string, connect: boolean, auto: boolean) => connectAfterSnapshot({ before, after, connect, auto });
  assert.deepEqual(was("unconfigured", "unconfigured", false, false), { connect: true, auto: true });
  assert.deepEqual(was("unconfigured", "ok", true, true), { connect: false, auto: false });
  assert.deepEqual(was("ok", "refused", false, false), { connect: true, auto: true });
  assert.deepEqual(was("refused", "refused", false, false), { connect: false, auto: false });
  assert.deepEqual(was("refused", "ok", true, true), { connect: false, auto: false });
  assert.deepEqual(was("ok", "ok", true, false), { connect: true, auto: false });
  assert.deepEqual(was("unconfigured", "unreachable", true, true), { connect: false, auto: false });
});
