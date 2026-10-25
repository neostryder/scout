import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { quietWindow, type Db } from "@scout/core";
import { planWindows, type Runner } from "@scout/ops";
import type { ScheduleClock } from "./schedule.ts";
import { createJobsResponse } from "./jobs-api.ts";

export const WINDOW_TICK_MS = 60_000;

export interface WindowRunState {
  enabled: boolean;
  /** Start of the last window that was acted on, so a window runs once. */
  lastWindowStart: string | null;
  lastQueued: number;
  lastRunAt: string | null;
}

export interface WindowRunOptions {
  /** JSON file holding the switch and the last run. Without it the state lives in memory. */
  path?: string;
  clock?: ScheduleClock;
  offsetMinutes?: () => number;
  log?: (line: string) => void;
  tickMs?: number;
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

const EMPTY: WindowRunState = { enabled: false, lastWindowStart: null, lastQueued: 0, lastRunAt: null };

function readState(path: string | undefined): WindowRunState {
  if (!path || !existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowRunState>;
    return {
      enabled: raw.enabled === true,
      lastWindowStart: typeof raw.lastWindowStart === "string" ? raw.lastWindowStart : null,
      lastQueued: Number.isSafeInteger(raw.lastQueued) ? raw.lastQueued! : 0,
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
    };
  } catch { return { ...EMPTY }; }
}

/** Queues each machine's planned updates once when the quiet window opens, only while the switch is on. A window the hub was down for is skipped, never made up later. */
export class WindowRun {
  private db: Db;
  private runner: Runner;
  private options: WindowRunOptions;
  private clock: ScheduleClock;
  private state: WindowRunState;
  private timer: unknown;
  private started = false;

  constructor(db: Db, runner: Runner, options: WindowRunOptions = {}) {
    this.db = db;
    this.runner = runner;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.state = readState(options.path);
  }

  status(): WindowRunState { return { ...this.state }; }

  setEnabled(enabled: boolean): WindowRunState {
    this.state = { ...this.state, enabled };
    this.save();
    if (enabled && this.started) this.tick();
    return this.status();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const loop = (): void => { this.tick(); this.timer = this.clock.setTimeout(loop, this.options.tickMs ?? WINDOW_TICK_MS); };
    this.timer = this.clock.setTimeout(loop, 5_000);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Acts when the window is open, the switch is on, and this window has not run yet. Returns the number of jobs queued. */
  tick(): number {
    if (!this.state.enabled) return 0;
    const now = new Date(this.clock.now());
    const offset = this.options.offsetMinutes?.() ?? -now.getTimezoneOffset();
    const window = quietWindow(now, offset);
    if (!window.inWindow || this.state.lastWindowStart === window.startsAt) return 0;
    // The window is marked first, so a failure part way never queues the same updates twice.
    this.state = { ...this.state, lastWindowStart: window.startsAt, lastQueued: 0, lastRunAt: now.toISOString() };
    this.save();
    let queued = 0;
    try {
      for (const machine of planWindows(this.db, this.runner.deps.machines, now, offset).machines) {
        const installIds = [...machine.now, ...machine.atQuietHour].map((item) => item.installId);
        if (installIds.length === 0) continue;
        const result = createJobsResponse(this.db, this.runner, { installIds, confirm: true, allowDisruptive: true });
        const body = result.body as { jobs?: unknown[]; refused?: { installId: number; reason: string }[] };
        queued += body.jobs?.length ?? 0;
        for (const entry of body.refused ?? []) this.options.log?.(`update window: ${machine.machineId} install ${entry.installId} left out: ${entry.reason}`);
      }
    } catch (error) {
      this.options.log?.(`update window: ${error instanceof Error ? error.message : "run failed"}`);
    }
    this.state = { ...this.state, lastQueued: queued };
    this.save();
    this.options.log?.(`update window: queued ${queued} update${queued === 1 ? "" : "s"}`);
    return queued;
  }

  private save(): void {
    const path = this.options.path;
    if (!path) return;
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(temp, path);
  }
}
