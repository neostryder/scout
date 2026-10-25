import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHub } from "../dev/mock-hub.ts";

const { windowRange, startLabel, quietWindowNote, autoRunNote, itemLine, heldLine, machineGroups, safeNowCount } = await import(new URL("../public/update-window-model.js", import.meta.url).href);

const quiet = (extra = {}) => ({ startMinute: 210, lengthMinutes: 120, startsAt: "2026-10-26T03:30:00", endsAt: "2026-10-26T05:30:00", inWindow: false, ...extra });
const item = (name: string, extra = {}) => ({ installId: 1, name, ecosystem: "brew", from: "1.0.0", to: "2.0.0", bump: "major", running: false, warnings: [], ...extra });

test("the quiet window reads as a range, and wraps past midnight", () => {
  assert.equal(windowRange(quiet()), "03:30 to 05:30");
  assert.equal(windowRange(quiet({ startMinute: 1350 })), "22:30 to 00:30");
});

test("the next start is named by day in the viewer's clock", () => {
  const now = new Date(2026, 9, 25, 12, 0);
  assert.match(startLabel(quiet({ startsAt: new Date(2026, 9, 25, 15, 0).toISOString() }), now), /^today at /);
  assert.match(startLabel(quiet({ startsAt: new Date(2026, 9, 26, 3, 0).toISOString() }), now), /^tomorrow at /);
  assert.equal(startLabel(quiet({ inWindow: true }), now), "now");
  assert.doesNotMatch(startLabel(quiet({ startsAt: new Date(2026, 9, 29, 3, 0).toISOString() }), now), /today|tomorrow/);
});

test("the note names the window and when it next starts", () => {
  const now = new Date(2026, 9, 25, 12, 0);
  const note = quietWindowNote(quiet({ startsAt: new Date(2026, 9, 26, 3, 30).toISOString() }), now);
  assert.match(note, /03:30 to 05:30/);
  assert.match(note, /next starts tomorrow/);
  assert.match(quietWindowNote(quiet({ inWindow: true }), now), /under way/);
});

test("the automatic note says what it does, and when it last ran", () => {
  assert.equal(autoRunNote(null, quiet()), "");
  assert.match(autoRunNote({ enabled: false, lastWindowStart: null, lastQueued: 0, lastRunAt: null }, quiet()), /off.*03:30 to 05:30/);
  assert.match(autoRunNote({ enabled: true, lastWindowStart: null, lastQueued: 0, lastRunAt: null }, quiet()), /up to 15 updates per machine.*close or restart a running program.*not run yet/);
  assert.match(autoRunNote({ enabled: true, lastWindowStart: "x", lastQueued: 1, lastRunAt: "2026-10-25T10:31:00.000Z" }, quiet()), /queued 1 update on/);
  assert.match(autoRunNote({ enabled: true, lastWindowStart: "x", lastQueued: 3, lastRunAt: "2026-10-25T10:31:00.000Z" }, quiet()), /queued 3 updates on/);
  assert.match(autoRunNote({ enabled: true, lastWindowStart: "x", lastQueued: 15, lastRunAt: "2026-10-25T10:31:00.000Z", lastDeferred: 43 }, quiet()), /43 updates were left for the next window/);
  assert.match(autoRunNote({ enabled: false, lastWindowStart: "x", lastQueued: 1, lastRunAt: null, pausedReason: "git failed on mini" }, quiet()), /paused itself after a failure: git failed on mini.*turn it back on/);
});

test("lines show versions, with unknown for a missing one", () => {
  assert.equal(itemLine(item("eza")), "eza: 1.0.0 to 2.0.0");
  assert.equal(itemLine(item("eza", { from: null })), "eza: unknown to 2.0.0");
  assert.equal(heldLine({ ...item("node"), kind: "blocked", reason: "tool needs node below 27" }), "node: 1.0.0 to 2.0.0 (Blocked: tool needs node below 27)");
  assert.match(heldLine({ ...item("node"), kind: "admin", reason: "needs the Windows administrator prompt" }), /administrator prompt/);
});

test("each group carries the ids its button reviews, and empty groups are left out", () => {
  const machine = { machineId: "mini", now: [item("a", { installId: 4 }), item("b", { installId: 5 })], atQuietHour: [item("c", { installId: 6, running: true })], held: [{ ...item("d", { installId: 7 }), kind: "confirm", reason: "needs a check first: eza" }] };
  const groups = machineGroups(machine, quiet(), new Date(2026, 9, 25, 12, 0));
  assert.deepEqual(groups.map((group: any) => group.key), ["now", "quiet", "held"]);
  assert.deepEqual(groups[0].ids, [4, 5]);
  assert.equal(groups[0].button, "Review 2 updates");
  assert.deepEqual(groups[1].ids, [6]);
  assert.equal(groups[1].button, "Review them now anyway");
  assert.match(groups[1].items[0], /running now/);
  assert.deepEqual(groups[2].ids, []);
  assert.equal(groups[2].button, null);
  assert.deepEqual(machineGroups({ ...machine, now: [], atQuietHour: [], held: [] }, quiet()), []);
  assert.equal(machineGroups({ ...machine, now: [item("a")], atQuietHour: [], held: [] }, quiet())[0]!.button, "Review 1 update");
});

test("inside the quiet hours the second batch is offered without the hedge", () => {
  const machine = { machineId: "mini", now: [], atQuietHour: [item("c")], held: [] };
  const [group] = machineGroups(machine, quiet({ inWindow: true }));
  assert.match(group!.heading, /under way/);
  assert.equal(group!.button, "Review 1 update");
});

test("the count adds the start-now items across machines", () => {
  assert.equal(safeNowCount({ machines: [{ now: [item("a")] }, { now: [item("b"), item("c")] }] }), 3);
  assert.equal(safeNowCount(null), 0);
});

test("the mock hub serves the window plan and the new files", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const windows = await (await fetch(`${base}/api/updates/window`)).json();
    assert.equal(windows.machines.length, 4);
    assert.equal(windows.quiet.lengthMinutes, 120);
    assert.equal(windows.autoRun.enabled, false);
    const set = await fetch(`${base}/api/updates/window/auto`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    assert.equal((await set.json()).enabled, true);
    assert.equal((await (await fetch(`${base}/api/updates/window`)).json()).autoRun.enabled, true);
    assert.equal((await fetch(`${base}/api/updates/window/auto`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.ok(windows.machines.some((machine: any) => machine.now.length > 0 && machine.atQuietHour.length > 0 && machine.held.length > 0));
    for (const file of ["update-window.js", "update-window-model.js"]) assert.equal((await fetch(`${base}/${file}`)).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("the automatic note names the cap that is set", () => {
  assert.match(autoRunNote({ enabled: true, lastWindowStart: null, lastQueued: 0, lastRunAt: null, cap: 40 }, quiet()), /up to 40 updates per machine/);
  assert.match(autoRunNote({ enabled: true, lastWindowStart: "x", lastQueued: 40, lastRunAt: "2026-10-25T10:31:00.000Z", cap: 40, lastDeferred: 18 }, quiet()), /more than 40 to run/);
});
