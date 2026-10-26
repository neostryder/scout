import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCompetitorRuns, openCatalog, startPullingRun } from "@scout/core";
import { COMPETITOR_FULL_SYNC_MS, COMPETITOR_INTERVAL_MS, COMPETITOR_START_DELAY_MS, COMPETITOR_SYNC_PAUSE_MS, CompetitorSchedule, type CompetitorCheckResult } from "../src/competitor-schedule.ts";
import type { ScheduleClock } from "../src/schedule.ts";

const START = Date.parse("2026-05-05T00:00:00.000Z");

class FakeClock implements ScheduleClock {
  time = START;
  timers = new Map<number, { at: number; callback: () => void }>();
  private serial = 0;
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const next = due[0];
      if (!next) break;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

async function idle(schedule: CompetitorSchedule): Promise<void> {
  for (let i = 0; i < 30 && schedule.status().running; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(schedule.status().running, false);
}

function writeConfig(dir: string): string {
  const path = join(dir, "competitors.json");
  writeFileSync(path, JSON.stringify({
    dossierRoot: join(dir, "dossiers"),
    mirrorRoot: join(dir, "mirrors"),
    entries: [{
      id: "acme-tools", name: "Acme Tools", org: "Acme", remoteUrl: "https://github.com/example/acme-tools",
      mirrorPath: null, packageUrl: null, dossierDir: null, dossierReviewed: "2026-05-05", flags: ["forge"],
      baseline: { version: "1.0.0", commit: "aaa111", at: "2026-05-05", source: "mirror" },
    }],
  }));
  return path;
}

test("the watch waits five minutes, checks one repository at a time, and alerts once per version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-sched-"));
  const clock = new FakeClock();
  const notices: string[] = [];
  let version = "1.1.0";
  let calls = 0;
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => { release = resolve; });
  const db = openCatalog(":memory:");
  const schedule = new CompetitorSchedule(db, {
    configPath: writeConfig(dir),
    clock,
    check: async (): Promise<CompetitorCheckResult> => {
      calls += 1;
      if (calls === 1) await gate;
      return { version, prerelease: null, commit: "bbb222", error: null };
    },
    notifier: { async send(notice) { notices.push(notice.body); return []; } },
    log: () => {},
  });
  try {
    assert.equal(schedule.status().configured, true);
    schedule.start();
    clock.advance(COMPETITOR_START_DELAY_MS - 1);
    await idle(schedule);
    assert.equal(calls, 0);
    clock.advance(1);
    assert.equal(schedule.runNow().started, false);
    release();
    await idle(schedule);
    assert.equal(calls, 1);
    assert.deepEqual(notices, ["Acme Tools: new version 1.1.0 since the last analysis (1.0.0)"]);
    clock.advance(COMPETITOR_INTERVAL_MS);
    await idle(schedule);
    assert.equal(calls, 2);
    assert.equal(notices.length, 1);
    version = "1.2.0";
    clock.advance(COMPETITOR_INTERVAL_MS);
    await idle(schedule);
    assert.equal(notices[1], "Acme Tools: new version 1.2.0 since the last analysis (1.0.0)");
    schedule.stop();
    clock.advance(COMPETITOR_INTERVAL_MS);
    await idle(schedule);
    assert.equal(calls, 3);
  } finally {
    schedule.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(dir: string, id: string, name: string) {
  return {
    id, name, org: "Acme", remoteUrl: "https://github.com/example/acme-tools",
    mirrorPath: join(dir, "mirrors", id), packageUrl: null, dossierDir: null, dossierReviewed: null, flags: [] as string[],
    baseline: { version: "1.0.0", commit: "aaa111", at: "2026-05-05", source: "mirror" },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("the sync pass staggers mirrors, skips an unchanged mirror and a manual update, and still does the weekly pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-sync-sched-"));
  const clock = new FakeClock();
  const seen: { id: string; at: number }[] = [];
  const db = openCatalog(":memory:");
  const schedule = new CompetitorSchedule(db, {
    configPath: (() => {
      const path = join(dir, "competitors.json");
      writeFileSync(path, JSON.stringify({
        dossierRoot: join(dir, "dossiers"),
        mirrorRoot: join(dir, "mirrors"),
        entries: [entry(dir, "acme-tools", "Acme Tools"), entry(dir, "beta-tools", "Beta Tools"), entry(dir, "gamma-tools", "Gamma Tools"), entry(dir, "hold-tools", "Hold Tools")],
      }));
      return path;
    })(),
    clock,
    startupDelayMs: 0,
    syncStartupDelayMs: 0,
    syncPauseMs: COMPETITOR_SYNC_PAUSE_MS,
    syncIntervalMs: COMPETITOR_FULL_SYNC_MS,
    check: async () => ({ version: null, prerelease: null, commit: null, error: "skipped" }),
    sync: async (_db, id) => {
      seen.push({ id, at: clock.time });
      if (id === "gamma-tools") throw new Error("mirror has uncommitted changes");
      return { ok: true, cwd: join(dir, "mirrors", id), head: "bbb222" };
    },
    log: () => {},
  });
  try {
    db.prepare("UPDATE competitors SET latest_commit = ?, sync_head = ? WHERE id = ?").run("bbb222", "aaa111", "acme-tools");
    db.prepare("UPDATE competitors SET latest_commit = ?, sync_head = ? WHERE id = ?").run("ccc333", "ccc333", "beta-tools");
    db.prepare("UPDATE competitors SET latest_commit = ?, sync_head = ? WHERE id = ?").run("ddd444", "eee555", "gamma-tools");
    db.prepare("UPDATE competitors SET latest_commit = ?, sync_head = ? WHERE id = ?").run("fff666", "ggg777", "hold-tools");
    startPullingRun(db, "hold-tools", "2026-05-05T00:00:00.000Z");
    schedule.start();
    clock.advance(0);
    await flush();
    assert.deepEqual(seen.map((item) => item.id), ["acme-tools"]);
    clock.advance(COMPETITOR_SYNC_PAUSE_MS);
    await flush();
    assert.deepEqual(seen.map((item) => item.id), ["acme-tools", "gamma-tools"]);
    const firstSync = seen[0];
    const secondSync = seen[1];
    assert.ok(firstSync);
    assert.ok(secondSync);
    assert.equal(secondSync.at, firstSync.at + COMPETITOR_SYNC_PAUSE_MS);
    assert.equal(seen.some((item) => item.id === "beta-tools" || item.id === "hold-tools"), false);
    const gamma = db.prepare("SELECT sync_error AS error, sync_head AS head FROM competitors WHERE id = 'gamma-tools'").get() as { error: string | null; head: string | null };
    assert.equal(gamma.error, "mirror has uncommitted changes");
    assert.equal(gamma.head, "eee555");
    seen.length = 0;
    clock.advance(COMPETITOR_FULL_SYNC_MS);
    await flush();
    clock.advance(COMPETITOR_SYNC_PAUSE_MS);
    await flush();
    clock.advance(COMPETITOR_SYNC_PAUSE_MS);
    await flush();
    assert.deepEqual(seen.map((item) => item.id), ["acme-tools", "beta-tools", "gamma-tools"]);
  } finally {
    schedule.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an automatic queue notifies once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-auto-"));
  const clock = new FakeClock();
  const notices: string[] = [];
  const db = openCatalog(":memory:");
  const path = join(dir, "competitors.json");
  writeFileSync(path, JSON.stringify({ dossierRoot: join(dir, "dossiers"), mirrorRoot: join(dir, "mirrors"), entries: [entry(dir, "acme-tools", "Acme Tools")] }));
  const schedule = new CompetitorSchedule(db, {
    configPath: path,
    clock,
    startupDelayMs: 0,
    syncStartupDelayMs: 0,
    syncPauseMs: 0,
    syncIntervalMs: 1_000,
    check: async () => ({ version: null, prerelease: null, commit: null, error: "skipped" }),
    sync: async () => ({ ok: true, cwd: join(dir, "mirrors", "acme-tools"), head: "bbb222" }),
    research: async () => ({
      request: { analysis: { flags: { reaReason: "source score 54" } }, commitCount: 6 },
      delta: { commits: 6, sourceFilesChanged: 1, newStableTag: false, docsOnly: false, dependencyBumpOnly: false, lastCommitAt: "2026-01-01T00:00:00.000Z" },
      toVersion: "1.2.0",
      toCommit: "bbb222",
    }),
    notifier: { async send(notice) { notices.push(notice.body); return []; } },
    log: () => {},
  });
  try {
    db.prepare("UPDATE competitors SET latest_commit = ?, sync_head = ? WHERE id = ?").run("bbb222", "aaa111", "acme-tools");
    schedule.start();
    clock.advance(0);
    await flush();
    assert.deepEqual(notices, ["Acme Tools: research queued automatically (6 commits, 6 commits)"]);
    const queued = listCompetitorRuns(db, ["queued"], "2026-05-05T00:00:00.000Z");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.trigger, "auto");
    assert.equal((queued[0]?.request as { analysis: { flags: { reaReason: string } } }).analysis.flags.reaReason, "source score 54");
    clock.advance(1_000);
    await flush();
    assert.equal(notices.length, 1);
  } finally {
    schedule.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a change below the threshold waits, and a later empty delta clears the note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-wait-"));
  const clock = new FakeClock();
  const notices: string[] = [];
  let pass = 0;
  const db = openCatalog(":memory:");
  const path = join(dir, "competitors.json");
  writeFileSync(path, JSON.stringify({ dossierRoot: join(dir, "dossiers"), mirrorRoot: join(dir, "mirrors"), entries: [entry(dir, "acme-tools", "Acme Tools")] }));
  const schedule = new CompetitorSchedule(db, {
    configPath: path,
    clock,
    startupDelayMs: 0,
    syncStartupDelayMs: 0,
    syncPauseMs: 0,
    syncIntervalMs: 1_000,
    check: async () => ({ version: null, prerelease: null, commit: null, error: "skipped" }),
    sync: async () => ({ ok: true, cwd: join(dir, "mirrors", "acme-tools"), head: "bbb222" }),
    research: async () => {
      pass += 1;
      if (pass === 1) {
        return {
          request: { commitCount: 2 },
          delta: { commits: 2, sourceFilesChanged: 1, newStableTag: false, docsOnly: false, dependencyBumpOnly: false, lastCommitAt: "2026-01-01T00:00:00.000Z" },
          toVersion: "1.1.0",
          toCommit: "bbb222",
        };
      }
      return {
        request: { commitCount: 0 },
        delta: { commits: 0, sourceFilesChanged: 0, newStableTag: false, docsOnly: false, dependencyBumpOnly: false, lastCommitAt: null },
        toVersion: null,
        toCommit: "bbb222",
      };
    },
    notifier: { async send(notice) { notices.push(notice.body); return []; } },
    log: () => {},
  });
  try {
    db.prepare("UPDATE competitors SET latest_commit = ?, sync_head = ? WHERE id = ?").run("bbb222", "aaa111", "acme-tools");
    schedule.start();
    clock.advance(0);
    await flush();
    const pending = db.prepare("SELECT pending_json AS pending FROM competitors WHERE id = 'acme-tools'").get() as { pending: string };
    assert.equal(JSON.parse(pending.pending).commits, 2);
    assert.equal(JSON.parse(pending.pending).reason, "2 commits, below the threshold of 5");
    assert.equal(notices.length, 0);
    assert.equal(listCompetitorRuns(db, ["queued"], "2026-05-05T00:00:00.000Z").length, 0);
    clock.advance(1_000);
    await flush();
    const cleared = db.prepare("SELECT pending_json AS pending FROM competitors WHERE id = 'acme-tools'").get() as { pending: string | null };
    assert.equal(cleared.pending, null);
    assert.equal(notices.length, 0);
  } finally {
    schedule.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a check queues research when the mirror already has the new commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-caught-"));
  const clock = new FakeClock();
  const notices: string[] = [];
  const db = openCatalog(":memory:");
  const path = join(dir, "competitors.json");
  writeFileSync(path, JSON.stringify({
    dossierRoot: join(dir, "dossiers"),
    mirrorRoot: join(dir, "mirrors"),
    entries: [{ ...entry(dir, "acme-tools", "Acme Tools"), baseline: { version: "1.2.0", commit: "aaa111", at: "2026-05-05", source: "mirror" } }],
  }));
  const schedule = new CompetitorSchedule(db, {
    configPath: path,
    clock,
    startupDelayMs: 0,
    syncStartupDelayMs: 0,
    check: async () => ({ version: "1.2.0", prerelease: null, commit: "bbb222", error: null }),
    research: async () => ({
      request: { analysis: { ok: true }, commitCount: 6 },
      delta: { commits: 6, sourceFilesChanged: 1, newStableTag: false, docsOnly: false, dependencyBumpOnly: false, lastCommitAt: "2026-01-01T00:00:00.000Z" },
      toVersion: "1.2.0",
      toCommit: "bbb222",
    }),
    notifier: { async send(notice) { notices.push(notice.body); return []; } },
    log: () => {},
  });
  try {
    db.prepare("UPDATE competitors SET sync_head = ? WHERE id = ?").run("bbb222", "acme-tools");
    schedule.start();
    clock.advance(0);
    await flush();
    assert.deepEqual(notices, ["Acme Tools: research queued automatically (6 commits, 6 commits)"]);
    assert.equal(listCompetitorRuns(db, ["queued"], "2026-05-05T00:00:00.000Z")[0]?.trigger, "auto");
  } finally {
    schedule.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tracked competitor with no mirror is cloned by the sync pass, keeps its baseline, and a failed clone waits hours before another try", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-comp-catchup-"));
  const clock = new FakeClock();
  const db = openCatalog(":memory:");
  const tries: string[] = [];
  const { mkdirSync, readFileSync } = await import("node:fs");
  const configPath = join(dir, "competitors.json");
  mkdirSync(join(dir, "mirrors"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    dossierRoot: join(dir, "dossiers"),
    mirrorRoot: join(dir, "mirrors"),
    entries: [
      { ...entry(dir, "big-tools", "Big Tools"), mirrorPath: null },
      { ...entry(dir, "gone-tools", "Gone Tools"), mirrorPath: null },
    ],
  }));
  const schedule = new CompetitorSchedule(db, {
    configPath, clock, startupDelayMs: 0, syncStartupDelayMs: 0, syncPauseMs: 0, syncIntervalMs: 3_600_000,
    check: async () => ({ version: null, prerelease: null, commit: null, error: "skipped" }),
    sync: async (_db, id) => ({ ok: true, cwd: join(dir, "mirrors", id), head: "bbb222" }),
    clone: async (_remote, folder) => {
      tries.push(folder);
      if (folder === "gone-tools") return { ok: false, error: "repository not found" };
      mkdirSync(join(dir, "mirrors", folder, ".git"), { recursive: true });
      return { ok: true, head: "c".repeat(40) };
    },
    log: () => {},
  });
  try {
    schedule.start();
    clock.advance(0);
    await flush();
    assert.deepEqual(tries, ["big-tools", "gone-tools"]);
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { entries: { id: string; mirrorPath: string | null; baseline: { commit: string } }[] };
    const big = saved.entries.find((item) => item.id === "big-tools");
    assert.equal(big?.mirrorPath, join(dir, "mirrors", "big-tools").replaceAll("\\", "/"));
    assert.equal(big?.baseline.commit, "aaa111");
    clock.advance(3_600_000);
    await flush();
    assert.deepEqual(tries, ["big-tools", "gone-tools"]);
    clock.advance(6 * 3_600_000);
    await flush();
    assert.deepEqual(tries, ["big-tools", "gone-tools", "gone-tools"]);
  } finally {
    schedule.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
