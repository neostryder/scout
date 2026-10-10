import { resetHealthFailures, type Db, type HealthNotice, type HealthProbeStatus } from "@scout/core";
import { runHealthCycle, type HealthCycleOptions } from "@scout/ops";
import type { LiveClock } from "./live.ts";

export interface HealthScheduleOptions {
  scheduled?: boolean;
  intervalSeconds?: number;
  clock?: LiveClock;
  cycle?: typeof runHealthCycle;
  probe?: HealthCycleOptions;
  log?: (line: string) => void;
}

export function healthOptionsFromArgs(args: string[]): HealthScheduleOptions | false {
  const index = args.indexOf("--health-interval");
  const value = index < 0 ? "120" : args[index + 1];
  const intervalSeconds = Number(value);
  if (!value || value.startsWith("--") || !Number.isInteger(intervalSeconds) || intervalSeconds < 30) throw new Error("health interval must be an integer of at least 30 seconds");
  return args.includes("--no-health") ? false : { intervalSeconds, scheduled: !args.includes("--no-schedule") };
}

const CLOCK: LiveClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class HealthSchedule {
  private db: Db;
  private options: HealthScheduleOptions;
  private clock: LiveClock;
  private listeners = new Set<(notice: HealthNotice) => void>();
  private intervalSeconds: number;
  private watchers = 0;
  private started = false;
  private running = false;
  private lastRunAt: string | null;
  private nextRunAt: string | null = null;
  private timer: unknown;
  private startedAt: number | null = null;

  constructor(db: Db, options: HealthScheduleOptions = {}) {
    const interval = options.intervalSeconds ?? 120;
    if (!Number.isInteger(interval) || interval < 30) throw new Error("health interval must be an integer of at least 30 seconds");
    this.db = db;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.intervalSeconds = interval;
    this.lastRunAt = (db.prepare("SELECT value FROM meta WHERE key = 'health_last_run'").get() as { value: string } | undefined)?.value ?? null;
    resetHealthFailures(db);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.running) this.refresh();
  }

  stop(): void {
    this.started = false;
    this.clear();
  }

  status(): HealthProbeStatus {
    return { running: this.running, lastRunAt: this.lastRunAt, nextRunAt: this.nextRunAt, intervalSeconds: this.watchers > 0 ? 60 : this.intervalSeconds };
  }

  subscribe(listener: (notice: HealthNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  watch(): () => void {
    this.watchers++;
    this.arm();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.watchers--;
      this.arm();
    };
  }

  refresh(): boolean {
    if (this.running) return false;
    this.running = true;
    this.startedAt = this.clock.now();
    this.clear();
    void this.execute();
    return true;
  }

  private clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = null;
  }

  private arm(): void {
    this.clear();
    if (!this.started || this.running) return;
    const at = Math.max(this.clock.now(), (this.startedAt ?? this.clock.now()) + this.status().intervalSeconds * 1000);
    this.nextRunAt = new Date(at).toISOString();
    this.timer = this.clock.setTimeout(() => this.refresh(), at - this.clock.now());
  }

  private async execute(): Promise<void> {
    try {
      await (this.options.cycle ?? runHealthCycle)(this.db, {
        ...this.options.probe,
        now: () => this.clock.now(),
        publish: (notice) => {
          this.options.probe?.publish?.(notice);
          for (const listener of this.listeners) {
            try { listener(notice); } catch { /* A closed stream must not stop the scheduler. */ }
          }
        },
      });
      this.lastRunAt = new Date(this.clock.now()).toISOString();
    } catch { (this.options.log ?? console.error)("Health probe cycle failed; the next cycle will retry."); }
    finally { this.running = false; this.arm(); }
  }
}
