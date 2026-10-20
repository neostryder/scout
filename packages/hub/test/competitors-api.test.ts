import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { competitorRunRecord, openCatalog, queueCompetitorRun, type Db } from "@scout/core";
import { CompetitorSchedule } from "../src/competitor-schedule.ts";
import { createHub } from "../src/server.ts";

const NOW = "2026-05-20T00:00:00.000Z";

function config(dir: string, mirror: string): string {
  const path = join(dir, "competitors.json");
  writeFileSync(path, JSON.stringify({
    dossierRoot: join(dir, "dossiers"),
    mirrorRoot: join(dir, "mirrors"),
    entries: [
      {
        id: "acme-tools", name: "Acme Tools", org: "Acme", remoteUrl: "https://github.com/example/acme-tools",
        mirrorPath: mirror, packageUrl: "https://example.test/packages/acme", dossierDir: join(dir, "dossiers", "Acme"),
        dossierReviewed: "2026-05-05", flags: ["forge"], baseline: { version: "1.0.0", commit: "aaa111", at: "2026-05-05", source: "mirror" },
      },
      {
        id: "solo-tool", name: "Solo Tool", org: "Solo", remoteUrl: "https://github.com/example/solo-tool",
        mirrorPath: null, packageUrl: null, dossierDir: null, dossierReviewed: null, flags: [],
        baseline: { version: null, commit: null, at: null, source: "none" },
      },
    ],
  }));
  return path;
}

async function hub(t: TestContext, db: Db, schedule: CompetitorSchedule) {
  const server = createHub({ db, webRoot: t.name, control: false, health: false, competitors: schedule });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "GET", body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => { let parsed: unknown; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject);
    req.end(body);
  });
  return { call, port };
}

async function settled(read: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !read(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read(), true);
}

