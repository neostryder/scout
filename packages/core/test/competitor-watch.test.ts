import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESEARCH_GATE, applyGateChange, applyRemoveChange, applyWatchChange, checkWatch, competitorNotice, competitorPaths, evaluateResearchGate, listCompetitors, openCatalog, parseCompetitorsFile, readGateSettings, seedWatchBaseline, startPullingRun, syncCompetitors, watchHostAllowed, type CompetitorIdentity, type ResearchDelta, type ResearchGateConfig } from "../src/index.ts";

const NOW = "2026-05-20T12:00:00.000Z";

function gate(over: Partial<ResearchGateConfig> = {}): ResearchGateConfig {
  return { ...DEFAULT_RESEARCH_GATE, queuedRuns: 0, ...over };
}

function delta(over: Partial<ResearchDelta> = {}): ResearchDelta {
  return { commits: 0, sourceFilesChanged: 0, newStableTag: false, docsOnly: false, dependencyBumpOnly: false, lastCommitAt: null, ...over };
}

function entry(over: Partial<CompetitorIdentity> = {}): CompetitorIdentity {
  return {
    id: "solo-tool", name: "Solo Tool", org: null, remoteUrl: null, mirrorPath: null, packageUrl: null, dossierDir: null, dossierReviewed: null,
    flags: [], baseline: null, watch: { kind: "json", url: "https://example.com/api/solo.json", versionPath: "version" }, ...over,
  };
}

test("a watch source must be a public https address with a usable version rule", () => {
  assert.equal(checkWatch({ kind: "json", url: "https://example.com/a.json", versionPath: "data.0.version" }).ok, true);
  assert.equal(checkWatch({ kind: "page", url: "https://example.com/changelog", versionPattern: "Release (\\d+\\.\\d+)" }).ok, true);
  assert.equal(checkWatch({ kind: "hash", url: "https://example.com/pricing" }).ok, true);
  const bad = (value: unknown): string => {
    const result = checkWatch(value);
    assert.equal(result.ok, false);
    return result.ok ? "" : result.error;
  };
  assert.match(bad({ kind: "json", url: "http://example.com/a.json", versionPath: "v" }), /https/);
  assert.match(bad({ kind: "json", url: "https://user:pw@example.com/a.json", versionPath: "v" }), /credentials/);
  assert.match(bad({ kind: "json", url: "https://localhost/a.json", versionPath: "v" }), /public host/);
  assert.match(bad({ kind: "json", url: "https://192.168.1.5/a.json", versionPath: "v" }), /public host/);
  assert.match(bad({ kind: "json", url: "https://[::1]/a.json", versionPath: "v" }), /public host/);
  assert.match(bad({ kind: "json", url: "https://example.com/a.json" }), /versionPath/);
  assert.match(bad({ kind: "page", url: "https://example.com/c", versionPattern: "(" }), /valid/);
  assert.match(bad({ kind: "page", url: "https://example.com/c", versionPattern: "no group" }), /capture group/);
  assert.match(bad({ kind: "page", url: "https://example.com/c", versionPattern: "(a)(b)" }), /capture group/);
  assert.match(bad({ kind: "feed", url: "https://example.com/c" }), /kind/);
  assert.match(bad({ kind: "hash", url: "https://example.com/c", extra: 1 }), /unknown watch field/);
  assert.equal(watchHostAllowed("example.com"), true);
  assert.equal(watchHostAllowed("printer.local"), false);
  assert.equal(watchHostAllowed("intranet"), false);
});

test("the registry keeps a valid watch and drops an invalid one", () => {
  const file = parseCompetitorsFile(JSON.stringify({
    dossierRoot: "d", mirrorRoot: "m",
    entries: [
      { id: "a", name: "A", watch: { kind: "hash", url: "https://example.com/p" } },
      { id: "b", name: "B", watch: { kind: "hash", url: "http://example.com/p" } },
      { id: "c", name: "C" },
    ],
  }));
  assert.deepEqual(file.entries.map((item) => item.watch), [{ kind: "hash", url: "https://example.com/p" }, null, null]);
});

test("a watched competitor syncs, seeds its first reading as the baseline, and can be updated by hand", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [entry()]);
  const row = () => listCompetitors(db, NOW)[0]!;
  assert.deepEqual(row().watch, { kind: "json", url: "https://example.com/api/solo.json", versionPath: "version" });
  assert.equal(row().status, "unknown");
  assert.equal(seedWatchBaseline(db, "solo-tool", { version: "2.0.0", commit: null }, NOW), true);
  assert.deepEqual(row().baseline, { version: "2.0.0", commit: null, at: NOW, source: "watch" });
  assert.equal(seedWatchBaseline(db, "solo-tool", { version: "3.0.0", commit: null }, NOW), false);
  assert.equal(competitorPaths(db, "solo-tool")?.watch?.kind, "json");
  assert.equal(startPullingRun(db, "solo-tool", NOW).state, "pulling");
  db.close();
});

test("a competitor with neither a mirror nor a watch source cannot be updated", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [entry({ watch: null })]);
  assert.throws(() => startPullingRun(db, "solo-tool", NOW), /no mirror/);
  assert.equal(seedWatchBaseline(db, "solo-tool", { version: "1.0.0", commit: null }, NOW), false);
  db.close();
});

test("removing a watch from the registry clears it from the row", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [entry()]);
  syncCompetitors(db, [entry({ watch: null })]);
  assert.equal(listCompetitors(db, NOW)[0]?.watch, null);
  db.close();
});

