import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dependencyGroups, dependencyPairs, quietWindow, type Db, type OutageNotice } from "@scout/core";
import { planWindows, type Runner } from "@scout/ops";
import type { ScheduleClock } from "./schedule.ts";
import { createJobsResponse } from "./jobs-api.ts";

export const WINDOW_TICK_MS = 60_000;
/** The most updates one automatic run queues for a machine; what is left waits for the next window. */
export const WINDOW_CAP_PER_MACHINE = 15;
export const WINDOW_CAP_MAX = 100;

export interface WindowRunState {
  enabled: boolean;
  /** Start of the last window that was acted on, so a window runs once. */
  lastWindowStart: string | null;
  lastQueued: number;
  lastRunAt: string | null;
  /** The most updates one run queues for a machine. */
  cap: number;
  /** Updates the last run left for the next window because a machine was at its cap. */
  lastDeferred: number;
  /** Set when a failed job switched the run off, and cleared when it is switched on again. */
  pausedReason: string | null;
  /** The batches the last run queued, watched until their jobs finish. */
  batchIds: string[];
}

export interface WindowRunOptions {
  /** JSON file holding the switch and the last run. Without it the state lives in memory. */
  path?: string;
  clock?: ScheduleClock;
  offsetMinutes?: () => number;
  log?: (line: string) => void;
  tickMs?: number;
  /** The cap a state file without one starts with. */
  cap?: number;
  /** Sends the finish and failure notices. Without it the run only logs. */
  notifier?: { send(notice: OutageNotice): Promise<unknown> };
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

const isCap = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= WINDOW_CAP_MAX;

function readState(path: string | undefined, cap: number): WindowRunState {
  const empty: WindowRunState = { enabled: false, lastWindowStart: null, lastQueued: 0, lastRunAt: null, cap, lastDeferred: 0, pausedReason: null, batchIds: [] };
  if (!path || !existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowRunState>;
    return {
      enabled: raw.enabled === true,
      lastWindowStart: typeof raw.lastWindowStart === "string" ? raw.lastWindowStart : null,
      lastQueued: Number.isSafeInteger(raw.lastQueued) ? raw.lastQueued! : 0,
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
      cap: isCap(raw.cap) ? raw.cap : cap,
      lastDeferred: Number.isSafeInteger(raw.lastDeferred) ? raw.lastDeferred! : 0,
      pausedReason: typeof raw.pausedReason === "string" ? raw.pausedReason : null,
      batchIds: Array.isArray(raw.batchIds) ? raw.batchIds.filter((id): id is string => typeof id === "string") : [],
    };
  } catch { return empty; }
}

/** Picks at most `cap` of the ordered installs, keeping each dependency group whole so a library never runs without what uses it. The first group always goes, even past the cap, so a large group cannot starve. */
export function capInstalls(db: Db, ids: number[], cap: number): { chosen: number[]; deferred: number } {
  if (ids.length <= cap) return { chosen: ids, deferred: 0 };
  const groupOf = new Map<number, number[]>();
  for (const group of dependencyGroups(ids, dependencyPairs(db, ids))) for (const id of group) groupOf.set(id, group);
  const chosen = new Set<number>();
  for (const id of ids) {
    const group = groupOf.get(id)!;
    if (chosen.has(id)) continue;
    if (chosen.size === 0 || chosen.size + group.length <= cap) for (const member of group) chosen.add(member);
  }
  return { chosen: ids.filter((id) => chosen.has(id)), deferred: ids.length - chosen.size };
}

/** Queues each machine's planned updates once when the quiet window opens, only while the switch is on. A window the hub was down for is skipped, never made up later. A failed job switches the run off, and a finished run sends a notice. */
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
    this.state = readState(options.path, isCap(options.cap) ? options.cap : WINDOW_CAP_PER_MACHINE);
  }

  status(): WindowRunState { return { ...this.state }; }

  setEnabled(enabled: boolean): WindowRunState {
    this.state = { ...this.state, enabled, ...(enabled ? { pausedReason: null, batchIds: [] } : {}) };
    this.save();
    if (enabled && this.started) this.tick();
    return this.status();
  }

  /** Sets how many updates one run may queue for a machine. */
  setCap(cap: number): WindowRunState {
    if (!isCap(cap)) throw new Error(`cap must be a whole number from 1 to ${WINDOW_CAP_MAX}`);
    this.state = { ...this.state, cap };
    this.save();
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
    this.review();
    if (!this.state.enabled) return 0;
    const now = new Date(this.clock.now());
    const offset = this.options.offsetMinutes?.() ?? -now.getTimezoneOffset();
    const window = quietWindow(now, offset);
    if (!window.inWindow || this.state.lastWindowStart === window.startsAt) return 0;
    if (this.state.batchIds.length > 0) {
      this.options.log?.("update window: the last run is still going, so this window is skipped");
      this.state = { ...this.state, lastWindowStart: window.startsAt };
      this.save();
      return 0;
    }
    // The window is marked first, so a failure part way never queues the same updates twice.
    this.state = { ...this.state, lastWindowStart: window.startsAt, lastQueued: 0, lastDeferred: 0, lastRunAt: now.toISOString() };
    this.save();
    let queued = 0;
    let deferred = 0;
    const batchIds: string[] = [];
    const cap = this.state.cap;
    try {
      for (const machine of planWindows(this.db, this.runner.deps.machines, now, offset).machines) {
        const wanted = [...machine.now, ...machine.atQuietHour].map((item) => item.installId);
        if (wanted.length === 0) continue;
        const { chosen: installIds, deferred: left } = capInstalls(this.db, wanted, cap);
        deferred += left;
        if (left > 0) this.options.log?.(`update window: ${machine.machineId} has ${wanted.length} updates, so ${left} wait for the next window`);
        const result = createJobsResponse(this.db, this.runner, { installIds, confirm: true, allowDisruptive: true });
        const body = result.body as { batchId?: string | null; jobs?: unknown[]; refused?: { installId: number; reason: string }[] };
        queued += body.jobs?.length ?? 0;
        if (body.batchId) batchIds.push(body.batchId);
        for (const entry of body.refused ?? []) this.options.log?.(`update window: ${machine.machineId} install ${entry.installId} left out: ${entry.reason}`);
      }
    } catch (error) {
      this.options.log?.(`update window: ${error instanceof Error ? error.message : "run failed"}`);
    }
    this.state = { ...this.state, lastQueued: queued, lastDeferred: deferred, batchIds };
    this.save();
    this.options.log?.(`update window: queued ${queued} update${queued === 1 ? "" : "s"}`);
    return queued;
  }

  /** Watches the last run's jobs: the first failure switches the run off and says so, and a clean finish sends a summary. */
  private review(): void {
    const ids = this.state.batchIds;
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(", ");
    const jobs = this.db.prepare(`SELECT j.state, j.message, j.machine_id AS machine, COALESCE(p.name, 'an install') AS name FROM jobs j LEFT JOIN installs i ON i.id = j.install_id LEFT JOIN packages p ON p.id = i.package_id WHERE j.batch_id IN (${marks}) ORDER BY j.id`).all(...ids) as { state: string; message: string | null; machine: string; name: string }[];
    const count = (state: string): number => jobs.filter((job) => job.state === state).length;
    const failed = jobs.find((job) => job.state === "failed");
    if (failed && this.state.pausedReason === null) {
      const reason = `${failed.name} failed on ${failed.machine}${failed.message ? `: ${failed.message}` : ""}`;
      this.state = { ...this.state, enabled: false, pausedReason: reason };
      this.save();
      this.options.log?.(`update window: paused because ${reason}`);
      this.notify({ title: "Scout paused the automatic update run", body: `${reason}. ${count("failed")} failed so far and ${count("done")} finished. Turn the run back on in the update planner after a look at the Jobs page.`, severity: "high" });
    }
    if (jobs.some((job) => ["queued", "preflight", "running"].includes(job.state))) return;
    this.state = { ...this.state, batchIds: [] };
    this.save();
    const summary = `${count("done")} finished, ${count("failed")} failed, ${count("stopped")} stopped`;
    this.options.log?.(`update window: run complete (${summary})`);
    if (!failed) this.notify({ title: "Scout finished the automatic update run", body: `${summary}${this.state.lastDeferred > 0 ? `; ${this.state.lastDeferred} more wait for the next window` : ""}.`, severity: "info" });
  }

  private notify(notice: OutageNotice): void {
    void this.options.notifier?.send(notice).catch((error: unknown) => this.options.log?.(`update window: notice not sent: ${error instanceof Error ? error.message : "failed"}`));
  }

  private save(): void {
    const path = this.options.path;
    if (!path) return;
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(temp, path);
  }
}
