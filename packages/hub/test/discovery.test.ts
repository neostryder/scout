import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, saveCandidate, type CandidateJudgement, type CandidateSource, type OutageNotice } from "@scout/core";
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
  assert.deepEqual((await call("/api/competitors/candidates")).body, { configured: false, discovery: null, candidates: [] });
  assert.equal((await call("/api/competitors/discover", "POST", "{}")).status, 404);
});
