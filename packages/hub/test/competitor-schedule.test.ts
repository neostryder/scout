import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog } from "@scout/core";
import { COMPETITOR_INTERVAL_MS, COMPETITOR_START_DELAY_MS, CompetitorSchedule, type CompetitorCheckResult } from "../src/competitor-schedule.ts";
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