test("a version found by a watch uses the tag path of the gate, and a changed page without a version waits", () => {
  const versioned = { baseline: { commit: null, version: "1.0.0" }, watch: { kind: "json" } };
  const based = { baseline: { commit: "page:0123456789abcdef", version: null }, watch: { kind: "hash" } };
  assert.equal(evaluateResearchGate(versioned, delta({ newStableTag: true }), gate(), NOW).reason, "new stable tag");
  assert.equal(evaluateResearchGate({ baseline: { commit: null, version: "1.0.0" } }, delta({ newStableTag: true }), gate(), NOW).reason, "no baseline");
  assert.equal(evaluateResearchGate({ baseline: { commit: null, version: null }, watch: { kind: "json" } }, delta({ newStableTag: true }), gate(), NOW).reason, "no baseline");
  assert.equal(evaluateResearchGate(based, delta({ newStableTag: true }), gate(), NOW).reason, "new stable tag");
  const waiting = evaluateResearchGate(based, delta({ pageChanged: true }), gate(), NOW);
  assert.equal(waiting.decision, "wait");
  assert.match(waiting.reason, /watched page changed/);
  assert.equal(evaluateResearchGate(based, delta({ pageChanged: true }), gate({ enabled: false }), NOW).decision, "skip");
});

test("a page change reads as a page change in the notice", () => {
  assert.equal(competitorNotice("Solo Tool", "page:0123456789abcdef", "page:fedcba9876543210"), "Solo Tool: the watched page changed since the last analysis");
  assert.equal(competitorNotice("Solo Tool", "2.1.0", "2.0.0"), "Solo Tool: new version 2.1.0 since the last analysis (2.0.0)");
});

const FILE = JSON.stringify({
  dossierRoot: "d", mirrorRoot: "m", extra: { keep: true },
  entries: [{ id: "a", name: "A", flags: [] }, { id: "b", name: "B", gate: { minCommits: 9 } }],
});

test("the gate settings read back what the file sets", () => {
  const settings = readGateSettings(FILE);
  assert.deepEqual(settings.defaults, DEFAULT_RESEARCH_GATE);
  assert.deepEqual(settings.global, {});
  assert.deepEqual(settings.entries, [{ id: "b", name: "B", gate: { minCommits: 9 } }]);
});

test("a gate change edits the file-wide gate or one competitor and keeps the rest of the file", () => {
  const wide = applyGateChange(FILE, { set: { minCommits: 12, quietHours: 0, ignoreDocsOnly: false } });
  assert.deepEqual(JSON.parse(wide).gate, { minCommits: 12, quietHours: 0, ignoreDocsOnly: false });
  assert.deepEqual(JSON.parse(wide).extra, { keep: true });
  assert.ok(wide.endsWith("}\n"));
  const own = applyGateChange(wide, { id: "a", set: { maxQueued: 2 } });
  assert.deepEqual(JSON.parse(own).entries[0].gate, { maxQueued: 2 });
  const cleared = applyGateChange(own, { id: "a", clear: ["maxQueued"] });
  assert.equal("gate" in JSON.parse(cleared).entries[0], false);
  const dropped = applyGateChange(wide, { clear: ["minCommits", "quietHours", "ignoreDocsOnly"] });
  assert.equal("gate" in JSON.parse(dropped), false);
});

test("a gate change refuses unknown fields, wrong types, out-of-range numbers, and unknown competitors", () => {
  assert.throws(() => applyGateChange(FILE, { set: { nope: 1 } }), /unknown gate field/);
  assert.throws(() => applyGateChange(FILE, { set: { minCommits: "5" } }), /whole number/);
  assert.throws(() => applyGateChange(FILE, { set: { minCommits: -1 } }), /whole number/);
  assert.throws(() => applyGateChange(FILE, { set: { minCommits: 1.5 } }), /whole number/);
  assert.throws(() => applyGateChange(FILE, { set: { maxQueued: 0 } }), /from 1/);
  assert.throws(() => applyGateChange(FILE, { set: { enabled: "yes" } }), /true or false/);
  assert.throws(() => applyGateChange(FILE, { clear: ["nope"] }), /unknown gate field/);
  assert.throws(() => applyGateChange(FILE, { id: "zzz", set: { minCommits: 1 } }), /unknown competitor/);
});

test("a watch change sets, replaces, and removes one competitor's source", () => {
  const set = applyWatchChange(FILE, "a", { kind: "hash", url: "https://example.com/p" });
  assert.deepEqual(JSON.parse(set).entries[0].watch, { kind: "hash", url: "https://example.com/p" });
  const removed = applyWatchChange(set, "a", null);
  assert.equal("watch" in JSON.parse(removed).entries[0], false);
  assert.throws(() => applyWatchChange(FILE, "a", { kind: "hash", url: "http://example.com/p" }), /https/);
  assert.throws(() => applyWatchChange(FILE, "zzz", null), /unknown competitor/);
});

test("a removal drops one entry and leaves the others", () => {
  const next = JSON.parse(applyRemoveChange(FILE, "a"));
  assert.equal(next.entries.some((item: { id: string }) => item.id === "a"), false);
  assert.equal(next.entries.length, JSON.parse(FILE).entries.length - 1);
  assert.throws(() => applyRemoveChange(FILE, "zzz"), /unknown competitor/);
});
