import { readFileSync } from "node:fs";
import { applyCompetitorCheck, failCompetitorRun, markCompetitorNotified, parseCompetitorsFile, redactUrlSecrets, startPullingRun, syncCompetitors, type CompetitorRun, type Db } from "@scout/core";
import type { Notifier } from "./notify.ts";
import type { ScheduleClock } from "./schedule.ts";

export const COMPETITOR_INTERVAL_MS = 6 * 3_600_000;
export const COMPETITOR_START_DELAY_MS = 5 * 60_000;

export interface CompetitorCheckResult {
  version: string | null;
  prerelease: string | null;
  commit: string | null;
  error: string | null;
}

export interface CompetitorScheduleOptions {
  configPath: string;
  intervalMs?: number;
  startupDelayMs?: number;
  clock?: ScheduleClock;
  check?: (remoteUrl: string) => Promise<CompetitorCheckResult>;
  pull?: (db: Db, runId: number, now: string) => Promise<void>;
  notifier?: Pick<Notifier, "send">;
  log?: (line: string) => void;
}

export interface CompetitorWatchStatus {
  configured: boolean;
  intervalSeconds: number;
  checkedAt: string | null;
  running: boolean;
}

const CLOCK: ScheduleClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class CompetitorSchedule {
  private db: Db;
  private options: CompetitorScheduleOptions;
  private clock: ScheduleClock;
  private intervalMs: number;
  private startupDelayMs: number;
  private configured = false;
  private checkedAt: string | null = null;
  private started = false;
  private active = false;
  private timer: unknown;
  private generation = 0;

  constructor(db: Db, options: CompetitorScheduleOptions) {
    this.db = db;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.intervalMs = options.intervalMs ?? COMPETITOR_INTERVAL_MS;
    this.startupDelayMs = options.startupDelayMs ?? COMPETITOR_START_DELAY_MS;
    const row = db.prepare("SELECT MAX(latest_checked_at) AS at FROM competitors").get() as { at: string | null } | undefined;
    this.checkedAt = row?.at ?? null;
    this.loadConfig();
  }

  intervalSeconds(): number { return this.intervalMs / 1000; }

  status(): CompetitorWatchStatus {
    return { configured: this.configured, intervalSeconds: this.intervalSeconds(), checkedAt: this.checkedAt, running: this.active };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadConfig();
    this.arm(this.startupDelayMs);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.clearTimer();
  }

  runNow(id?: string): { started: true } | { started: false; reason: string } {
    if (this.active) return { started: false, reason: "a competitor check is already running" };
    this.loadConfig();
    if (id !== undefined && !this.db.prepare("SELECT 1 FROM competitors WHERE id = ?").get(id)) throw new Error("unknown competitor");
    this.kick(id);
    return { started: true };
  }

  requestUpdate(id: string): { status: 202; run: CompetitorRun } | { status: 400 | 409; error: string } {
    this.loadConfig();
    let run: CompetitorRun;
    try {
      run = startPullingRun(this.db, id, this.iso());
    } catch (error) {
      const message = (error as Error).message;
      if (message === "a run is already active") return { status: 409, error: message };
      return { status: 400, error: message };
    }
    const task = this.options.pull ? this.options.pull(this.db, run.id, this.iso()) : Promise.reject(new Error("competitor update is not configured"));
    void task.catch((error: unknown) => {
      const message = redactUrlSecrets(error instanceof Error ? error.message : "update failed").replace(/\s+/g, " ").trim().slice(0, 300);
      try { failCompetitorRun(this.db, run.id, message || "update failed", this.iso()); } catch { /* the pull already recorded the failure */ }
    });
    return { status: 202, run };
  }

  private iso(): string { return new Date(this.clock.now()).toISOString(); }

  private log(line: string): void { (this.options.log ?? console.error)(line); }

  private loadConfig(): void {
    let text: string;
    try { text = readFileSync(this.options.configPath, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.configured = false; return; }
      this.log(`competitors file: ${(error as Error).message}`);
      return;
    }
    try {
      const file = parseCompetitorsFile(text);
      syncCompetitors(this.db, file.entries);
      this.configured = true;
    } catch (error) {
      this.log(`competitors file: ${(error as Error).message}`);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delayMs: number): void {
    this.clearTimer();
    if (!this.started) return;
    this.timer = this.clock.setTimeout(() => {
      if (!this.started) return;
      if (this.active) { this.arm(this.intervalMs); return; }
      this.kick();
    }, Math.max(0, delayMs));
  }

  private kick(id?: string): void {
    this.active = true;
    this.clearTimer();
    const generation = this.generation;
    void this.checkAll(id).catch((error: unknown) => this.log(`competitor check failed: ${(error as Error).message}`)).finally(() => {
      this.active = false;
      if (this.started && generation === this.generation) this.arm(this.intervalMs);
    });
  }

  private async checkAll(id?: string): Promise<void> {
    this.loadConfig();
    const rows = this.db.prepare("SELECT id, remote_url AS remoteUrl FROM competitors").all() as { id: string; remoteUrl: string | null }[];
    for (const row of rows) {
      if (id !== undefined && row.id !== id) continue;
      const now = this.iso();
      let result: CompetitorCheckResult;
      if (!row.remoteUrl) result = { version: null, prerelease: null, commit: null, error: "no remote" };
      else {
        try {
          result = this.options.check ? await this.options.check(row.remoteUrl) : { version: null, prerelease: null, commit: null, error: "competitor check is not configured" };
        } catch (error) {
          result = { version: null, prerelease: null, commit: null, error: redactUrlSecrets((error as Error).message).replace(/\s+/g, " ").trim().slice(0, 300) || "git failed" };
        }
      }
      const outcome = applyCompetitorCheck(this.db, row.id, result, now);
      if (!outcome.notice || !outcome.notified) continue;
      try {
        if (this.options.notifier) await this.options.notifier.send({ title: "Competitor watch", body: outcome.notice, severity: "info" });
        else this.log(outcome.notice);
        markCompetitorNotified(this.db, row.id, outcome.notified);
      } catch (error) {
        this.log(`competitor notice failed (${(error as Error).message})`);
      }
    }
    this.checkedAt = this.iso();
  }
}
