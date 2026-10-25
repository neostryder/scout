import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHub } from "../dev/mock-hub.ts";

const { hourRange, startLabel, quietHourNote, itemLine, heldLine, machineGroups, safeNowCount } = await import(new URL("../public/update-window-model.js", import.meta.url).href);

const quiet = (extra = {}) => ({ hour: 3, length: 2, basis: "measured", meanCpuPct: 4.2, samples: 480, startsAt: "2026-10-26T03:00:00", inWindow: false, ...extra });
const item = (name: string, extra = {}) => ({ installId: 1, name, ecosystem: "brew", from: "1.0.0", to: "2.0.0", bump: "major", running: false, warnings: [], ...extra });

test("the quiet window reads as a range, and wraps past midnight", () => {
  assert.equal(hourRange(quiet()), "03:00 to 05:00");
  assert.equal(hourRange(quiet({ hour: 23 })), "23:00 to 01:00");
});

test("the next start is named by day in the viewer's clock", () => {
  const now = new Date(2026, 9, 25, 12, 0);
  assert.match(startLabel(quiet({ startsAt: new Date(2026, 9, 25, 15, 0).toISOString() }), now), /^today at /);
  assert.match(startLabel(quiet({ startsAt: new Date(2026, 9, 26, 3, 0).toISOString() }), now), /^tomorrow at /);
  assert.equal(startLabel(quiet({ inWindow: true }), now), "now");
  assert.doesNotMatch(startLabel(quiet({ startsAt: new Date(2026, 9, 29, 3, 0).toISOString() }), now), /today|tomorrow/);
});

test("the note says whether the hour was measured or defaulted", () => {
  const now = new Date(2026, 9, 25, 12, 0);
  const measured = quietHourNote(quiet({ startsAt: new Date(2026, 9, 26, 3, 0).toISOString() }), now);
  assert.match(measured, /03:00 to 05:00/);
  assert.match(measured, /4\.2% CPU/);
  assert.match(quietHourNote(quiet({ basis: "default", meanCpuPct: null }), now), /not enough load history/);
  assert.match(quietHourNote(quiet({ inWindow: true }), now), /under way/);
});

test("lines show versions, with unknown for a missing one", () => {
  assert.equal(itemLine(item("eza")), "eza: 1.0.0 to 2.0.0");
  assert.equal(itemLine(item("eza", { from: null })), "eza: unknown to 2.0.0");
  assert.equal(heldLine({ ...item("node"), kind: "blocked", reason: "tool needs node below 27" }), "node: 1.0.0 to 2.0.0 (Blocked: tool needs node below 27)");
  assert.match(heldLine({ ...item("node"), kind: "admin", reason: "needs the Windows administrator prompt" }), /administrator prompt/);
});

test("each group carries the ids its button reviews, and empty groups are left out", () => {
  const machine = { machineId: "mini", quietHour: quiet(), now: [item("a", { installId: 4 }), item("b", { installId: 5 })], atQuietHour: [item("c", { installId: 6, running: true })], held: [{ ...item("d", { installId: 7 }), kind: "confirm", reason: "needs a check first: eza" }] };
  const groups = machineGroups(machine, new Date(2026, 9, 25, 12, 0));
  assert.deepEqual(groups.map((group: any) => group.key), ["now", "quiet", "held"]);
  assert.deepEqual(groups[0].ids, [4, 5]);
  assert.equal(groups[0].button, "Review 2 updates");
  assert.deepEqual(groups[1].ids, [6]);
  assert.equal(groups[1].button, "Review them now anyway");
  assert.match(groups[1].items[0], /running now/);
  assert.deepEqual(groups[2].ids, []);
  assert.equal(groups[2].button, null);
  assert.deepEqual(machineGroups({ ...machine, now: [], atQuietHour: [], held: [] }), []);
  assert.equal(machineGroups({ ...machine, now: [item("a")], atQuietHour: [], held: [] })[0]!.button, "Review 1 update");
});

test("inside the quiet hours the second batch is offered without the hedge", () => {
  const machine = { machineId: "mini", quietHour: quiet({ inWindow: true }), now: [], atQuietHour: [item("c")], held: [] };
  const [group] = machineGroups(machine);
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
    assert.ok(windows.machines.every((machine: any) => machine.quietHour.length === 2));
    assert.ok(windows.machines.some((machine: any) => machine.now.length > 0 && machine.atQuietHour.length > 0 && machine.held.length > 0));
    for (const file of ["update-window.js", "update-window-model.js"]) assert.equal((await fetch(`${base}/${file}`)).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
