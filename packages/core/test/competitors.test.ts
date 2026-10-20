import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCompetitorCheck, claimCompetitorRun, completeCompetitorRun, deriveCompetitorStatus, failCompetitorRun, listCompetitorRuns, listCompetitors, markCompetitorNotified, openCatalog, parseCompetitorsFile, queueCompetitorRun, startPullingRun, syncCompetitors, type CompetitorIdentity, type StatusInput } from "../src/index.ts";

const NOW = "2026-05-20T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

function identity(patch: Partial<CompetitorIdentity> = {}): CompetitorIdentity {
  return {
    id: "acme-tools",
    name: "Acme Tools",
    org: "Acme",
    remoteUrl: "https://github.com/example/acme-tools",
    mirrorPath: "C:/mirrors/acme-tools",
    packageUrl: "https://example.test/packages/acme",
    dossierDir: null,
    dossierReviewed: "2026-05-05",
    flags: ["forge", "nope"],
    baseline: { version: "1.0.0", commit: "aaa111", at: "2026-05-05", source: "mirror" },
    ...patch,
  };
}

function blank(patch: Partial<StatusInput> = {}): StatusInput {
  return { baselineVersion: null, baselineCommit: null, latestVersion: null, latestCommit: null, checkedAt: null, error: null, ...patch };
}

test("status derivation covers a missing baseline, a failed check, a newer version, and a commit move", () => {
  assert.deepEqual(deriveCompetitorStatus(blank()), { status: "unknown", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "1.0.0", baselineCommit: "aaa" })), { status: "unknown", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "1.0.0", baselineCommit: "aaa", checkedAt: NOW, error: "timed out" })), { status: "unknown", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "1.0.0", baselineCommit: "aaa", latestVersion: "1.2.0", latestCommit: "bbb", checkedAt: NOW })), { status: "new", newBasis: "version" });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "1.2.0", baselineCommit: "aaa", latestVersion: "1.2.0", latestCommit: "bbb", checkedAt: NOW })), { status: "current", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "2.0.0", baselineCommit: "aaa", latestVersion: "1.2.0", latestCommit: "bbb", checkedAt: NOW })), { status: "current", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineCommit: "aaa", latestCommit: "bbb", checkedAt: NOW })), { status: "new", newBasis: "commits" });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineCommit: "aaa", latestCommit: "aaa", checkedAt: NOW })), { status: "current", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "1.0.0", baselineCommit: "aaa", latestVersion: "1.0.0", latestCommit: "bbb", checkedAt: NOW })), { status: "current", newBasis: null });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "1.0.0", baselineCommit: "aaa", latestVersion: "1.2.0", latestCommit: "bbb", checkedAt: NOW, error: "timed out" })), { status: "new", newBasis: "version" });
  assert.deepEqual(deriveCompetitorStatus(blank({ baselineVersion: "build", baselineCommit: "aaa", latestVersion: "other", latestCommit: "bbb", checkedAt: NOW })), { status: "new", newBasis: "commits" });
});

test("the registry sync keeps a stored baseline, drops unknown flags, and removes an idle row", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity(), identity({ id: "other-tool", name: "Other Tool", remoteUrl: "https://github.com/example/other-tool" })]);
  completeCompetitorRun(db, queueCompetitorRun(db, startPullingRun(db, "acme-tools", NOW).id, { toVersion: "1.0.0", toCommit: "aaa111", request: { note: "seed" } }, NOW).id, { resultPath: "result.md", summary: "done", analyzedVersion: "9.9.9" }, NOW);
  syncCompetitors(db, [identity({ name: "Acme Renamed", flags: ["vault", "made-up"], baseline: { version: "0.1.0", commit: "zzz", at: "2026-01-01", source: "mirror" } })]);
  const row = db.prepare("SELECT name, flags_json AS flags, baseline_version AS version, baseline_source AS source FROM competitors WHERE id = ?").get("acme-tools") as { name: string; flags: string; version: string; source: string };
  assert.equal(row.name, "Acme Renamed");
  assert.deepEqual(JSON.parse(row.flags), ["vault"]);
  assert.equal(row.version, "9.9.9");
  assert.equal(row.source, "analysis");
  assert.equal(db.prepare("SELECT id FROM competitors WHERE id = 'other-tool'").get(), undefined);
  db.close();
});

