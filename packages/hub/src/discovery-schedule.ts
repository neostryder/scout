import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { OutageNotice } from "@scout/core";
import type { ScheduleClock } from "./schedule.ts";

export const DISCOVERY_INTERVAL_MS = 7 * 86_400_000;
export const DISCOVERY_START_DELAY_MS = 30 * 60_000;
export const DISCOVERY_TICK_MS = 3_600_000;

export interface DiscoveryRunResult { gathered: number; judged: number; offered: number; rejected: number; errors: number; error: string | null; held?: number; shadowRead?: number; shadowLaya?: number; shadowJev?: number; offeredNames?: string[] }

export interface DiscoveryState {
  lastRunAt: string | null;
  lastResult: DiscoveryRunResult | null;
  lastError: string | null;
}

export interface DiscoveryScheduleOptions {
  /** Runs one discovery pass. It throws when discovery is not configured. */
  run: () => Promise<DiscoveryRunResult>;
  /** The state file, kept in the data folder. */
  path?: string;
  clock?: ScheduleClock;
  intervalMs?: number;
  startDelayMs?: number;
  tickMs?: number;
  notifier?: { send(notice: OutageNotice): Promise<unknown> };
  log?: (line: string) => void;
}

export interface DiscoveryStatus extends DiscoveryState { running: boolean; intervalSeconds: number }

const CLOCK: ScheduleClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const EMPTY: DiscoveryState = { lastRunAt: null, lastResult: null, lastError: null };

function readState(path: string | undefined): DiscoveryState {
  if (!path || !existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DiscoveryState>;
    return {
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : null,
      lastResult: raw.lastResult && typeof raw.lastResult === "object" ? raw.lastResult : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    };
  } catch { return { ...EMPTY }; }
}

const DIGEST_NAMES = 5;

/** One short summary per search: what was offered and by name, and how many look-alikes of dismissed projects were held back. Nothing to say, nothing sent. */
export function digestNotice(result: DiscoveryRunResult): OutageNotice | null {
  const held = result.held ?? 0;
  if (result.offered === 0 && held === 0) return null;
  const names = result.offeredNames ?? [];
  const shown = names.slice(0, DIGEST_NAMES).join(", ");
  const more = names.length > DIGEST_NAMES ? `, and ${names.length - DIGEST_NAMES} more` : "";
  const parts: string[] = [];
  if (result.offered > 0) parts.push(`${result.offered} new ${result.offered === 1 ? "project" : "projects"} to review${shown ? `: ${shown}${more}` : ""}.`);
  if (held > 0) parts.push(`${held} ${held === 1 ? "project was" : "projects were"} held back because ${held === 1 ? "it reads" : "they read"} like ones you dismissed. Release any that were wrong on the Competitors page.`);
  parts.push(`The search read ${result.gathered} and judged ${result.judged}.`);
  if ((result.shadowRead ?? 0) > 0) parts.push(`Laya, running beside Jev, called ${result.shadowLaya ?? 0} of ${result.shadowRead} worth tracking, and Jev called ${result.shadowJev ?? 0}.`);
  return { title: result.offered > 0 ? "Scout found possible competitors" : "Scout held back possible competitors", body: parts.join(" "), severity: "info" };
}

/** Looks for new competitors about once a week. Each pass is cheap and bounded, and everything it finds waits as a candidate until it is accepted. */
export class DiscoverySchedule {
  private options: DiscoveryScheduleOptions;
  private clock: ScheduleClock;
  private state: DiscoveryState;
  private timer: unknown;
  private started = false;
  private active = false;

  constructor(options: DiscoveryScheduleOptions) {
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.state = readState(options.path);
  }

  status(): DiscoveryStatus {
    return { ...this.state, running: this.active, intervalSeconds: (this.options.intervalMs ?? DISCOVERY_INTERVAL_MS) / 1000 };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const loop = (): void => { void this.tick(); this.timer = this.clock.setTimeout(loop, this.options.tickMs ?? DISCOVERY_TICK_MS); };
    this.timer = this.clock.setTimeout(loop, this.options.startDelayMs ?? DISCOVERY_START_DELAY_MS);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  runNow(): { started: true } | { started: false; reason: string } {
    if (this.active) return { started: false, reason: "a discovery run is already going" };
    void this.pass();
    return { started: true };
  }

  private async tick(): Promise<void> {
    if (this.active) return;
    const due = this.state.lastRunAt === null || this.clock.now() - Date.parse(this.state.lastRunAt) >= (this.options.intervalMs ?? DISCOVERY_INTERVAL_MS);
    if (due) await this.pass();
  }

  private async pass(): Promise<void> {
    this.active = true;
    const at = new Date(this.clock.now()).toISOString();
    try {
      const result = await this.options.run();
      this.state = { lastRunAt: at, lastResult: result, lastError: result.error };
      this.save();
      const digest = digestNotice(result);
      if (digest) this.notify(digest);
      if (result.error) this.notify({ title: "Scout stopped looking for competitors early", body: result.error, severity: "high" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "discovery failed";
      // A pass that could not start is retried next week like any other, so one broken setup does not spend anything every hour.
      this.state = { ...this.state, lastRunAt: at, lastError: message };
      this.save();
      this.options.log?.(`discovery: ${message}`);
    } finally {
      this.active = false;
    }
  }

  private save(): void {
    if (!this.options.path) return;
    const temp = `${this.options.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(temp, this.options.path);
  }

  private notify(notice: OutageNotice): void {
    void this.options.notifier?.send(notice).catch((error: unknown) => this.options.log?.(`discovery: notice not sent: ${error instanceof Error ? error.message : "failed"}`));
  }
}
