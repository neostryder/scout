import type { Db } from "@scout/core";
import { RESEARCHERS, runResearch, type Researcher, type RunOptions, type SourceSummary } from "@scout/research";

export interface ResearchStatus {
  source: string;
  lastRunAt: string | null;
  lastOk: boolean | null;
  asked: number;
  answered: number;
  failed: number;
  nextDueAt: string;
  running: boolean;
}

export interface ScheduleClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface ScheduleOptions {
  researchers?: Researcher[];
  run?: (db: Db, researchers: Researcher[], options: RunOptions) => Promise<SourceSummary[]>;
  clock?: ScheduleClock;
  runOptions?: RunOptions;
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

export class ResearchSchedule {
  private db: Db;
  private researchers: Researcher[];
  private run: NonNullable<ScheduleOptions["run"]>;
  private clock: ScheduleClock;
  private runOptions: RunOptions;
  private states = new Map<string, ResearchStatus>();
  private pending = new Map<string, boolean>();
  private active: Promise<void> | null = null;
  private timer: unknown;
  private started = false;

  constructor(db: Db, options: ScheduleOptions = {}) {
    this.db = db;
    this.researchers = options.researchers ?? RESEARCHERS;
    this.run = options.run ?? runResearch;
    this.clock = options.clock ?? CLOCK;
    this.runOptions = options.runOptions ?? {};
    for (const researcher of this.researchers) {
      this.states.set(researcher.source, { source: researcher.source, lastRunAt: null, lastOk: null, asked: 0, answered: 0, failed: 0, nextDueAt: new Date(this.clock.now()).toISOString(), running: false });
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.enqueueDue();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    this.pending.clear();
  }

  runNow(sources?: string[]): Promise<ResearchStatus[]> {
    const selected = sources ?? this.researchers.map((researcher) => researcher.source);
    if (!Array.isArray(selected) || selected.some((source) => typeof source !== "string" || !this.states.has(source))) throw new Error("sources must contain known research sources");
    for (const source of selected) this.pending.set(source, true);
    return this.kick().then(() => this.status());
  }

  status(): ResearchStatus[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueueDue(): void {
    for (const state of this.states.values()) {
      if (!state.running && Date.parse(state.nextDueAt) <= this.clock.now() && !this.pending.has(state.source)) this.pending.set(state.source, false);
    }
    void this.kick();
  }

  private kick(): Promise<void> {
    if (this.active) return this.active;
    this.clearTimer();
    this.active = this.drain().finally(() => {
      this.active = null;
      if (!this.started) return;
      const next = Math.min(...this.status().map((state) => Date.parse(state.nextDueAt)));
      if (Number.isFinite(next)) this.timer = this.clock.setTimeout(() => this.enqueueDue(), Math.max(0, next - this.clock.now()));
    });
    return this.active;
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      // A batch keeps GitHub's rate-limit stop in force for the whole run. Manual refreshes alone bypass the cache.
      const force = [...this.pending.values()].some(Boolean);
      const selected = this.researchers.filter((researcher) => this.pending.get(researcher.source) === force);
      for (const researcher of selected) {
        this.pending.delete(researcher.source);
        const state = this.states.get(researcher.source) as ResearchStatus;
        state.running = true;
        state.lastRunAt = new Date(this.clock.now()).toISOString();
      }
      let summaries: SourceSummary[] = [];
      try {
        summaries = await this.run(this.db, selected, { ...this.runOptions, now: new Date(this.clock.now()), concurrency: 4, force });
      } catch {
        // A failed runner must release the loop so the next cadence can retry.
      }
      for (const researcher of selected) {
        const state = this.states.get(researcher.source) as ResearchStatus;
        const summary = summaries.find((row) => row.source === researcher.source);
        state.running = false;
        state.lastOk = summary !== undefined && summary.failed === 0;
        state.asked = summary?.asked ?? 0;
        state.answered = summary?.answers ?? 0;
        state.failed = summary?.failed ?? 1;
        const delay = state.lastOk ? researcher.ttlMs : Math.min(researcher.ttlMs, 3_600_000);
        state.nextDueAt = new Date(this.clock.now() + delay).toISOString();
      }
    }
  }
}
