import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CompetitorRow, CompetitorRun, RunState } from "@scout/core";
import { localPaths } from "@scout/ops";
import { createTools, type ToolContext } from "../src/index.ts";

const NOW = "2026-10-19T00:00:00.000Z";

function row(over: Partial<CompetitorRow> = {}): CompetitorRow {
  return {
    id: "acme-tools", name: "Acme Tools", org: "Acme", remoteUrl: "https://example.test/acme", packageUrl: "https://example.test/pkg",
    flags: ["forge"], mirrorPresent: true, dossierReviewed: null,
    baseline: { version: "1.0.0", commit: "abc", at: "2026-01-01", source: "mirror" },
    latest: { version: "1.1.0", prerelease: null, commit: "def", checkedAt: NOW, error: null },
    status: "new", newBasis: "version",
    sync: { at: NOW, head: "def", error: null },
    pending: { commits: 3, sourceFilesChanged: 1, reason: "3 commits, below the threshold of 5" },
    watch: null, run: null, ...over,
  };
}

function queued(over: Partial<CompetitorRun> = {}): CompetitorRun {
  return {
    id: 4, competitorId: "acme-tools", state: "queued", fromVersion: "1.0.0", toVersion: "1.1.0",
    requestedAt: NOW, updatedAt: NOW, claimedBy: null, resultPath: null, summary: null, error: null, stale: false,
    request: { competitor: { id: "acme-tools", name: "Acme Tools" }, analysis: { flags: { reaReason: "source score 40" } } },
    trigger: "auto", ...over,
  };
}