test("a competitor keeps its row while a run is active, and the list sorts new versions first", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [
    identity(),
    identity({ id: "bravo", name: "Bravo", remoteUrl: "https://github.com/example/bravo", mirrorPath: "C:/mirrors/bravo", baseline: { version: "1.0.0", commit: "bbb", at: "2026-05-01", source: "mirror" } }),
    identity({ id: "alpha", name: "Alpha", remoteUrl: "https://github.com/example/alpha", mirrorPath: "C:/mirrors/alpha", baseline: { version: "3.0.0", commit: "ddd", at: "2026-05-01", source: "mirror" } }),
  ]);
  const pulling = startPullingRun(db, "acme-tools", NOW);
  syncCompetitors(db, [
    identity({ id: "bravo", name: "Bravo", remoteUrl: "https://github.com/example/bravo", mirrorPath: "C:/mirrors/bravo", baseline: { version: "1.0.0", commit: "bbb", at: "2026-05-01", source: "mirror" } }),
    identity({ id: "alpha", name: "Alpha", remoteUrl: "https://github.com/example/alpha", mirrorPath: "C:/mirrors/alpha", baseline: { version: "3.0.0", commit: "ddd", at: "2026-05-01", source: "mirror" } }),
  ]);
  assert.equal((db.prepare("SELECT id FROM competitors WHERE id = 'acme-tools'").get() as { id: string }).id, "acme-tools");
  failCompetitorRun(db, pulling.id, "stopped", NOW);
  syncCompetitors(db, [
    identity({ id: "bravo", name: "Bravo", remoteUrl: "https://github.com/example/bravo", mirrorPath: "C:/mirrors/bravo" }),
    identity({ id: "alpha", name: "Alpha", remoteUrl: "https://github.com/example/alpha", mirrorPath: "C:/mirrors/alpha" }),
  ]);
  assert.equal(db.prepare("SELECT id FROM competitors WHERE id = 'acme-tools'").get(), undefined);
  applyCompetitorCheck(db, "bravo", { version: "2.0.0", prerelease: "2.1.0-rc.1", commit: "ccc", error: null }, NOW);
  applyCompetitorCheck(db, "alpha", { version: "3.0.0", prerelease: null, commit: "ddd", error: null }, NOW);
  const names = listCompetitors(db, NOW).map((row) => [row.name, row.status]);
  assert.deepEqual(names, [["Bravo", "new"], ["Alpha", "current"]]);
  assert.equal(listCompetitors(db, NOW)[0]?.status, "new");
  assert.equal(listCompetitors(db, NOW)[0]?.newBasis, "version");
  assert.equal(listCompetitors(db, NOW)[0]?.latest.prerelease, "2.1.0-rc.1");
  db.close();
});

test("one competitor has one active run, and complete moves the baseline while fail leaves it", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity()]);
  const first = startPullingRun(db, "acme-tools", NOW);
  assert.equal(first.state, "pulling");
  assert.throws(() => startPullingRun(db, "acme-tools", NOW), /already active/);
  assert.throws(() => claimCompetitorRun(db, first.id, "researcher", NOW), /not queued/);
  const queued = queueCompetitorRun(db, first.id, { toVersion: "1.1.0", toCommit: "def456", request: { commits: [] } }, NOW);
  assert.equal(queued.request?.["commits"] instanceof Array, true);
  assert.throws(() => startPullingRun(db, "acme-tools", NOW), /already active/);
  const claimed = claimCompetitorRun(db, queued.id, "researcher", "2026-05-21T00:00:00.000Z");
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.claimedBy, "researcher");
  assert.throws(() => claimCompetitorRun(db, queued.id, "other", NOW), /not queued/);
  const done = completeCompetitorRun(db, claimed.id, { resultPath: "notes.md", summary: "shipped", analyzedVersion: "1.1.0" }, "2026-05-22T00:00:00.000Z");
  assert.equal(done.state, "done");
  const baseline = db.prepare("SELECT baseline_version AS version, baseline_commit AS head, baseline_source AS source FROM competitors WHERE id = 'acme-tools'").get() as { version: string; head: string; source: string };
  assert.equal(baseline.version, "1.1.0");
  assert.equal(baseline.head, "def456");
  assert.equal(baseline.source, "analysis");
  const again = startPullingRun(db, "acme-tools", NOW);
  failCompetitorRun(db, again.id, "mirror has uncommitted changes", NOW);
  const after = db.prepare("SELECT baseline_version AS version FROM competitors WHERE id = 'acme-tools'").get() as { version: string };
  assert.equal(after.version, "1.1.0");
  assert.throws(() => failCompetitorRun(db, again.id, "again", NOW), /not active/);
  assert.throws(() => completeCompetitorRun(db, 99, { resultPath: "x", summary: "y" }, NOW), /no such run/);
  db.close();
});

