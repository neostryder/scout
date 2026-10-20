import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_RESEARCH_GATE, countOpenResearch, enqueueAutoRun, evaluateResearchGate, listCompetitors, openCatalog, parseCompetitorsFile, resolveResearchGate, setCompetitorPending, startPullingRun, syncCompetitors, type CompetitorIdentity, type ResearchDelta, type ResearchGateConfig } from "../src/index.ts";

const NOW = "2026-05-20T12:00:00.000Z";
const OLD = "2026-05-18T12:00:00.000Z";
const FRESH = "2026-05-20T11:00:00.000Z";

function gate(over: Partial<ResearchGateConfig> = {}): ResearchGateConfig {
  return { ...DEFAULT_RESEARCH_GATE, queuedRuns: 0, ...over };
}

function delta(over: Partial<ResearchDelta> = {}): ResearchDelta {
  return { commits: 6, sourceFilesChanged: 4, newStableTag: false, docsOnly: false, dependencyBumpOnly: false, lastCommitAt: OLD, ...over };
}

const ready = { baseline: { commit: "abc" } };
const unbased = { baseline: { commit: null } };

function identity(): CompetitorIdentity {
  return {
    id: "acme-tools", name: "Acme Tools", org: "Acme", remoteUrl: "https://github.com/example/acme-tools",
    mirrorPath: "C:/mirrors/acme-tools", packageUrl: null, dossierDir: null, dossierReviewed: null, flags: [],
    baseline: { version: "1.0.0", commit: "aaa111", at: NOW, source: "mirror" },
  };
}

test("the research gate queues, waits, and skips", () => {
  assert.equal(evaluateResearchGate(ready, delta({ newStableTag: true }), gate({ enabled: false }), NOW).reason, "gate is off");
  assert.equal(evaluateResearchGate(unbased, delta({ newStableTag: true }), gate(), NOW).reason, "no baseline");
  assert.equal(evaluateResearchGate(ready, delta({ newStableTag: true, commits: 0, sourceFilesChanged: 0, docsOnly: true, dependencyBumpOnly: true, lastCommitAt: FRESH }), gate(), NOW).decision, "queue");
  assert.equal(evaluateResearchGate(ready, delta({ newStableTag: true, commits: 0, lastCommitAt: FRESH }), gate(), NOW).reason, "new stable tag");
  assert.equal(evaluateResearchGate(ready, delta({ newStableTag: true }), gate({ queuedRuns: 5 }), NOW).reason, "the research queue is full");
  assert.equal(evaluateResearchGate(ready, delta({ newStableTag: true, docsOnly: true }), gate({ onNewTag: false }), NOW).decision, "skip");
  assert.equal(evaluateResearchGate(ready, delta({ docsOnly: true }), gate(), NOW).reason, "docs only");
  assert.equal(evaluateResearchGate(ready, delta({ dependencyBumpOnly: true }), gate(), NOW).reason, "dependency bump only");
  assert.equal(evaluateResearchGate(ready, delta({ docsOnly: true }), gate({ ignoreDocsOnly: false }), NOW).decision, "queue");
  assert.equal(evaluateResearchGate(ready, delta({ commits: 0, sourceFilesChanged: 0 }), gate(), NOW).reason, "nothing new");
  const below = evaluateResearchGate(ready, delta({ commits: 4, sourceFilesChanged: 2 }), gate(), NOW);
  assert.equal(below.decision, "wait");
  assert.equal(below.reason, "4 commits, below the threshold of 5");
  assert.deepEqual(below.pending, { commits: 4, sourceFilesChanged: 2 });
  assert.equal(evaluateResearchGate(ready, delta({ commits: 4, sourceFilesChanged: 3 }), gate(), NOW).reason, "3 source files changed");
  assert.equal(evaluateResearchGate(ready, delta({ commits: 0, sourceFilesChanged: 3 }), gate(), NOW).reason, "3 source files changed");
  assert.equal(evaluateResearchGate(ready, delta({ lastCommitAt: FRESH }), gate(), NOW).reason, "the last commit is under 24 hours old");
  assert.equal(evaluateResearchGate(ready, delta({ lastCommitAt: null }), gate(), NOW).reason, "the last commit is under 24 hours old");
  assert.equal(evaluateResearchGate(ready, delta({ lastCommitAt: "nope" }), gate(), NOW).reason, "the last commit is under 24 hours old");
  assert.equal(evaluateResearchGate(ready, delta({ lastCommitAt: FRESH }), gate({ quietHours: 0 }), NOW).reason, "6 commits");
  assert.equal(evaluateResearchGate(ready, delta(), gate({ queuedRuns: 5 }), NOW).reason, "the research queue is full");
  assert.equal(evaluateResearchGate(ready, delta({ sourceFilesChanged: 0 }), gate(), NOW).reason, "6 commits");
  const overridden = resolveResearchGate({ minCommits: 9, quietHours: 1.5 }, { minCommits: 1 }, 4);
  assert.equal(overridden.minCommits, 1);
  assert.equal(overridden.quietHours, 24);
  assert.equal(overridden.queuedRuns, 4);
  assert.equal(evaluateResearchGate(ready, delta({ commits: 1, sourceFilesChanged: 0 }), overridden, NOW).reason, "1 commits");
});

