import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openCatalog, type ClaudeSessionsResponse } from "@scout/core";
import { createHub } from "../src/server.ts";
import { parsePsProcesses, parseWindowsProcesses } from "../src/claude-processes.ts";

const reply: ClaudeSessionsResponse = {
  available: true, at: "2026-10-31T03:00:00.000Z", counts: { waiting: 1, running: 0, idle: 0 },
  sessions: [{ id: "a", title: "Scout", cwd: null, state: "waiting", reason: "ask", tool: "AskUserQuestion", openSurveys: 0, pid: 1, startedAt: null, lastActivityAt: null, memBytes: 1, treeBytes: 2 }],
};

const dir = mkdtempSync(join(tmpdir(), "scout-claude-api-"));
const open = (claude?: { read(): Promise<ClaudeSessionsResponse> }) => {
  const db = openCatalog(":memory:");
  const server = createHub({ db, webRoot: dir, ...(claude ? { claude } : {}) });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.close(() => { db.close(); done(); }); server.closeAllConnections(); }),
  })));
};
after(() => rmSync(dir, { recursive: true, force: true }));

test("/api/claude answers with the monitor's read", async () => {
  const hub = await open({ read: async () => reply });
  try {
    const res = await fetch(`${hub.base}/api/claude`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), reply);
  } finally { await hub.close(); }
});

test("/api/claude answers 404 when the monitor is off and 503 when the process table cannot be read", async () => {
  const off = await open();
  try { assert.equal((await fetch(`${off.base}/api/claude`)).status, 404); } finally { await off.close(); }
  const broken = await open({ read: async () => { throw new Error("pwsh missing"); } });
  try {
    const res = await fetch(`${broken.base}/api/claude`);
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /pwsh missing/);
  } finally { await broken.close(); }
});

test("the Windows process table parses as a list or as the single object PowerShell prints for one row", () => {
  const row = { p: 7, pp: 1, m: 2048, s: "2026-10-30T09:00:00.0000000Z", c: "claude.exe --resume=x" };
  assert.deepEqual(parseWindowsProcesses(JSON.stringify([row, { p: 8, pp: 7, m: 1, s: null, c: "" }, { p: "x" }])), [
    { pid: 7, parentPid: 1, memBytes: 2048, startedAt: "2026-10-30T09:00:00.0000000Z", command: "claude.exe --resume=x" },
    { pid: 8, parentPid: 7, memBytes: 1, startedAt: null, command: "" },
  ]);
  assert.equal(parseWindowsProcesses(JSON.stringify(row)).length, 1);
});

test("a ps table parses into rows with memory in bytes and a start time, and keeps only Claude command lines", () => {
  const table = [
    "  100     1  20480 Fri Oct 30 09:10:56 2026 /Users/x/claude --output-format stream-json --resume=abc",
    "  101   100   1024 Fri Oct 30 09:11:00 2026 node /Users/x/server.js",
    "garbage line",
  ].join("\n");
  const rows = parsePsProcesses(table);
  assert.deepEqual(rows.map((r) => [r.pid, r.parentPid, r.memBytes]), [[100, 1, 20480 * 1024], [101, 100, 1024 * 1024]]);
  assert.equal(rows[0]!.command.includes("--resume=abc"), true);
  assert.equal(rows[1]!.command, "");
  assert.equal(Number.isNaN(Date.parse(rows[0]!.startedAt!)), false);
});