test("competitor routes list, check, update, claim, complete, and fail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mirror = join(dir, "mirrors", "acme-tools");
  mkdirSync(mirror, { recursive: true });
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  let releaseCheck: () => void = () => {};
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  let releasePull: () => void = () => {};
  let pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
  let checks = 0;
  const schedule = new CompetitorSchedule(db, {
    configPath: config(dir, mirror),
    check: async () => {
      checks += 1;
      await checkGate;
      return { version: "1.2.0", prerelease: "1.3.0-rc.1", commit: "bbb222", error: null };
    },
    pull: async (catalog, runId, now) => {
      await pullGate;
      const record = competitorRunRecord(catalog, runId, now);
      queueCompetitorRun(catalog, runId, { toVersion: "1.2.0", toCommit: "bbb222", request: { mirrorPath: mirror, dossierDir: join(dir, "dossiers", "Acme"), from: { version: record?.fromVersion ?? null, commit: record?.fromCommit ?? null }, notes: "notes" } }, now);
    },
    log: () => {},
  });
  const { call, port } = await hub(t, db, schedule);
  const listed = await call("/api/competitors");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.configured, true);
  assert.equal(listed.body.intervalSeconds, 21600);
  assert.deepEqual(listed.body.competitors.map((row: { name: string }) => row.name), ["Acme Tools", "Solo Tool"]);
  assert.equal(JSON.stringify(listed.body).includes(mirror), false);
  assert.equal((await call("/api/competitors", "POST", "{}")).status, 405);
  assert.equal((await call("/api/competitors/check", "POST", "{}", { host: "foreign.test" })).status, 421);
  assert.equal((await call("/api/competitors/check", "POST", "{}", { origin: "https://foreign.test" })).status, 403);
  assert.equal((await call("/api/competitors/check", "POST", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("/api/competitors/check", "POST", "x".repeat(16_385))).status, 413);
  assert.equal((await call("/api/competitors/check", "POST", "null")).status, 400);
  assert.equal((await call("/api/competitors/check", "POST", "{\"id\":1}")).status, 400);
  assert.equal((await call("/api/competitors/missing/update", "POST", "{}")).status, 400);
  assert.equal((await call("/api/competitors/solo-tool/update", "POST", "{}")).body.error, "competitor has no mirror");
  const first = await call("/api/competitors/check", "POST", "{}", { origin: `http://127.0.0.1:${port}` });
  assert.equal(first.status, 202);
  const blocked = await call("/api/competitors/check", "POST", "{}");
  assert.equal(blocked.status, 409);
  releaseCheck();
  await settled(() => checks >= 1 && !schedule.status().running);
  const after = await call("/api/competitors");
  const acme = after.body.competitors.find((row: { id: string }) => row.id === "acme-tools");
  assert.equal(acme.status, "new");
  assert.equal(acme.newBasis, "version");
  assert.equal(acme.latest.version, "1.2.0");
  assert.equal(acme.latest.prerelease, "1.3.0-rc.1");
  const started = await call("/api/competitors/acme-tools/update", "POST", "{}");
  assert.equal(started.status, 202);
  assert.equal(started.body.state, "pulling");
  assert.equal((await call("/api/competitors/acme-tools/update", "POST", "{}")).status, 409);
  releasePull();
  await settled(() => (competitorRunRecord(db, started.body.id, NOW)?.state === "queued"));
  const runs = await call("/api/competitors/runs?state=queued,claimed");
  assert.equal(runs.status, 200);
  assert.equal(runs.body[0].request.mirrorPath, mirror);
  assert.equal((await call("/api/competitors/runs")).status, 400);
  assert.equal((await call("/api/competitors/runs?state=nope")).status, 400);
  assert.equal((await call("/api/competitors/runs/1/claim", "POST", "{\"by\":\"\"}")).status, 400);
  assert.equal((await call("/api/competitors/runs/1/claim", "POST", `{"by":"${"x".repeat(81)}"}`)).status, 400);
  assert.equal((await call("/api/competitors/runs/99/claim", "POST", "{\"by\":\"researcher\"}")).status, 404);
  const claimed = await call("/api/competitors/runs/1/claim", "POST", "{\"by\":\"researcher\"}");
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.state, "claimed");
  assert.equal(claimed.body.claimedBy, "researcher");
  assert.equal(claimed.body.request.notes, "notes");
  assert.equal((await call("/api/competitors/runs/1/claim", "POST", "{\"by\":\"other\"}")).status, 409);
  assert.equal((await call("/api/competitors/runs/1/complete", "POST", "{\"resultPath\":\"out.md\"}")).status, 400);
  const completed = await call("/api/competitors/runs/1/complete", "POST", "{\"resultPath\":\"out.md\",\"summary\":\"shipped\",\"analyzedVersion\":\"1.2.0\"}");
  assert.equal(completed.status, 200);
  assert.equal(completed.body.state, "done");
  const baseline = db.prepare("SELECT baseline_version AS version, baseline_source AS source FROM competitors WHERE id = 'acme-tools'").get() as { version: string; source: string };
  assert.equal(baseline.version, "1.2.0");
  assert.equal(baseline.source, "analysis");
  pullGate = new Promise<void>((resolve) => { releasePull = resolve; });
  const second = await call("/api/competitors/acme-tools/update", "POST", "{}");
  assert.equal(second.status, 202);
  releasePull();
  await settled(() => competitorRunRecord(db, second.body.id, NOW)?.state === "queued");
  const failed = await call(`/api/competitors/runs/${second.body.id}/fail`, "POST", "{\"error\":\"research stopped\"}");
  assert.equal(failed.status, 200);
  assert.equal(failed.body.state, "failed");
  const unchanged = db.prepare("SELECT baseline_version AS version FROM competitors WHERE id = 'acme-tools'").get() as { version: string };
  assert.equal(unchanged.version, "1.2.0");
  assert.equal((await call(`/api/competitors/runs/${second.body.id}/fail`, "POST", "{\"error\":\"again\"}")).status, 409);
});

test("a missing registry reports the watch off", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-off-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const schedule = new CompetitorSchedule(db, { configPath: join(dir, "missing.json"), log: () => {} });
  const { call } = await hub(t, db, schedule);
  const listed = await call("/api/competitors");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.competitors, []);
  assert.equal(listed.body.configured, false);
});
