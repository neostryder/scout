import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { usageFixtureTests } from "@scout/core/testing";
import { adapter, checkpointsFromOutputs, createAdapter } from "../src/index.ts";
import { commandTools, transcriptTools } from "../src/commands.ts";
import { aggregateDays, cleanCheckpoint, type Checkpoint } from "../src/state.ts";
import { PROBE_SCRIPT } from "../src/probe.ts";
import type { ProbeOutput } from "@scout/core";

const fixtures = fileURLToPath(new URL("../../../fixtures/aiuse", import.meta.url));
const fixture = (name: string): string => readFileSync(join(fixtures, name), "utf8");
const NOW = "2026-09-30T12:00:00.000Z";

usageFixtureTests(adapter, fixtures);

test("the command parser unwraps every synthetic command without retaining arguments", () => {
  const cases = JSON.parse(fixture("commands.json")) as { command: string; tools: string[] }[];
  for (const row of cases) assert.deepEqual(commandTools(row.command), row.tools);
  const slash = String.fromCharCode(92);
  assert.deepEqual(commandTools(`C:${slash}private${slash}rg.exe pattern`), ["rg"]);
  assert.deepEqual(commandTools("bash -c 'sh -c \"sudo git status\"'"), ["git"]);
  assert.deepEqual(commandTools("bash -c 'echo ignored' 'PRIVATE_VALUE; unwanted'"), []);
});

function sandbox(): { home: string; log: string; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), "scout-aiuse-"));
  const claude = join(home, ".claude/projects/synthetic");
  const codex = join(home, ".codex/sessions/2026/09/30");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return { home, log: join(claude, "session.jsonl"), close: () => rmSync(home, { recursive: true, force: true }) };
}

function probe(home: string, agent: "claude" | "codex", state: Checkpoint = { files: {} }): ProbeOutput {
  const clock = `const OriginalDate = Date; globalThis.Date = class extends OriginalDate { constructor(...args) { if (args.length === 0) super("${NOW}"); else super(...args); } };\n`;
  const options = { windowsHide: true, detached: true, encoding: "utf8" as const, input: JSON.stringify(state), env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 10000 };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", clock + PROBE_SCRIPT, agent], options);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return { exitCode: result.status!, stdout: result.stdout, stderr: result.stderr };
}

const stateOf = (output: ProbeOutput): Checkpoint => checkpointsFromOutputs({ claude: output }).claude!;
const rowOf = (output: ProbeOutput, tool: string): string[] | undefined => output.stdout.split("\n").find((line) => line.startsWith(`${tool}\t`))?.split("\t");

function assertPrivate(output: ProbeOutput): void {
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|customer|private|command|arguments|message|prompt|content|session\.jsonl/);
  for (const line of output.stdout.trimEnd().split("\n")) {
    if (line.startsWith("#checkpoint ")) {
      const raw = JSON.parse(line.slice(12));
      assert.deepEqual(raw, cleanCheckpoint(raw));
      assert.ok(Object.keys(raw.files).every((id) => /^[a-f0-9]{24}$/.test(id)));
    } else if (line.startsWith("#day\t")) {
      assert.match(line, /^#day\t[a-z0-9_][a-z0-9_.+-]*\t\d{4}-\d{2}-\d{2}\t\d+\t\d{4}-\d{2}-\d{2}T[0-9:.]+Z\t(claude|codex)$/);
    } else {
      assert.match(line, /^[a-z0-9_][a-z0-9_.+-]*\t\d+\t\d+\t\d{4}-\d{2}-\d{2}T[0-9:.]+Z\t(claude|codex)$/);
    }
  }
}

test("the embedded probe runs the same parser on both synthetic transcript formats and emits only counts", () => {
  const box = sandbox();
  try {
    for (const agent of ["claude", "codex"] as const) {
      const transcript = fixture(`${agent}.jsonl`);
      writeFileSync(agent === "claude" ? box.log : join(box.home, ".codex/sessions/2026/09/30/rollout-synthetic.jsonl"), transcript);
      const output = probe(box.home, agent);
      assertPrivate(output);
      const expected = new Map<string, { count7: number; count30: number; lastSeen: string }>();
      for (const line of transcript.split("\n")) {
        const parsed = transcriptTools(line, agent);
        if (!parsed) continue;
        for (const tool of parsed.tools) {
          const name = tool.toLowerCase();
          const old = expected.get(name) ?? { count7: 0, count30: 0, lastSeen: "" };
          expected.set(name, { count7: old.count7 + (parsed.timestamp >= "2026-09-24" ? 1 : 0), count30: old.count30 + (parsed.timestamp >= "2026-09-01" ? 1 : 0), lastSeen: old.lastSeen > parsed.timestamp ? old.lastSeen : parsed.timestamp });
        }
      }
      const state = checkpointsFromOutputs({ [agent]: output })[agent]!;
      const actual = aggregateDays(state, NOW);
      assert.deepEqual(actual.map(({ tool, count7, count30, lastSeen }) => [tool, { count7, count30, lastSeen }]), [...expected].sort(([a], [b]) => a.localeCompare(b)));
      assert.ok(Object.values(state.files).every((file) => file.offset === file.size));
      const git = rowOf(output, "git");
      assert.deepEqual(git?.slice(1, 3), agent === "claude" ? ["2", "4"] : ["1", "2"]);
    }
  } finally { box.close(); }
});

