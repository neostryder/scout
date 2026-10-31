import { test } from "node:test";
import assert from "node:assert/strict";

const { stateWord, reasonText, sinceText, openText, isQuiet, memoryText, groups, summaryText, folderText, pollMs, QUIET_MINUTES } = await import(new URL("../public/claude-model.js", import.meta.url).href);

const MIB = 1_048_576;
const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const session = (over: object = {}) => ({ id: "a", title: "Scout", cwd: String.raw`D:\Repositories\scout`, state: "running", reason: "tool", tool: "Bash", openSurveys: 0, pid: 1, startedAt: ago(192), lastActivityAt: ago(4), memBytes: 400 * MIB, treeBytes: 1100 * MIB, ...over });

test("each state has a plain word and each reason a plain line", () => {
  assert.deepEqual(["waiting", "running", "idle"].map(stateWord), ["Waiting on you", "Running", "Idle"]);
  assert.equal(reasonText(session()), "Running Bash");
  assert.equal(reasonText(session({ tool: null })), "Running a tool");
  assert.equal(reasonText(session({ reason: "ask" })), "Asking you a question");
  assert.equal(reasonText(session({ reason: "plan" })), "A plan is waiting for your approval");
  assert.equal(reasonText(session({ reason: "survey", openSurveys: 1 })), "Left a question set unanswered");
  assert.equal(reasonText(session({ reason: "survey", openSurveys: 3 })), "Left 3 question sets unanswered");
  assert.equal(reasonText(session({ reason: "turn-ended" })), "Finished its turn");
  assert.equal(reasonText(session({ reason: "empty" })), "No transcript yet");
});

test("ages read as minutes up to ninety, then hours, then days", () => {
  assert.equal(sinceText(session({ lastActivityAt: ago(0.2) }), NOW), "Output just now");
  assert.equal(sinceText(session({ lastActivityAt: ago(4) }), NOW), "Last output 4 min ago");
  assert.equal(sinceText(session({ lastActivityAt: ago(125) }), NOW), "Last output 2 h 05 min ago");
  assert.equal(sinceText(session({ lastActivityAt: null }), NOW), "No output yet");
  assert.equal(openText(session({ startedAt: ago(192) }), NOW), "Open 3 h 12 min");
  assert.equal(openText(session({ startedAt: ago(60 * 24 * 3) }), NOW), "Open 3 days");
  assert.equal(openText(session({ startedAt: null }), NOW), "Open time unknown");
});

test("only a running session gone quiet is flagged", () => {
  assert.equal(isQuiet(session({ lastActivityAt: ago(QUIET_MINUTES + 1) }), NOW), true);
  assert.equal(isQuiet(session({ lastActivityAt: ago(QUIET_MINUTES - 1) }), NOW), false);
  assert.equal(isQuiet(session({ state: "idle", lastActivityAt: ago(500) }), NOW), false);
  assert.equal(isQuiet(session({ state: "waiting", lastActivityAt: ago(500) }), NOW), false);
  assert.equal(isQuiet(session({ lastActivityAt: null }), NOW), false);
});

test("memory shows the whole tree, and the session's own share only when its tools hold much more", () => {
  assert.equal(memoryText(session()), "1.1 GB (400 MB itself)");
  assert.equal(memoryText(session({ memBytes: 400 * MIB, treeBytes: 450 * MIB })), "450 MB");
});

test("groups come in waiting, running, idle order and an empty group is left out", () => {
  const all = [session({ id: "i", state: "idle" }), session({ id: "w", state: "waiting" }), session({ id: "w2", state: "waiting" })];
  assert.deepEqual(groups(all).map((g: any) => [g.state, g.sessions.map((s: any) => s.id)]), [["waiting", ["w", "w2"]], ["idle", ["i"]]]);
  assert.deepEqual(groups([]), []);
});

test("the summary counts each group and totals the memory, and says so when nothing runs", () => {
  const reply = { available: true, at: "x", counts: { waiting: 1, running: 1, idle: 0 }, sessions: [session({ treeBytes: 1024 * MIB }), session({ treeBytes: 512 * MIB })] };
  assert.equal(summaryText(reply), "1 waiting on you, 1 running, 0 idle. 1.5 GB in use.");
  assert.equal(summaryText({ available: true, at: "x", counts: { waiting: 0, running: 0, idle: 0 }, sessions: [] }), "No Claude Code session is running on this machine.");
});

test("the folder line is the last part of the working directory, from either kind of path", () => {
  assert.equal(folderText(String.raw`D:\Repositories\scout`), "scout");
  assert.equal(folderText("/home/aaron/projects/scout/"), "scout");
  assert.equal(folderText(null), "");
  assert.equal(pollMs(), 10_000);
});
