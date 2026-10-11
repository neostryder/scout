import type { Db } from "@scout/core";
import { runMeterCycle, type MeterCycleOptions, type MeterMachine } from "@scout/ops";
import type { LiveClock } from "./live.ts";

export const METER_IDLE_SECONDS = 60;
export const METER_ACTIVE_SECONDS = 10;
/** A view counts as open for this long after its last request, so a closed tab drops the cadence back to idle. */
export const METER_ACTIVE_WINDOW_MS = 30_000;

export interface MeterScheduleOptions {
  machines: () => MeterMachine[];
  clock?: LiveClock;
  cycle?: typeof runMeterCycle;
  cycleOptions?: MeterCycleOptions;
  log?: (line: string) => void;
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

/** Samples every machine about every 10 s while a meters view has asked for data in the last 30 s, and every 60 s otherwise. */
export class MeterSchedule {
  private db: Db;
  private options: MeterScheduleOptions;
  private clock: LiveClock;
  private started = false;
  private running = false;
  private lastTouch = Number.NEGATIVE_INFINITY;
  private startedAt: number | null = null;
  private timer: unknown;

  constructor(db: Db, options: MeterScheduleOptions) {
    this.db = db;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
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

  /** A meters view asked for data. Pulls the next read forward when the schedule was idle. */
  touch(): void {
    const wasActive = this.active();
    this.lastTouch = this.clock.now();
    if (!wasActive) this.arm();
  }

  intervalSeconds(): number {
    return this.active() ? METER_ACTIVE_SECONDS : METER_IDLE_SECONDS;
  }

  refresh(): boolean {
    if (this.running) return false;
    this.running = true;
    this.startedAt = this.clock.now();
    this.clear();
    void this.execute();
    return true;
  }

  private active(): boolean {
    return this.clock.now() - this.lastTouch < METER_ACTIVE_WINDOW_MS;
  }

  private clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.clear();
    if (!this.started || this.running) return;
    const at = Math.max(this.clock.now(), (this.startedAt ?? this.clock.now()) + this.intervalSeconds() * 1000);
    this.timer = this.clock.setTimeout(() => this.refresh(), at - this.clock.now());
  }

  private async execute(): Promise<void> {
    try {
      await (this.options.cycle ?? runMeterCycle)(this.db, this.options.machines(), { ...this.options.cycleOptions, now: () => new Date(this.clock.now()).toISOString(), ...(this.options.log ? { log: this.options.log } : {}) });
    } catch { (this.options.log ?? console.error)("Meter cycle failed; the next cycle will retry."); }
    finally { this.running = false; this.arm(); }
  }
}
