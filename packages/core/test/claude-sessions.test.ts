import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTail, ClaudeMonitor, plainTitle, sessionIdOf, sortSessions, treeMemory, type ClaudeSession, type ProcessRow } from "../src/claude-sessions.ts";

const line = (entry: object): string => JSON.stringify(entry);
const user = (text: string, extra: object = {}): string => line({ type: "user", cwd: "D:\\Repositories\\scout", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const assistantText = (text: string): string => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUse = (id: string, name: string): string => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });
const toolResult = (id: string): string => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const title = (customTitle: string): string => line({ type: "custom-title", customTitle, sessionId: "x" });

test("a question or plan in flight means the session is waiting on a person", () => {
  assert.deepEqual(classifyTail([user("go"), toolUse("a", "AskUserQuestion")]), { state: "waiting", reason: "ask", tool: "AskUserQuestion", title: null, cwd: "D:\\Repositories\\scout" });
  assert.equal(classifyTail([user("go"), toolUse("a", "Bash"), toolResult("a"), toolUse("b", "ExitPlanMode")])?.reason, "plan");
});

test("a question that was answered no longer holds the session", () => {
  const state = classifyTail([user("go"), toolUse("a", "AskUserQuestion"), toolResult("a"), assistantText("Thanks.")]);
  assert.equal(state?.state, "idle");
  assert.equal(state?.reason, "turn-ended");
});

test("any other tool in flight is work, and the newest open tool is named", () => {
  const state = classifyTail([user("go"), toolUse("a", "Read"), toolUse("b", "Bash")]);
  assert.equal(state?.state, "running");
  assert.equal(state?.tool, "Bash");
  assert.equal(classifyTail([user("go"), toolUse("a", "Read"), toolResult("a"), toolUse("b", "Bash")])?.tool, "Bash");
});

test("with nothing in flight the last message decides", () => {
  assert.equal(classifyTail([assistantText("Done.")])?.state, "idle");
  assert.deepEqual(classifyTail([user("next")]) && [classifyTail([user("next")])?.state, classifyTail([user("next")])?.reason], ["running", "prompt"]);
  assert.equal(classifyTail([toolUse("a", "Bash"), toolResult("a")])?.reason, "prompt");
  assert.equal(classifyTail([line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } })])?.reason, "thinking");
});

test("an interrupted turn is idle, not running", () => {
  const state = classifyTail([user("go"), toolUse("a", "Bash"), toolResult("a"), user("[Request interrupted by user]")]);
  assert.equal(state?.state, "idle");
  assert.equal(state?.reason, "interrupted");
});

test("side-chain, meta, bookkeeping, and half-written lines never decide the state", () => {
  const state = classifyTail([assistantText("Done."), line({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "s", name: "Bash" }] } }), line({ type: "user", isMeta: true, message: { content: "x" } }), line({ type: "pr-link" }), '{"type":"assistant","mess']);
  assert.equal(state?.state, "idle");
});

test("the newest title wins, and a window with no messages and no title reads as nothing", () => {
  assert.equal(classifyTail([title("Old"), assistantText("Done."), title("New")])?.title, "New");
  assert.equal(classifyTail([line({ type: "mode" })]), null);
});

test("the session id comes from the resume or session-id argument of a Claude Code command line only", () => {
  const id = "d3e924ab-60a7-4ced-a6ee-63dc3a76a6ff";
  assert.equal(sessionIdOf(`C:\\Users\\x\\claude.exe --output-format stream-json --verbose --resume=${id} --allowedTools=a`), id);
  assert.equal(sessionIdOf(`/home/x/claude --output-format stream-json --session-id ${id}`), id);
  assert.equal(sessionIdOf(`claude.exe --type=renderer --resume=${id}`), null);
  assert.equal(sessionIdOf("node server.js"), null);
});

test("the status emoji the app puts before a title is dropped", () => {
  assert.equal(plainTitle("\u2699\uFE0F Scout"), "Scout");
  assert.equal(plainTitle("\u{1F64B} ARK Rarities"), "ARK Rarities");
  assert.equal(plainTitle("Plain"), "Plain");
});

test("memory sums a process with everything it started, once", () => {
  const rows: ProcessRow[] = [
    { pid: 1, parentPid: 0, memBytes: 100, startedAt: null, command: "" },
    { pid: 2, parentPid: 1, memBytes: 10, startedAt: null, command: "" },
    { pid: 3, parentPid: 2, memBytes: 1, startedAt: null, command: "" },
    { pid: 4, parentPid: 4, memBytes: 7, startedAt: null, command: "" },
  ];
  const memory = treeMemory(rows);
  assert.deepEqual([memory.get(1), memory.get(2), memory.get(3), memory.get(4)], [111, 11, 1, 7]);
});

test("waiting sessions sort first, then running, then idle, newest first inside each", () => {
  const make = (id: string, state: ClaudeSession["state"], at: string): ClaudeSession => ({ id, title: id, cwd: null, state, reason: "turn-ended", tool: null, openSurveys: 0, pid: 1, startedAt: null, lastActivityAt: at, memBytes: 0, treeBytes: 0 });
  const sorted = sortSessions([make("idle-new", "idle", "2026-10-31T03:00:00Z"), make("run-old", "running", "2026-10-31T01:00:00Z"), make("wait", "waiting", "2026-10-31T00:00:00Z"), make("run-new", "running", "2026-10-31T02:00:00Z")]);
  assert.deepEqual(sorted.map((s) => s.id), ["wait", "run-new", "run-old", "idle-new"]);
});

