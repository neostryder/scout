import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, rememberPassedOver, saveCandidate, setCandidateStatus, type CandidateJudgement, type CandidateSource, type OutageNotice } from "@scout/core";
import { CompetitorSchedule } from "../src/competitor-schedule.ts";
import { DiscoverySchedule, DISCOVERY_INTERVAL_MS, type DiscoveryRunResult } from "../src/discovery-schedule.ts";
import { createHub } from "../src/server.ts";

const NOW = "2026-10-25T00:00:00.000Z";
const result = (extra: Partial<DiscoveryRunResult> = {}): DiscoveryRunResult => ({ gathered: 5, judged: 3, offered: 1, rejected: 2, errors: 0, error: null, ...extra });
const source = (name: string): CandidateSource => ({ key: `github:acme/${name}`, source: "github", name, org: "acme", url: `https://github.com/acme/${name}`, repoUrl: `https://github.com/acme/${name}.git`, description: "Maps.", topics: ["vtt"], stars: 5, pushedAt: null });
const judgement: CandidateJudgement = { summary: "Draws maps.", overlaps: ["Map Maker"], competitor: 0.9, worthTracking: 0.8 };

function fakeClock(start: number) {
  let now = start;
  const timers: { at: number; run: () => void }[] = [];
  return {
    clock: { now: () => now, setTimeout: (run: () => void, ms: number) => { const timer = { at: now + ms, run }; timers.push(timer); return timer; }, clearTimeout: (timer: unknown) => { const at = timers.indexOf(timer as never); if (at >= 0) timers.splice(at, 1); } },
    advance: async (ms: number) => { now += ms; for (const timer of timers.filter((t) => t.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.run(); } await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test("discovery runs after the start delay, then weekly, and tells the owner when it found something", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-"));
  try {
    const { clock, advance } = fakeClock(Date.parse(NOW));
    const notices: OutageNotice[] = [];
    let runs = 0;
    const schedule = new DiscoverySchedule({ clock, path: join(dir, "state.json"), startDelayMs: 1000, tickMs: 3_600_000, run: async () => { runs += 1; return result(); }, notifier: { send: async (notice) => { notices.push(notice); } } });
    schedule.start();
    await advance(1000);
    assert.equal(runs, 1);
    assert.equal(notices[0]?.title, "Scout found possible competitors");
    await advance(3_600_000 * 24 * 3);
    assert.equal(runs, 1);
    await advance(DISCOVERY_INTERVAL_MS);
    assert.equal(runs, 2);
    schedule.stop();
    const restarted = new DiscoverySchedule({ clock, path: join(dir, "state.json"), run: async () => result() });
    assert.equal(restarted.status().lastResult?.offered, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run that cannot start is recorded and retried a week later, not every hour", async () => {
  const { clock, advance } = fakeClock(Date.parse(NOW));
  let runs = 0;
  const schedule = new DiscoverySchedule({ clock, startDelayMs: 1000, run: async () => { runs += 1; throw new Error("discovery.json is not in the data folder"); }, log: () => {} });
  schedule.start();
  await advance(1000);
  await advance(3_600_000 * 5);
  assert.equal(runs, 1);
  assert.equal(schedule.status().lastError, "discovery.json is not in the data folder");
  assert.equal(schedule.runNow().started, true);
});

async function hub(t: TestContext, options: Omit<Parameters<typeof createHub>[0], "webRoot">) {
  const server = createHub({ webRoot: t.name, control: false, health: false, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const port = (server.address() as AddressInfo).port;
  return (path: string, method = "GET", body?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }) } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => { let parsed: unknown; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("candidates are listed, tracked into the registry with a baseline, and dismissed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "competitors.json");
  writeFileSync(configPath, JSON.stringify({ dossierRoot: join(dir, "d"), mirrorRoot: join(dir, "m"), entries: [] }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  saveCandidate(db, source("Mapper"), judgement, 0.87, NOW);
  saveCandidate(db, source("Dice"), { ...judgement, competitor: 0.7 }, 0.7, NOW);
  const competitors = new CompetitorSchedule(db, { configPath, check: async () => ({ version: "2.1.0", prerelease: null, commit: "c".repeat(40), error: null }) });
  let started = 0;
  const discovery = new DiscoverySchedule({ run: async () => { started += 1; return result(); } });
  const call = await hub(t, { db, competitors, discovery });

  const listed = await call("/api/competitors/candidates");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.candidates.map((c: { name: string; status: string }) => [c.name, c.status]), [["Mapper", "new"], ["Dice", "new"]]);

  const tracked = await call("/api/competitors/candidates/github-acme-mapper/track", "POST", "{}");
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.status, "tracked");
  const file = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(file.entries.map((e: { id: string; remoteUrl: string; baseline: { version: string; source: string } }) => [e.id, e.remoteUrl, e.baseline.version, e.baseline.source]), [["github-acme-mapper", "https://github.com/acme/Mapper.git", "2.1.0", "tracked"]]);
  assert.equal((await call("/api/competitors/candidates/github-acme-mapper/track", "POST", "{}")).status, 409);

  assert.equal((await call("/api/competitors/candidates/github-acme-dice/dismiss", "POST", "{}")).body.status, "dismissed");
  assert.deepEqual((await call("/api/competitors/candidates")).body.candidates, []);
  assert.equal((await call("/api/competitors/candidates/nope/track", "POST", "{}")).status, 404);

  assert.equal((await call("/api/competitors/discover", "POST", "{}")).status, 202);
  assert.equal(started, 1);
  assert.equal((await call("/api/competitors/discover", "GET")).status, 405);
  assert.equal(existsSync(configPath), true);
});

test("without a discovery schedule the candidate list says so and discover answers 404", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const call = await hub(t, { db });
  assert.deepEqual((await call("/api/competitors/candidates")).body, { configured: false, discovery: null, candidates: [], passedOver: [], holds: { lastRun: null, all: { held: 0, rescued: 0 } } });
  assert.equal((await call("/api/competitors/discover", "POST", "{}")).status, 404);
});

test("tracking a candidate also mirrors it when a clone is available, and falls back to the remote when it is not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-mirror-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "competitors.json");
  const mirrorRoot = join(dir, "m");
  mkdirSync(mirrorRoot);
  writeFileSync(configPath, JSON.stringify({ dossierRoot: join(dir, "d"), mirrorRoot, entries: [] }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  saveCandidate(db, source("Mapper"), judgement, 0.87, NOW);
  saveCandidate(db, source("Huge"), judgement, 0.8, NOW);
  const clone = async (remote: string, folder: string) => {
    if (remote.includes("Huge")) return { ok: false as const, error: "the repository is 900 MB, over the 391 MB limit for an automatic mirror" };
    mkdirSync(join(mirrorRoot, folder, ".git"), { recursive: true });
    return { ok: true as const, head: "b".repeat(40) };
  };
  const competitors = new CompetitorSchedule(db, { configPath, clone, check: async () => ({ version: "2.1.0", prerelease: null, commit: "c".repeat(40), error: null }) });
  const call = await hub(t, { db, competitors });
  const mirrored = await call("/api/competitors/candidates/github-acme-mapper/track", "POST", "{}");
  assert.equal(mirrored.body.mirror, true);
  const huge = await call("/api/competitors/candidates/github-acme-huge/track", "POST", "{}");
  assert.equal(huge.body.mirror, false);
  assert.match(huge.body.mirrorNote, /over the 391 MB limit/);
  const entries = JSON.parse(readFileSync(configPath, "utf8")).entries as { id: string; mirrorPath: string | null; baseline: { commit: string; version: string } }[];
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.equal(byId["github-acme-mapper"]?.mirrorPath, join(mirrorRoot, "github-acme-mapper").replace(/\\/g, "/"));
  assert.equal(byId["github-acme-mapper"]?.baseline.commit, "b".repeat(40));
  assert.equal(byId["github-acme-mapper"]?.baseline.version, "2.1.0");
  assert.equal(byId["github-acme-huge"]?.mirrorPath ?? null, null);
  assert.equal(byId["github-acme-huge"]?.baseline.commit, "c".repeat(40));
});

test("a passed-over project is listed with its reasoning and can be tracked anyway, but not dismissed again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-passed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "competitors.json");
  writeFileSync(configPath, JSON.stringify({ dossierRoot: join(dir, "d"), mirrorRoot: join(dir, "m"), entries: [] }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  rememberPassedOver(db, source("Sheets"), { summary: "A character sheet.", overlaps: [], competitor: 0.2, worthTracking: 0.9, needs: { competitor: 0.6, worthTracking: 0.4 } }, 0.41, NOW);
  const competitors = new CompetitorSchedule(db, { configPath, check: async () => ({ version: "1.0.0", prerelease: null, commit: "d".repeat(40), error: null }) });
  const discovery = new DiscoverySchedule({ run: async () => result() });
  const call = await hub(t, { db, competitors, discovery });
  const listed = await call("/api/competitors/candidates");
  assert.deepEqual(listed.body.candidates, []);
  assert.deepEqual(listed.body.passedOver.map((c: { name: string; passedOver: boolean; judgement: { needs: { competitor: number } } }) => [c.name, c.passedOver, c.judgement.needs.competitor]), [["Sheets", true, 0.6]]);
  assert.equal((await call("/api/competitors/candidates/github-acme-sheets/dismiss", "POST", "{}")).status, 409);
  const rescued = await call("/api/competitors/candidates/github-acme-sheets/track", "POST", "{}");
  assert.equal(rescued.status, 200);
  assert.equal(rescued.body.status, "tracked");
  assert.deepEqual((await call("/api/competitors/candidates")).body.passedOver, []);
});

test("the candidate list says which earlier choices each project reads like, and tracking starts a dossier page", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-dossier-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "competitors.json");
  const dossierRoot = join(dir, "d");
  writeFileSync(configPath, JSON.stringify({ dossierRoot, mirrorRoot: join(dir, "m"), entries: [] }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  saveCandidate(db, source("Taken"), { ...judgement, summary: "Draws battle maps for game masters." }, 0.9, NOW);
  setCandidateStatus(db, "github-acme-taken", "tracked", NOW);
  saveCandidate(db, source("Binned"), { ...judgement, summary: "Particle effects for scenes." }, 0.9, NOW);
  setCandidateStatus(db, "github-acme-binned", "dismissed", NOW);
  saveCandidate(db, source("Mapper"), { ...judgement, summary: "Draws battle maps and dungeon maps for game masters." }, 0.87, NOW);
  const competitors = new CompetitorSchedule(db, { configPath, check: async () => ({ version: "2.1.0", prerelease: null, commit: "c".repeat(40), error: null }) });
  const call = await hub(t, { db, competitors, discovery: new DiscoverySchedule({ run: async () => result() }) });
  const listed = await call("/api/competitors/candidates");
  const mapper = listed.body.candidates[0] as { name: string; examples: { verdict: string; name: string; closeness: number }[] };
  assert.equal(mapper.name, "Mapper");
  assert.equal(mapper.examples[0]?.name, "Taken");
  assert.equal(mapper.examples[0]?.verdict, "tracked");
  assert.equal(mapper.examples.some((item) => item.name === "Mapper"), false);

  const tracked = await call("/api/competitors/candidates/github-acme-mapper/track", "POST", "{}");
  assert.equal(tracked.body.dossier, true);
  const dir2 = join(dossierRoot, "acme - Mapper");
  const page = readFileSync(join(dir2, "00_Overview.md"), "utf8");
  assert.match(page, /^# Mapper$/m);
  assert.match(page, /Reads like Taken, which was tracked/);
  assert.match(page, /- \[ \] Run the research for this competitor/);
  const entry = (JSON.parse(readFileSync(configPath, "utf8")).entries as { id: string; dossierDir: string }[]).find((item) => item.id === "github-acme-mapper");
  assert.equal(entry?.dossierDir, dir2.replace(/\\/g, "/"));
});

test("a dossier page that already exists is never overwritten", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-keep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "competitors.json");
  const dossierRoot = join(dir, "d");
  mkdirSync(join(dossierRoot, "acme - Mapper"), { recursive: true });
  writeFileSync(join(dossierRoot, "acme - Mapper", "00_Overview.md"), "hand written", "utf8");
  writeFileSync(configPath, JSON.stringify({ dossierRoot, mirrorRoot: join(dir, "m"), entries: [] }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  saveCandidate(db, source("Mapper"), judgement, 0.87, NOW);
  const competitors = new CompetitorSchedule(db, { configPath, check: async () => ({ version: "2.1.0", prerelease: null, commit: "c".repeat(40), error: null }) });
  const call = await hub(t, { db, competitors, discovery: new DiscoverySchedule({ run: async () => result() }) });
  assert.equal((await call("/api/competitors/candidates/github-acme-mapper/track", "POST", "{}")).status, 200);
  assert.equal(readFileSync(join(dossierRoot, "acme - Mapper", "00_Overview.md"), "utf8"), "hand written");
});

test("a project held back by history can be released into the offered list, the hold gauge counts it, and a tracked project's dossier can be read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-disc-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "competitors.json");
  const dossierRoot = join(dir, "d");
  writeFileSync(configPath, JSON.stringify({ dossierRoot, mirrorRoot: join(dir, "m"), entries: [] }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  rememberPassedOver(db, source("Sheets"), { ...judgement, heldByHistory: "Reads like Sparkles, which was dismissed (60% alike)" }, 0.8, NOW);
  rememberPassedOver(db, source("Dice"), { ...judgement, heldByHistory: "Reads like Sparkles, which was dismissed (50% alike)" }, 0.8, NOW);
  rememberPassedOver(db, source("Plain"), judgement, 0.3, NOW);
  const competitors = new CompetitorSchedule(db, { configPath, check: async () => ({ version: "2.1.0", prerelease: null, commit: "c".repeat(40), error: null }) });
  const call = await hub(t, { db, competitors, discovery: new DiscoverySchedule({ run: async () => result() }) });
  assert.deepEqual((await call("/api/competitors/candidates")).body.holds, { lastRun: { at: NOW, held: 2, rescued: 0 }, all: { held: 2, rescued: 0 } });
  assert.equal((await call("/api/competitors/candidates/github-acme-plain/release", "POST", "{}")).status, 409);
  assert.equal((await call("/api/competitors/candidates/github-acme-nothing/release", "POST", "{}")).status, 404);
  const released = await call("/api/competitors/candidates/github-acme-sheets/release", "POST", "{}");
  assert.equal(released.status, 200);
  assert.deepEqual([released.body.status, released.body.passedOver, released.body.judgement.heldByHistory, released.body.judgement.releasedFromHold], ["new", false, undefined, "Reads like Sparkles, which was dismissed (60% alike)"]);
  const listed = (await call("/api/competitors/candidates")).body;
  assert.deepEqual(listed.candidates.map((item: { name: string }) => item.name), ["Sheets"]);
  assert.deepEqual(listed.passedOver.map((item: { name: string }) => item.name).sort(), ["Dice", "Plain"]);
  assert.deepEqual(listed.holds.all, { held: 2, rescued: 1 });
  assert.equal((await call("/api/competitors/candidates/github-acme-sheets/release", "POST", "{}")).status, 409);

  assert.equal((await call("/api/competitors/candidates/github-acme-sheets/track", "POST", "{}")).body.dossier, true);
  const dossier = await call("/api/competitors/github-acme-sheets/dossier");
  assert.equal(dossier.status, 200);
  assert.deepEqual([dossier.body.folder, dossier.body.files], ["acme - Sheets", ["00_Overview.md"]]);
  assert.match(dossier.body.overview, /^# Sheets$/m);
  assert.equal((await call("/api/competitors/nothing-here/dossier")).status, 404);
  db.prepare("UPDATE competitors SET dossier_dir = ? WHERE id = ?").run("C:/elsewhere/secret", "github-acme-sheets");
  assert.equal((await call("/api/competitors/github-acme-sheets/dossier")).status, 404);
});