test("a queued run can be completed without a claim, and a run older than 14 days is stale", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity()]);
  const queued = queueCompetitorRun(db, startPullingRun(db, "acme-tools", NOW).id, { toVersion: "1.2.0", toCommit: "eee", request: { ok: true } }, NOW);
  const old = new Date(Date.parse(NOW) + 14 * DAY + 1000).toISOString();
  const runs = listCompetitorRuns(db, ["queued"], old);
  assert.equal(runs[0]?.stale, true);
  assert.equal(listCompetitorRuns(db, ["queued"], NOW)[0]?.stale, false);
  assert.equal(listCompetitorRuns(db, ["pulling"], old)[0], undefined);
  const done = completeCompetitorRun(db, queued.id, { resultPath: "out.md", summary: "from the queue" }, old);
  assert.equal(done.state, "done");
  assert.equal(done.stale, false);
  const version = (db.prepare("SELECT baseline_version AS version FROM competitors WHERE id = 'acme-tools'").get() as { version: string }).version;
  assert.equal(version, "1.2.0");
  db.close();
});

test("a check alerts once per version and a credential in the remote does not reach the list", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity({ remoteUrl: "https://user:secret@github.com/example/acme-tools" })]);
  const first = applyCompetitorCheck(db, "acme-tools", { version: "1.1.0", prerelease: null, commit: "bbb", error: null }, NOW);
  assert.equal(first.notice, "Acme Tools: new version 1.1.0 since the last analysis (1.0.0)");
  assert.equal(first.notice?.includes("secret"), false);
  markCompetitorNotified(db, "acme-tools", first.notified ?? "");
  const repeat = applyCompetitorCheck(db, "acme-tools", { version: "1.1.0", prerelease: null, commit: "bbb", error: null }, NOW);
  assert.equal(repeat.notice, null);
  const next = applyCompetitorCheck(db, "acme-tools", { version: "1.2.0", prerelease: null, commit: "ccc", error: null }, NOW);
  assert.equal(next.notice, "Acme Tools: new version 1.2.0 since the last analysis (1.0.0)");
  const failed = applyCompetitorCheck(db, "acme-tools", { version: null, prerelease: null, commit: null, error: "timed out" }, NOW);
  assert.equal(failed.notice, null);
  assert.equal(listCompetitors(db, NOW)[0]?.latest.version, "1.2.0");
  assert.equal(listCompetitors(db, NOW)[0]?.latest.error, "timed out");
  assert.equal(listCompetitors(db, NOW)[0]?.remoteUrl, "https://github.com/example/acme-tools");
  db.close();
});

test("a competitors file parses the registry shape and rejects a list", () => {
  const parsed = parseCompetitorsFile(JSON.stringify({ dossierRoot: "C:/dossiers", mirrorRoot: "C:/mirrors", entries: [identity()] }));
  assert.equal(parsed.entries[0]?.flags[0], "forge");
  assert.equal(parsed.entries[0]?.flags.includes("nope"), false);
  assert.throws(() => parseCompetitorsFile("[]"), /object/);
});

test("competitor source does not hard-code a home-directory mirror path", () => {
  const files = [
    "packages/core/src/competitors.ts",
    "packages/ops/src/competitor-git.ts",
    "packages/ops/src/competitor-analysis.ts",
    "packages/cli/src/competitors.ts",
    "packages/hub/src/competitor-schedule.ts",
    "packages/hub/src/competitors-api.ts",
  ];
  const root = join(import.meta.dirname, "../../..");
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    assert.equal(/[A-Za-z]:\\Users\\/.test(text), false, file);
    assert.equal(/[A-Za-z]:\/Users\//.test(text), false, file);
    assert.equal(/\/Users\/[A-Za-z0-9._-]+\//.test(text), false, file);
    assert.equal(/\/home\/[A-Za-z0-9._-]+\//.test(text), false, file);
  }
});