const dir = mkdtempSync(join(tmpdir(), "scout-claude-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const ids = { ask: "11111111-1111-4111-8111-111111111111", run: "22222222-2222-4222-8222-222222222222", idle: "33333333-3333-4333-8333-333333333333", survey: "44444444-4444-4444-8444-444444444444" };
const cmd = (id: string): string => `C:\\claude.exe --output-format stream-json --resume=${id}`;

function transcript(id: string, lines: string[], ageMs = 0): void {
  mkdirSync(join(dir, "projects", "D--Repositories"), { recursive: true });
  const path = join(dir, "projects", "D--Repositories", `${id}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

test("the monitor reports each session's state, memory, and unanswered surveys, and shares one read between callers", async () => {
  transcript(ids.ask, [title("\u{1F64B} Asker"), user("go"), toolUse("a", "AskUserQuestion")]);
  transcript(ids.run, [title("\u2699\uFE0F Worker"), user("go"), toolUse("a", "Bash")], 5 * 60_000);
  transcript(ids.idle, [title("Resting"), assistantText("Done.")], 3_600_000);
  transcript(ids.survey, [title("Survey"), assistantText("Done.")]);
  mkdirSync(join(dir, "state", "pending-asks"), { recursive: true });
  writeFileSync(join(dir, "state", "pending-asks", "local-abc.json"), JSON.stringify({ sessionId: "local_abc", title: "Survey", sets: [{ id: "s1" }, { id: "s2" }] }));
  writeFileSync(join(dir, "state", "pending-asks", "local-empty.json"), JSON.stringify({ sessionId: "local_empty", title: "x", sets: [] }));
  writeFileSync(join(dir, "state", "pending-asks", ".last-response.log"), "not json");
  const app = join(dir, "app", "acct", "space");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "local_abc.json"), JSON.stringify({ cliSessionId: ids.survey }));
  const rows: ProcessRow[] = [
    { pid: 10, parentPid: 1, memBytes: 400, startedAt: "2026-10-30T09:00:00.000Z", command: cmd(ids.ask) },
    { pid: 11, parentPid: 10, memBytes: 50, startedAt: null, command: "" },
    { pid: 20, parentPid: 1, memBytes: 300, startedAt: null, command: cmd(ids.run) },
    { pid: 30, parentPid: 1, memBytes: 200, startedAt: null, command: cmd(ids.idle) },
    { pid: 40, parentPid: 1, memBytes: 100, startedAt: null, command: cmd(ids.survey) },
    { pid: 99, parentPid: 1, memBytes: 900, startedAt: null, command: "" },
  ];
  let reads = 0;
  const monitor = new ClaudeMonitor({ claudeDir: dir, appSessionsDir: join(dir, "app"), listProcesses: async () => { reads++; return rows; } });
  const [first, second] = await Promise.all([monitor.read(), monitor.read()]);
  assert.equal(reads, 1);
  assert.equal(first, second);
  assert.deepEqual(first.counts, { waiting: 2, running: 1, idle: 1 });
  assert.deepEqual(first.sessions.map((s) => [s.title, s.state, s.reason]), [["Survey", "waiting", "survey"], ["Asker", "waiting", "ask"], ["Worker", "running", "tool"], ["Resting", "idle", "turn-ended"]]);
  const asker = first.sessions.find((s) => s.title === "Asker")!;
  assert.deepEqual([asker.pid, asker.memBytes, asker.treeBytes, asker.startedAt, asker.cwd], [10, 400, 450, "2026-10-30T09:00:00.000Z", "D:\\Repositories\\scout"]);
  assert.equal(first.sessions.find((s) => s.title === "Survey")!.openSurveys, 2);
  assert.ok(Date.now() - Date.parse(first.sessions.find((s) => s.title === "Worker")!.lastActivityAt!) >= 5 * 60_000 - 1000);
});

test("a session whose transcript is missing is idle with a short id for a title, and no sessions reads as an empty list", async () => {
  const monitor = new ClaudeMonitor({ claudeDir: join(dir, "nowhere"), listProcesses: async () => [{ pid: 5, parentPid: 1, memBytes: 9, startedAt: null, command: cmd("55555555-5555-4555-8555-555555555555") }] });
  const read = await monitor.read();
  assert.deepEqual(read.sessions.map((s) => [s.title, s.state, s.reason, s.lastActivityAt]), [["Session 55555555", "idle", "empty", null]]);
  const none = await new ClaudeMonitor({ claudeDir: dir, listProcesses: async () => [] }).read();
  assert.deepEqual([none.sessions.length, none.counts], [0, { waiting: 0, running: 0, idle: 0 }]);
});

test("a failed process read is not cached, so the next read tries again", async () => {
  let calls = 0;
  const monitor = new ClaudeMonitor({ claudeDir: dir, listProcesses: async () => { calls++; if (calls === 1) throw new Error("pwsh missing"); return []; } });
  await assert.rejects(monitor.read(), /pwsh missing/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await monitor.read()).sessions.length, 0);
});
