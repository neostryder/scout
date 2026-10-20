import { readFileSync } from "node:fs";
import { applyCompetitorCheck, compareVersions, countOpenResearch, enqueueAutoRun, evaluateResearchGate, failCompetitorRun, listCompetitors, markCompetitorNotified, parseCompetitorsFile, recordMirrorSync, redactUrlSecrets, resolveResearchGate, setCompetitorPending, startPullingRun, syncCompetitors, type CompetitorRun, type CompetitorsFile, type Db, type ResearchDelta } from "@scout/core";
import type { Notifier } from "./notify.ts";
import type { ScheduleClock } from "./schedule.ts";

export const COMPETITOR_INTERVAL_MS = 6 * 3_600_000;
export const COMPETITOR_START_DELAY_MS = 5 * 60_000;
export const COMPETITOR_SYNC_INTERVAL_MS = 12 * 3_600_000;
export const COMPETITOR_SYNC_PAUSE_MS = 2_000;
export const COMPETITOR_SYNC_TIMEOUT_MS = 120_000;
export const COMPETITOR_FULL_SYNC_MS = 7 * 24 * 3_600_000;

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
  syncIntervalMs?: number;
  syncStartupDelayMs?: number;
  syncPauseMs?: number;
  sync?: (db: Db, id: string, now: string, timeoutMs: number) => Promise<{ ok: true; cwd: string; head: string } | { ok: false; error: string }>;
  research?: (db: Db, id: string, now: string) => Promise<{ request: Record<string, unknown>; delta: ResearchDelta; toVersion: string | null; toCommit: string | null } | { error: string }>;
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
  private syncIntervalMs: number;
  private syncStartupDelayMs: number;
  private syncPauseMs: number;
  private configured = false;
  private checkedAt: string | null = null;
  private started = false;
  private active = false;
  private syncing = false;
  private timer: unknown;
  private syncTimer: unknown;
  private generation = 0;
  private syncGeneration = 0;
  private nextFullAt = 0;
  private registry: CompetitorsFile | null = null;

  constructor(db: Db, options: CompetitorScheduleOptions) {
    this.db = db;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.intervalMs = options.intervalMs ?? COMPETITOR_INTERVAL_MS;
    this.startupDelayMs = options.startupDelayMs ?? COMPETITOR_START_DELAY_MS;
    this.syncIntervalMs = options.syncIntervalMs ?? COMPETITOR_SYNC_INTERVAL_MS;
    this.syncStartupDelayMs = options.syncStartupDelayMs ?? COMPETITOR_START_DELAY_MS;
    this.syncPauseMs = options.syncPauseMs ?? COMPETITOR_SYNC_PAUSE_MS;
    this.nextFullAt = this.clock.now() + COMPETITOR_FULL_SYNC_MS;
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
    this.armSync(this.syncStartupDelayMs);
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.syncGeneration += 1;
    this.clearTimer();
    this.clearSyncTimer();
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
      this.registry = file;
      this.configured = true;
    } catch (error) {
      this.log(`competitors file: ${(error as Error).message}`);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearSyncTimer(): void {
    if (this.syncTimer !== undefined) this.clock.clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
  }

  private armSync(delayMs: number): void {
    this.clearSyncTimer();
    if (!this.started) return;
    this.syncTimer = this.clock.setTimeout(() => {
      if (!this.started) return;
      if (this.syncing) { this.armSync(this.syncIntervalMs); return; }
      this.kickSync();
    }, Math.max(0, delayMs));
  }

  private kickSync(): void {
    if (!this.options.sync) return;
    this.syncing = true;
    this.clearSyncTimer();
    const generation = this.syncGeneration;
    void this.syncAll().catch((error: unknown) => this.log(`competitor sync failed: ${this.plain(error)}`)).finally(() => {
      this.syncing = false;
      if (this.started && generation === this.syncGeneration) this.armSync(this.syncIntervalMs);
    });
  }

  private async syncAll(): Promise<void> {
    this.loadConfig();
    const nowMs = this.clock.now();
    const full = nowMs >= this.nextFullAt;
    if (full) this.nextFullAt = nowMs + COMPETITOR_FULL_SYNC_MS;
    const rows = this.db.prepare("SELECT id, mirror_path AS mirrorPath, latest_commit AS latestCommit, sync_head AS syncHead FROM competitors ORDER BY name, id").all() as { id: string; mirrorPath: string | null; latestCommit: string | null; syncHead: string | null }[];
    let attempted = false;
    for (const row of rows) {
      if (!this.started) return;
      if (!row.mirrorPath) continue;
      const selected = full || (row.latestCommit !== null && row.latestCommit !== row.syncHead);
      if (!selected) continue;
      if (this.pulling(row.id)) continue;
      if (attempted) await this.pause(this.syncPauseMs);
      if (!this.started) return;
      if (this.pulling(row.id)) continue;
      attempted = true;
      const now = this.iso();
      try {
        const result = await this.bounded(this.options.sync!(this.db, row.id, now, COMPETITOR_SYNC_TIMEOUT_MS), COMPETITOR_SYNC_TIMEOUT_MS);
        if (!result.ok) {
          try { recordMirrorSync(this.db, row.id, { error: result.error }); } catch { /* the row was removed while the mirror ran */ }
          continue;
        }
        await this.maybeQueue(row.id);
      } catch (error) {
        try { recordMirrorSync(this.db, row.id, { error: this.plain(error) }); } catch { /* the row was removed while the mirror ran */ }
      }
    }
  }

  private pulling(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM competitor_runs WHERE competitor_id = ? AND state = 'pulling'").get(id) !== undefined;
  }

  private pause(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => { this.clock.setTimeout(() => resolve(), ms); });
  }

  private bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("timed out"));
      }, ms);
      work.then((value) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async maybeQueue(id: string): Promise<void> {
    if (!this.options.research) return;
    if (this.db.prepare("SELECT 1 FROM competitor_runs WHERE competitor_id = ? AND state IN ('pulling','queued','claimed')").get(id)) return;
    let prepared: { request: Record<string, unknown>; delta: ResearchDelta; toVersion: string | null; toCommit: string | null } | { error: string };
    try {
      prepared = await this.options.research(this.db, id, this.iso());
    } catch (error) {
      this.log(`competitor research prep failed: ${this.plain(error)}`);
      return;
    }
    if ("error" in prepared) {
      this.log(`competitor research prep failed: ${prepared.error}`);
      return;
    }
    const row = listCompetitors(this.db, this.iso()).find((item) => item.id === id);
    if (!row) return;
    const entry = this.registry?.entries.find((item) => item.id === id);
    const decision = evaluateResearchGate(row, prepared.delta, resolveResearchGate(this.registry?.gate, entry?.gate, countOpenResearch(this.db)), this.iso());
    if (decision.decision === "queue") {
      try {
        enqueueAutoRun(this.db, id, { toVersion: prepared.toVersion, toCommit: prepared.toCommit, request: prepared.request }, this.iso());
      } catch (error) {
        if ((error as Error).message === "a run is already active") return;
        throw error;
      }
      const body = redactUrlSecrets(`${row.name}: research queued automatically (${prepared.delta.commits} commits, ${decision.reason})`);
      try {
        if (this.options.notifier) await this.options.notifier.send({ title: "Competitor watch", body, severity: "info" });
        else this.log(body);
      } catch (error) {
        this.log(`competitor notice failed (${this.plain(error)})`);
      }
      return;
    }
    if (decision.reason === "nothing new") {
      setCompetitorPending(this.db, id, null);
      return;
    }
    setCompetitorPending(this.db, id, { commits: decision.pending.commits, sourceFilesChanged: decision.pending.sourceFilesChanged, reason: decision.reason });
  }

  private plain(error: unknown): string {
    return redactUrlSecrets(error instanceof Error ? error.message : "competitor sync failed").replace(/\s+/g, " ").trim().slice(0, 300) || "competitor sync failed";
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
    const rows = this.db.prepare("SELECT id, remote_url AS remoteUrl, sync_head AS syncHead, baseline_commit AS baselineCommit, baseline_version AS baselineVersion FROM competitors").all() as { id: string; remoteUrl: string | null; syncHead: string | null; baselineCommit: string | null; baselineVersion: string | null }[];
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
      const caughtUp = result.error === null && result.commit !== null && row.syncHead !== null && result.commit === row.syncHead;
      const moved = result.commit !== row.baselineCommit || (result.version !== null && row.baselineVersion !== null && compareVersions(result.version, row.baselineVersion) === 1);
      if (caughtUp && moved) await this.maybeQueue(row.id);
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