function harness(t: TestContext, competitors: NonNullable<ToolContext["competitors"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-comp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = localPaths(dir);
  mkdirSync(dirname(paths.db), { recursive: true });
  const tools = createTools({ paths, now: () => NOW, competitors });
  const tool = (name: string) => {
    const found = tools.find((item) => item.name === name);
    assert.ok(found, name);
    return found!;
  };
  return { tools, tool };
}

test("the competitor tools are named, and only claim, complete, fail, gate, watch, and start change anything", (t) => {
  const { tools } = harness(t);
  assert.deepEqual(tools.map((tool) => tool.name).filter((name) => name.startsWith("scout_competitor")), ["scout_competitors", "scout_competitor_queue", "scout_competitor_gate", "scout_competitor_watch", "scout_competitor_claim", "scout_competitor_complete", "scout_competitor_fail"]);
  assert.deepEqual(tools.filter((tool) => !tool.readOnly).map((tool) => tool.name).sort(), ["scout_competitor_claim", "scout_competitor_complete", "scout_competitor_fail", "scout_competitor_gate", "scout_competitor_watch", "scout_start_service"]);
});

test("scout_competitors filters by status and caps the rows at 200", async (t) => {
  const seen: string[] = [];
  const rows = Array.from({ length: 201 }, (_, index) => row({ id: `c${index}`, name: `Name ${index}`, status: index === 0 ? "current" : "new" }));
  const { tool } = harness(t, { listCompetitors: (_db, now) => { seen.push(now || ""); return rows; } });
  const all = await tool("scout_competitors").run({}) as { total: number; competitors: CompetitorRow[] };
  assert.equal(all.total, 201);
  assert.equal(all.competitors.length, 200);
  assert.equal(seen[0], NOW);
  const current = await tool("scout_competitors").run({ status: "current" }) as { total: number; competitors: CompetitorRow[] };
  assert.equal(current.total, 1);
  assert.equal(current.competitors[0]?.id, "c0");
  assert.equal(current.competitors[0]?.pending?.commits, 3);
  assert.equal(current.competitors[0]?.sync.head, "def");
  assert.match(String(tool("scout_competitors").description), /fills itself/);
  await assert.rejects(Promise.resolve().then(() => tool("scout_competitors").run({ status: "gone" })), /status/);
  assert.equal(seen.length, 2);
});

test("the queue defaults to queued and returns each run's request", async (t) => {
  const seen: RunState[][] = [];
  const { tool } = harness(t, { listCompetitorRuns: (_db, states) => { seen.push(states); return [queued()]; } });
  const out = await tool("scout_competitor_queue").run({}) as { runs: CompetitorRun[] };
  assert.deepEqual(seen[0], ["queued"]);
  assert.equal(out.runs[0]?.request && (out.runs[0].request as { competitor: { id: string } }).competitor.id, "acme-tools");
  assert.equal(out.runs[0]?.trigger, "auto");
  assert.equal((out.runs[0]?.request as { analysis: { flags: { reaReason: string } } }).analysis.flags.reaReason, "source score 40");
  assert.match(String(tool("scout_competitor_queue").description), /procedural analysis/);
  await tool("scout_competitor_queue").run({ states: ["claimed", "queued"] });
  assert.deepEqual(seen[1], ["claimed", "queued"]);
  await assert.rejects(Promise.resolve().then(() => tool("scout_competitor_queue").run({ states: ["pulling"] })), /states/);
  await assert.rejects(Promise.resolve().then(() => tool("scout_competitor_queue").run({ states: "queued" })), /states/);
  assert.equal(seen.length, 2);
});

test("claim, complete, and fail pass their fields through and reject bad input", async (t) => {
  const seen: unknown[] = [];
  const { tool } = harness(t, {
    claimCompetitorRun: (_db, runId, by, now) => { seen.push(["claim", runId, by, now]); return queued({ state: "claimed", claimedBy: by }); },
    completeCompetitorRun: (_db, runId, input, now) => { seen.push(["complete", runId, input, now]); return queued({ state: "done" }); },
    failCompetitorRun: (_db, runId, error, now) => { seen.push(["fail", runId, error, now]); return queued({ state: "failed", error }); },
  });
  const claimed = await tool("scout_competitor_claim").run({ runId: 4, by: "Ada" }) as CompetitorRun;
  assert.equal(claimed.state, "claimed");
  assert.deepEqual(seen[0], ["claim", 4, "Ada", NOW]);
  await tool("scout_competitor_complete").run({ runId: 4, resultPath: "notes/acme.md", summary: "Shipped 1.1.0." });
  assert.deepEqual(seen[1], ["complete", 4, { resultPath: "notes/acme.md", summary: "Shipped 1.1.0." }, NOW]);
  await tool("scout_competitor_complete").run({ runId: 4, resultPath: "notes/acme.md", summary: "Shipped 1.1.0.", analyzedVersion: "1.1.0" });
  assert.deepEqual((seen[2] as unknown[])[2], { resultPath: "notes/acme.md", summary: "Shipped 1.1.0.", analyzedVersion: "1.1.0" });
  const failed = await tool("scout_competitor_fail").run({ runId: 4, error: "mirror missing" }) as CompetitorRun;
  assert.equal(failed.error, "mirror missing");
  const reject = (run: () => unknown, pattern: RegExp) => assert.rejects(Promise.resolve().then(run), pattern);
  await reject(() => tool("scout_competitor_claim").run({ runId: 4 }), /by is required/);
  await reject(() => tool("scout_competitor_claim").run({ by: "Ada" }), /runId is required/);
  await reject(() => tool("scout_competitor_claim").run({ runId: 0, by: "Ada" }), /runId/);
  await reject(() => tool("scout_competitor_claim").run({ runId: 4, by: "a".repeat(81) }), /at most 80/);
  await reject(() => tool("scout_competitor_complete").run({ runId: 4, resultPath: "x", summary: "y".repeat(2001) }), /summary/);
  await reject(() => tool("scout_competitor_complete").run({ runId: 4, resultPath: "p".repeat(501), summary: "y" }), /resultPath/);
  await reject(() => tool("scout_competitor_complete").run({ runId: 4, resultPath: "x", summary: "y", analyzedVersion: "v".repeat(81) }), /analyzedVersion/);
  await reject(() => tool("scout_competitor_fail").run({ runId: 4, error: "e".repeat(501) }), /error/);
  await reject(() => tool("scout_competitor_fail").run({ runId: 4 }), /error is required/);
  assert.equal(seen.length, 4);
});
