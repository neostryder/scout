import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCompetitorRuns, listCompetitors, openCatalog, startPullingRun, type Db } from "@scout/core";
import { checkWatchForSchedule, researchForWatch, runWatchUpdate, type WatchFetcher } from "@scout/ops";
import { CompetitorSchedule } from "../src/competitor-schedule.ts";
import { createHub } from "../src/server.ts";

const NOW = Date.parse("2026-05-20T00:00:00.000Z");

const ENTRIES = [
  { id: "solo-api", name: "Solo API", flags: ["forge"], watch: { kind: "json", url: "https://example.com/solo.json", versionPath: "version" } },
  { id: "solo-page", name: "Solo Page", flags: [], watch: { kind: "hash", url: "https://example.com/pricing" } },
  { id: "plain", name: "Plain Entry", flags: [] },
];

function write(dir: string, extra: Record<string, unknown> = {}): string {
  const path = join(dir, "competitors.json");
  writeFileSync(path, JSON.stringify({ dossierRoot: join(dir, "dossiers"), mirrorRoot: join(dir, "mirrors"), ...extra, entries: ENTRIES }));
  return path;
}

function setup(t: TestContext, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const pages = { version: "2.0.0", pricing: "<p>Pro: $9</p>" };
  const fetcher: WatchFetcher = async (url) => {
    if (url === "https://example.com/solo.json") return new Response(JSON.stringify({ version: pages.version }));
    if (url === "https://example.com/pricing") return new Response(pages.pricing);
    return new Response("missing", { status: 404 });
  };
  const notices: string[] = [];
  const configPath = write(dir, extra);
  const schedule = new CompetitorSchedule(db, {
    configPath,
    watch: (watch) => checkWatchForSchedule(watch, fetcher),
    research: (catalog, id, now) => researchForWatch(catalog, id, { now, fetcher }),
    pull: (catalog, runId, now) => runWatchUpdate(catalog, runId, { now, fetcher }),
    notifier: { async send(notice) { notices.push(notice.body); return []; } },
    clock: { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  return { dir, db, pages, notices, schedule, configPath };
}

async function check(schedule: CompetitorSchedule): Promise<void> {
  assert.equal(schedule.runNow().started, true);
  for (let i = 0; i < 60 && schedule.status().running; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(schedule.status().running, false);
}

const row = (db: Db, id: string) => listCompetitors(db, new Date(NOW).toISOString()).find((item) => item.id === id)!;

test("the first reading of a watched competitor becomes its baseline and raises nothing", async (t) => {
  const { db, notices, schedule } = setup(t);
  await check(schedule);
  assert.equal(row(db, "solo-api").baseline.version, "2.0.0");
  assert.equal(row(db, "solo-api").baseline.source, "watch");
  assert.equal(row(db, "solo-api").status, "current");
  assert.match(row(db, "solo-page").baseline.commit ?? "", /^page:/);
  assert.equal(row(db, "solo-page").status, "current");
  assert.equal(row(db, "plain").status, "unknown");
  assert.equal(row(db, "plain").latest.error, "no remote");
  assert.deepEqual(notices, []);
  assert.deepEqual(listCompetitorRuns(db, ["queued", "pulling", "claimed"]), []);
});

test("a new version at a watched source raises one notice and queues research with no commits to diff", async (t) => {
  const { db, pages, notices, schedule } = setup(t);
  await check(schedule);
  pages.version = "2.1.0";
  await check(schedule);
  assert.equal(row(db, "solo-api").status, "new");
  assert.equal(row(db, "solo-api").latest.version, "2.1.0");
  assert.ok(notices.includes("Solo API: new version 2.1.0 since the last analysis (2.0.0)"));
  assert.ok(notices.includes("Solo API: research queued automatically (0 commits, new stable tag)"));
  const [queued] = listCompetitorRuns(db, ["queued"]);
  assert.equal(queued?.trigger, "auto");
  assert.equal(queued?.fromVersion, "2.0.0");
  assert.equal(queued?.toVersion, "2.1.0");
  assert.equal((queued?.request?.["watch"] as { url: string }).url, "https://example.com/solo.json");
  await check(schedule);
  assert.equal(notices.filter((line) => line.includes("new version 2.1.0")).length, 1);
});

test("a changed page with no version waits for a person instead of queuing", async (t) => {
  const { db, pages, notices, schedule } = setup(t);
  await check(schedule);
  pages.pricing = "<p>Pro: $12</p>";
  await check(schedule);
  assert.equal(row(db, "solo-page").status, "new");
  assert.ok(notices.includes("Solo Page: the watched page changed since the last analysis"));
  assert.deepEqual(row(db, "solo-page").pending, { commits: 0, sourceFilesChanged: 0, reason: "the watched page changed and shows no new version" });
  assert.equal(listCompetitorRuns(db, ["queued"]).some((run) => run.competitorId === "solo-page"), false);
  const update = schedule.requestUpdate("solo-page");
  assert.equal(update.status, 202);
  for (let i = 0; i < 60 && !listCompetitorRuns(db, ["queued"]).some((run) => run.competitorId === "solo-page"); i++) await new Promise((resolve) => setImmediate(resolve));
  const [manual] = listCompetitorRuns(db, ["queued"]).filter((run) => run.competitorId === "solo-page");
  assert.equal(manual?.trigger, "manual");
});

test("a watch that cannot be read shows the reason and does not change the baseline", async (t) => {
  const { db, pages, schedule } = setup(t);
  await check(schedule);
  pages.version = "";
  await check(schedule);
  assert.equal(row(db, "solo-api").latest.error, "no version at the watched path");
  assert.equal(row(db, "solo-api").baseline.version, "2.0.0");
});

test("the gate is read from the file, changed in the file, and applied by the next check", async (t) => {
  const { db, pages, configPath, schedule } = setup(t);
  assert.deepEqual(schedule.gateSettings().global, {});
  const changed = schedule.updateGate({ set: { enabled: false } });
  assert.deepEqual(changed.global, { enabled: false });
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).gate.enabled, false);
  await check(schedule);
  pages.version = "2.1.0";
  await check(schedule);
  assert.equal(row(db, "solo-api").status, "new");
  assert.deepEqual(listCompetitorRuns(db, ["queued"]), []);
  schedule.updateGate({ clear: ["enabled"] });
  assert.equal("gate" in JSON.parse(readFileSync(configPath, "utf8")), false);
  schedule.updateGate({ id: "solo-api", set: { maxQueued: 1 } });
  assert.deepEqual(schedule.gateSettings().entries, [{ id: "solo-api", name: "Solo API", gate: { maxQueued: 1 } }]);
  await check(schedule);
  assert.equal(listCompetitorRuns(db, ["queued"]).length, 1);
});

test("a watch source is set and removed through the file and shows on the row", async (t) => {
  const { db, schedule } = setup(t);
  schedule.updateWatch("plain", { kind: "hash", url: "https://example.com/pricing" });
  assert.deepEqual(row(db, "plain").watch, { kind: "hash", url: "https://example.com/pricing" });
  schedule.updateWatch("plain", null);
  assert.equal(row(db, "plain").watch, null);
  assert.throws(() => schedule.updateWatch("plain", { kind: "hash", url: "http://example.com/pricing" }), /https/);
  assert.throws(() => schedule.updateWatch("nobody", null), /unknown competitor/);
});

async function hub(t: TestContext, db: Db, schedule: CompetitorSchedule) {
  const server = createHub({ db, webRoot: t.name, control: false, health: false, competitors: schedule });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const port = (server.address() as AddressInfo).port;
  return (path: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => { let parsed: unknown; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("the gate and watch routes read, change, validate, and refuse the wrong method", async (t) => {
  const { db, schedule } = setup(t);
  const call = await hub(t, db, schedule);
  const read = await call("/api/competitors/gate");
  assert.equal(read.status, 200);
  assert.equal(read.body.defaults.minCommits, 5);
  assert.deepEqual(read.body.global, {});
  const set = await call("/api/competitors/gate", "POST", { set: { minCommits: 8, ignoreDocsOnly: false } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.global, { minCommits: 8, ignoreDocsOnly: false });
  const own = await call("/api/competitors/gate", "POST", { id: "plain", set: { quietHours: 0 } });
  assert.deepEqual(own.body.entries, [{ id: "plain", name: "Plain Entry", gate: { quietHours: 0 } }]);
  const cleared = await call("/api/competitors/gate", "POST", { clear: ["minCommits"] });
  assert.deepEqual(cleared.body.global, { ignoreDocsOnly: false });
  assert.equal((await call("/api/competitors/gate", "POST", { set: { minCommits: "many" } })).status, 400);
  assert.equal((await call("/api/competitors/gate", "POST", { set: { nope: 1 } })).status, 400);
  assert.equal((await call("/api/competitors/gate", "POST", { id: "nobody", set: { minCommits: 1 } })).status, 400);
  assert.equal((await call("/api/competitors/gate", "POST", { extra: 1 })).status, 400);
  assert.equal((await call("/api/competitors/gate", "PUT", {})).status, 405);
  const watch = await call("/api/competitors/plain/watch", "POST", { watch: { kind: "page", url: "https://example.com/changes", versionPattern: "Release (\\d+\\.\\d+)" } });
  assert.equal(watch.status, 200);
  const listed = await call("/api/competitors");
  assert.deepEqual(listed.body.competitors.find((item: { id: string }) => item.id === "plain").watch, { kind: "page", url: "https://example.com/changes", versionPattern: "Release (\\d+\\.\\d+)" });
  assert.equal((await call("/api/competitors/plain/watch", "POST", { watch: { kind: "page", url: "http://example.com/changes" } })).status, 400);
  assert.equal((await call("/api/competitors/plain/watch", "POST", {})).status, 400);
  assert.equal((await call("/api/competitors/plain/watch", "POST", { watch: null })).status, 200);
  assert.equal((await call("/api/competitors/plain/watch")).status, 405);
});

test("a repository is set from the page's fields once its clone exists, and a removal drops a row with nothing in progress", async (t) => {
  const { dir, db, schedule } = setup(t);
  const call = await hub(t, db, schedule);
  const repo = { remoteUrl: "https://github.com/example/plain", folder: "plain-clone" };
  const missing = await call("/api/competitors/plain/repo", "POST", { repo });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /not a git checkout yet/);
  assert.equal(row(db, "plain").remoteUrl, null, "a refused repository leaves the file alone");
  mkdirSync(join(dir, "mirrors", "plain-clone", ".git"), { recursive: true });
  const saved = await call("/api/competitors/plain/repo", "POST", { repo });
  assert.equal(saved.status, 200);
  assert.equal(row(db, "plain").remoteUrl, "https://github.com/example/plain");
  assert.equal((await call("/api/competitors/plain/repo", "POST", { repo: { ...repo, folder: "../escape" } })).status, 400);
  assert.equal((await call("/api/competitors/plain/repo", "POST", { repo: { remoteUrl: "http://github.com/example/plain" } })).status, 400);
  assert.equal((await call("/api/competitors/plain/repo", "POST", {})).status, 400);
  assert.equal((await call("/api/competitors/plain/repo")).status, 405);

  startPullingRun(db, "solo-page", new Date(NOW).toISOString());
  const busy = await call("/api/competitors/solo-page/remove", "POST", {});
  assert.equal(busy.status, 400);
  assert.match(busy.body.error, /in progress/);
  assert.equal((await call("/api/competitors/plain/remove", "POST", {})).status, 200);
  assert.equal(listCompetitors(db, new Date(NOW).toISOString()).some((item) => item.id === "plain"), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "competitors.json"), "utf8")).entries.some((item: { id: string }) => item.id === "plain"), false);
  assert.equal((await call("/api/competitors/plain/remove", "POST", {})).status, 400);
});