test("a checkpoint reads appended bytes once and keeps incomplete lines for the next scan", () => {
  const box = sandbox();
  try {
    writeFileSync(box.log, fixture("claude.jsonl"));
    const first = probe(box.home, "claude");
    const state = stateOf(first);
    assert.deepEqual(probe(box.home, "claude", state), first);
    const added = fixture("truncated.jsonl");
    const split = added.indexOf("command");
    appendFileSync(box.log, added.slice(0, split));
    const half = probe(box.home, "claude", state);
    assert.deepEqual(rowOf(half, "rg"), rowOf(first, "rg"));
    assert.equal(Object.values(stateOf(half).files)[0]!.offset, Object.values(state.files)[0]!.offset);
    appendFileSync(box.log, added.slice(split));
    const full = probe(box.home, "claude", stateOf(half));
    assert.equal(Number(rowOf(full, "rg")?.[1]), Number(rowOf(first, "rg")?.[1]) + 1);
    assert.deepEqual(probe(box.home, "claude", stateOf(full)), full);
    assertPrivate(full);
  } finally { box.close(); }
});

test("a short growing file keeps its old prefix checkpoint and malformed complete lines advance the offset", () => {
  const box = sandbox();
  try {
    writeFileSync(box.log, "{bad}\n");
    const first = probe(box.home, "claude");
    appendFileSync(box.log, fixture("truncated.jsonl"));
    const output = probe(box.home, "claude", stateOf(first));
    assert.equal(rowOf(output, "rg")?.[1], "1");
    assert.equal(Object.values(stateOf(output).files)[0]!.offset, Object.values(stateOf(output).files)[0]!.size);
    assert.deepEqual(probe(box.home, "claude", stateOf(output)), output);
  } finally { box.close(); }
});

test("a truncated file and a replacement with the same prefix replace earlier counts", () => {
  const box = sandbox();
  try {
    writeFileSync(box.log, fixture("claude.jsonl"));
    const first = probe(box.home, "claude");
    writeFileSync(box.log, fixture("truncated.jsonl"));
    const truncated = probe(box.home, "claude", stateOf(first));
    assert.equal(rowOf(truncated, "git"), undefined);
    assert.equal(rowOf(truncated, "rg")?.[1], "1");
    const replacement = `${box.log}.replacement`;
    writeFileSync(replacement, fixture("replaced.jsonl"));
    assert.equal(fixture("truncated.jsonl").slice(0, 64), fixture("replaced.jsonl").slice(0, 64));
    rmSync(box.log);
    renameSync(replacement, box.log);
    const replaced = probe(box.home, "claude", stateOf(truncated));
    assert.equal(rowOf(replaced, "rg"), undefined);
    assert.equal(rowOf(replaced, "node")?.[1], "1");
    assert.equal(Object.keys(stateOf(replaced).files).length, 1);
    writeFileSync(box.log, fixture("claude.jsonl"));
    const old = probe(box.home, "claude");
    const changed = fixture("claude.jsonl").replace("2026-09-30T10", "2026-09-30T11");
    writeFileSync(box.log, changed);
    const modified = probe(box.home, "claude", stateOf(old));
    assert.equal(rowOf(modified, "git")?.[3], "2026-09-30T11:00:00.000Z");
    assertPrivate(modified);
  } finally { box.close(); }
});

test("the adapter sanitizes checkpoints and never exposes failed-probe text", () => {
  const output = adapter.parse({ claude: { exitCode: 1, stdout: "PRIVATE_VALUE", stderr: "PRIVATE_VALUE" } });
  assert.equal(output.status, "failed");
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_VALUE/);
  assert.deepEqual(checkpointsFromOutputs({ claude: { exitCode: 0, stdout: '#checkpoint {"files":{"C:/private/log":{"command":"PRIVATE_VALUE"}}}', stderr: "" } }), { claude: { files: {} } });
  assert.deepEqual(createAdapter().probes({ machineId: "synthetic", os: "windows", roots: {} }).map((p) => [p.id, p.argv.slice(0, 3), p.stdin?.startsWith("globalThis.__SCOUT_STATE__ = ")]), [["claude", ["node", "--input-type=module", "-"], true], ["codex", ["node", "--input-type=module", "-"], true]]);
  const state = cleanCheckpoint({ files: { ["a".repeat(24)]: { pathHash: "b".repeat(24), prefixHash: "c".repeat(64), prefixLength: 0, size: 0, offset: 0, days: [{ tool: 123, count: 1, date: "2026-09-30", lastSeen: NOW }] } } });
  assert.deepEqual(aggregateDays(state, NOW), []);
});

test("empty synthetic log roots emit a checkpoint without any usage rows", () => {
  const box = sandbox();
  try {
    const outputs = { claude: probe(box.home, "claude"), codex: probe(box.home, "codex") };
    assert.equal(outputs.claude.stdout, '#checkpoint {"files":{}}\n');
    assert.equal(outputs.codex.stdout, '#checkpoint {"files":{}}\n');
    assert.deepEqual(adapter.parse(outputs), { origin: "ai-use", status: "ok", signals: [], completeFor: ["ai_use_7d", "ai_use_30d"] });
  } finally { box.close(); }
});

test("daily counts include exactly seven and thirty UTC dates and retain the last use after aging out", () => {
  const days = ["2026-09-30", "2026-09-24", "2026-09-23", "2026-09-01", "2026-08-31", "2026-10-01"].map((date) => ({ tool: "git", date, count: 1, lastSeen: `${date}T10:00:00.000Z` }));
  const file = { pathHash: "a".repeat(24), size: 0, offset: 0, prefixLength: 0, prefixHash: "b".repeat(64), days };
  const row = aggregateDays({ files: { synthetic: file } }, NOW)[0]!;
  assert.deepEqual([row.count7, row.count30, row.lastSeen], [2, 4, "2026-09-30T10:00:00.000Z"]);
  const aged = aggregateDays({ files: { synthetic: file } }, "2026-12-01T12:00:00.000Z")[0]!;
  assert.deepEqual([aged.count7, aged.count30, aged.lastSeen], [0, 0, "2026-10-01T10:00:00.000Z"]);
});