test("a file gate replaces single fields and drops values that are not usable", () => {
  const parsed = parseCompetitorsFile(JSON.stringify({
    dossierRoot: "C:/dossiers",
    mirrorRoot: "C:/mirrors",
    gate: { minCommits: -1, quietHours: 1.5, onNewTag: "yes", maxQueued: 2, extra: true },
    entries: [{ ...identity(), gate: { minCommits: 8, enabled: false } }],
  }));
  const gate = parsed.gate;
  assert.ok(gate);
  assert.equal(gate.minCommits, undefined);
  assert.equal(gate.maxQueued, 2);
  assert.equal(gate.onNewTag, undefined);
  assert.equal(parsed.entries[0]?.gate?.minCommits, 8);
  assert.equal(parsed.entries[0]?.gate?.enabled, false);
  const resolved = resolveResearchGate(parsed.gate, parsed.entries[0]?.gate, 1);
  assert.equal(resolved.minCommits, 8);
  assert.equal(resolved.maxQueued, 2);
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.onNewTag, true);
});

test("an automatic run stores trigger auto and clears a pending note", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity()]);
  setCompetitorPending(db, "acme-tools", { commits: 2, sourceFilesChanged: 0, reason: "2 commits, below the threshold of 5" });
  assert.equal(listCompetitors(db, NOW)[0]?.pending?.commits, 2);
  const run = enqueueAutoRun(db, "acme-tools", { toVersion: "1.1.0", toCommit: "bbb222", request: { analysis: { baseline: "none" } } }, NOW);
  assert.equal(run.trigger, "auto");
  assert.equal(run.state, "queued");
  assert.equal(listCompetitors(db, NOW)[0]?.pending, null);
  assert.equal(countOpenResearch(db), 1);
  assert.throws(() => enqueueAutoRun(db, "acme-tools", { toVersion: null, toCommit: null, request: {} }, NOW), /already active/);
  db.close();
});

test("a manual update stores trigger manual and clears a pending note", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity()]);
  setCompetitorPending(db, "acme-tools", { commits: 2, sourceFilesChanged: 1, reason: "2 commits, below the threshold of 5" });
  const run = startPullingRun(db, "acme-tools", NOW);
  assert.equal(run.trigger, "manual");
  assert.equal(listCompetitors(db, NOW)[0]?.pending, null);
  db.close();
});

test("a catalog created before mirror sync gains the new columns and keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-migrate-"));
  const path = join(dir, "catalog.db");
  const first = new DatabaseSync(path);
  first.exec(`CREATE TABLE competitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    org TEXT,
    remote_url TEXT,
    mirror_path TEXT,
    package_url TEXT,
    dossier_dir TEXT,
    dossier_reviewed TEXT,
    flags_json TEXT NOT NULL DEFAULT '[]',
    baseline_version TEXT,
    baseline_commit TEXT,
    baseline_at TEXT,
    baseline_source TEXT,
    latest_version TEXT,
    latest_prerelease TEXT,
    latest_commit TEXT,
    latest_checked_at TEXT,
    latest_error TEXT,
    notified_version TEXT
  )`);
  first.exec(`CREATE TABLE competitor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id TEXT NOT NULL REFERENCES competitors(id),
    state TEXT NOT NULL CHECK (state IN ('pulling','queued','claimed','done','failed')),
    from_version TEXT,
    from_commit TEXT,
    to_version TEXT,
    to_commit TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_by TEXT,
    result_path TEXT,
    summary TEXT,
    error TEXT,
    request_json TEXT
  )`);
  first.prepare("INSERT INTO competitors (id, name, baseline_version) VALUES (?, ?, ?)").run("acme-tools", "Acme Tools", "1.0.0");
  first.prepare("INSERT INTO competitor_runs (competitor_id, state, requested_at, updated_at) VALUES (?, 'done', ?, ?)").run("acme-tools", NOW, NOW);
  first.close();
  const second = openCatalog(path);
  const columns = (second.prepare("PRAGMA table_info(competitors)").all() as { name: string }[]).map((column) => column.name);
  for (const name of ["synced_at", "sync_error", "sync_head", "pending_json"]) assert.equal(columns.includes(name), true, name);
  const runColumns = (second.prepare("PRAGMA table_info(competitor_runs)").all() as { name: string }[]).map((column) => column.name);
  assert.equal(runColumns.includes("trigger"), true);
  const row = second.prepare("SELECT name, baseline_version AS version, synced_at AS at, sync_head AS head, pending_json AS pending FROM competitors WHERE id = ?").get("acme-tools") as { name: string; version: string; at: string | null; head: string | null; pending: string | null };
  assert.equal(row.name, "Acme Tools");
  assert.equal(row.version, "1.0.0");
  assert.equal(row.at, null);
  assert.equal(row.head, null);
  assert.equal(row.pending, null);
  assert.equal((second.prepare("SELECT trigger FROM competitor_runs").get() as { trigger: string | null }).trigger, null);
  second.close();
  const fresh = openCatalog(":memory:");
  const freshColumns = (fresh.prepare("PRAGMA table_info(competitors)").all() as { name: string }[]).map((column) => column.name);
  assert.equal(freshColumns.includes("sync_head"), true);
  assert.equal((fresh.prepare("PRAGMA table_info(competitor_runs)").all() as { name: string }[]).some((column) => column.name === "trigger"), true);
  fresh.close();
  rmSync(dir, { recursive: true, force: true });
});
