import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAddChange, dossierStub, historyHold, HISTORY_MIN_DECISIONS, nearestWithCloseness, type Candidate, type OwnerDecision } from "../src/index.ts";

const decision = (verdict: "tracked" | "dismissed", id: string, summary: string, topics: string[] = []): OwnerDecision => ({ verdict, id, name: `Name ${id}`, summary, topics });

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: "github-acme-mapper", key: "github:acme/mapper", source: "github", name: "Mapper", org: "Acme", url: "https://github.com/acme/Mapper", repoUrl: "https://github.com/acme/Mapper.git",
  description: "Maps.", topics: ["vtt"], stars: 7, pushedAt: "2026-10-01T00:00:00Z", status: "tracked", score: 0.8, passedOver: false,
  judgement: { summary: "Draws battle maps.", overlaps: ["Map Maker"], competitor: 0.9, worthTracking: 0.8, needs: { competitor: 0.6, worthTracking: 0.4 } },
  foundAt: "2026-10-25T18:00:00.000Z", decidedAt: null, ...over,
});

test("the closest decisions on each side come back with their closeness, and a project is never its own example", () => {
  const decisions = [
    decision("tracked", "t1", "Draws battle maps for game masters."),
    decision("tracked", "t2", "Handles billing."),
    decision("dismissed", "d1", "Particle effects for scenes."),
    decision("dismissed", "d2", "Draws battle maps for tabletop."),
  ];
  const near = nearestWithCloseness("Draws battle maps for game masters.", [], decisions, 1);
  assert.deepEqual(near.map((item) => item.decision.id), ["t1", "d2"]);
  assert.equal(near[0]?.closeness, 1);
  assert.deepEqual(nearestWithCloseness("Draws battle maps for game masters.", [], decisions, 1, "t1").map((item) => item.decision.id), ["t2", "d2"]);
  assert.deepEqual(nearestWithCloseness("x", [], [], 3), []);
});

test("history holds a project back only with enough decisions and a clearly closer dismissed look-alike", () => {
  const near = (dismissed: number, tracked: number) => [
    { decision: decision("tracked", "t", "x"), closeness: tracked },
    { decision: decision("dismissed", "d", "y"), closeness: dismissed },
  ];
  assert.equal(historyHold(near(0.6, 0.1), HISTORY_MIN_DECISIONS - 1), null);
  assert.match(historyHold(near(0.6, 0.1), HISTORY_MIN_DECISIONS) ?? "", /Reads like Name d, which was dismissed \(60% alike\), and less like Name t, which was tracked \(10%\)/);
  assert.equal(historyHold(near(0.2, 0), HISTORY_MIN_DECISIONS), null);
  assert.equal(historyHold(near(0.5, 0.45), HISTORY_MIN_DECISIONS), null);
  assert.match(historyHold([{ decision: decision("dismissed", "d", "y"), closeness: 0.3 }], HISTORY_MIN_DECISIONS) ?? "", /^Reads like Name d, which was dismissed \(30% alike\)$/);
});

test("the dossier stub names its folder safely and carries the facts, the reason, and the next steps in plain ASCII", () => {
  const near = [{ decision: decision("tracked", "t1", "x"), closeness: 0.52 }];
  const { folder, text } = dossierStub(candidate({ name: "Mapper: “Pro”?", org: "Acme/Co" }), near, "2026-10-26T01:00:00.000Z");
  assert.equal(folder, "AcmeCo - Mapper Pro");
  assert.match(text, /^# Mapper: Pro\?$/m);
  assert.match(text, /- Repository: https:\/\/github.com\/acme\/Mapper.git/);
  assert.match(text, /- Found by Scout discovery on 2026-10-25 and tracked on 2026-10-26/);
  assert.match(text, /Draws battle maps\./);
  assert.match(text, /- Map Maker/);
  assert.match(text, /- Competitor 90%, worth tracking 80% \(the bars were 60% and 40%\)/);
  assert.match(text, /- Reads like Name t1, which was tracked \(52% alike\)/);
  assert.match(text, /- \[ \] Run the research for this competitor/);
  assert.equal(/[^\x20-\x7e\n]/.test(text), false);
  assert.equal(dossierStub(candidate({ org: null }), [], "2026-10-26T01:00:00.000Z").folder, "Mapper");
  assert.equal(dossierStub(candidate({ judgement: null, description: "A plain description." }), [], "2026-10-26T01:00:00.000Z").text.includes("A plain description."), true);
});

test("a new registry entry can carry the dossier folder", () => {
  const text = JSON.stringify({ dossierRoot: "d", mirrorRoot: "m", entries: [] });
  const next = JSON.parse(applyAddChange(text, { id: "a", name: "A", org: null, remoteUrl: null, packageUrl: null, dossierDir: "d/Acme - A" }));
  assert.equal(next.entries[0].dossierDir, "d/Acme - A");
  assert.equal(JSON.parse(applyAddChange(text, { id: "b", name: "B", org: null, remoteUrl: null, packageUrl: null })).entries[0].dossierDir, null);
});
