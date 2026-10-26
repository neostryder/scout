import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAddChange, listCompetitors, openCatalog, parseCompetitorsFile, saveCandidate, setCandidateStatus, syncCompetitors, type CompetitorIdentity } from "../src/index.ts";

const entry = (id: string, patch: Partial<CompetitorIdentity> = {}): CompetitorIdentity => ({
  id, name: id, org: null, remoteUrl: `https://github.com/example/${id}`, mirrorPath: null, packageUrl: null, dossierDir: null, dossierReviewed: null, flags: [],
  baseline: { version: "1.0.0", commit: null, at: "2026-05-04", source: "mirror" }, ...patch,
});

const source = (key: string) => ({ key, source: "github" as const, name: key, org: "Example", url: `https://github.com/${key}`, repoUrl: `https://github.com/${key}.git`, description: "Plain description.", topics: ["rpg", "npc"], stars: 5, pushedAt: null });

test("a competitor tracked from a candidate takes its date and batch, and the original list keeps its baseline date", () => {
  const db = openCatalog(":memory:");
  saveCandidate(db, source("github:example/found-one"), { summary: "Makes NPCs for game masters.", overlaps: [], competitor: 0.9, worthTracking: 0.5 }, 0.8, "2026-10-25T19:39:42.021Z");
  setCandidateStatus(db, "github-example-found-one", "tracked", "2026-10-25T20:10:00.000Z");
  syncCompetitors(db, [entry("github-example-found-one"), entry("old-one")]);
  const rows = Object.fromEntries(listCompetitors(db).map((row) => [row.id, row]));
  assert.equal(rows["github-example-found-one"]?.addedAt, "2026-10-25T20:10:00.000Z");
  assert.equal(rows["github-example-found-one"]?.batch, "2026-10-25T19:39:42.021Z");
  assert.equal(rows["github-example-found-one"]?.about, "Makes NPCs for game masters.");
  assert.deepEqual(rows["github-example-found-one"]?.topics, ["rpg", "npc"]);
  assert.equal(rows["old-one"]?.addedAt, "2026-05-04");
  assert.equal(rows["old-one"]?.batch, null);
  assert.equal(rows["old-one"]?.about, null);
  assert.deepEqual(rows["old-one"]?.topics, []);
});

test("values the registry already carries are kept, and a later sync does not erase them", () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [entry("kept", { addedAt: "2026-09-01T00:00:00.000Z", batch: "2026-09-01T00:00:00.000Z" })]);
  syncCompetitors(db, [entry("kept")]);
  const row = listCompetitors(db)[0];
  assert.equal(row?.addedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(row?.batch, "2026-09-01T00:00:00.000Z");
});

test("adding a competitor from a candidate writes the date and batch into the registry file", () => {
  const text = JSON.stringify({ dossierRoot: "d", mirrorRoot: "m", entries: [] });
  const next = applyAddChange(text, { id: "x", name: "X", org: null, remoteUrl: "https://github.com/example/x", packageUrl: null, addedAt: "2026-10-25T20:10:00.000Z", batch: "2026-10-25T19:39:42.021Z" });
  const parsed = parseCompetitorsFile(next).entries[0];
  assert.equal(parsed?.addedAt, "2026-10-25T20:10:00.000Z");
  assert.equal(parsed?.batch, "2026-10-25T19:39:42.021Z");
  const plain = parseCompetitorsFile(applyAddChange(text, { id: "y", name: "Y", org: null, remoteUrl: null, packageUrl: null })).entries[0];
  assert.equal(plain?.addedAt, null);
  assert.equal(plain?.batch, null);
});
