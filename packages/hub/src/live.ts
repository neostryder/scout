import { upsertMachine, type Db, type Transport } from "@scout/core";
import { readLive, type LiveProbeUpdate, type LiveReadResult } from "@scout/ops";

// The hub machine is read directly and the page polls it closely. Other machines are reached over ssh, so they stay slower.
const FAST_WINDOWS_MS = 3_000;
const FAST_OTHER_MS = 20_000;
const SLOW_MS = 300_000;
const MAX_BACKOFF_MS = 300_000;
const PROBE_TICK_MS = 2_000;

export type LiveState = "fresh" | "stale" | "unreachable" | "never";

export interface LiveMachineConfig {
  id: string;
  name: string;
  os: "windows" | "macos" | "linux";
  transport: Transport;
}

export interface LiveMachineState {
  id: string;
  state: LiveState;
  lastLiveAt: string | null;
  cadenceMs: number;
  error: string | null;
}

export interface LiveChanged {
  machineId: string;
  tables: ("services" | "listeners")[];
  at: string;
}

export interface LiveProbeEvent {
  machineId: string;
  probe: string;
  label: string;
  phase: "start" | "done" | "failed";
  startedAt: string;
  elapsedMs: number;
  message: string | null;
}

export interface LiveMachineEvent {
  id: string;
  state: LiveState;
  lastLiveAt: string | null;
  error: string | null;
}

export type LiveNotice =
  | { kind: "changed"; data: LiveChanged }
  | { kind: "probe"; data: LiveProbeEvent }
  | { kind: "machine"; data: LiveMachineEvent };

export interface LiveClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export type LiveReader = (machine: LiveMachineConfig, options: { slow: boolean; onProbe?: (update: LiveProbeUpdate) => void }) => Promise<LiveReadResult>;

export interface LiveScheduleOptions {
  machines: LiveMachineConfig[];
  reader?: LiveReader;
  clock?: LiveClock;
}

interface ProbeRun {
  startedMs: number;
  startedAt: string;
  probe: string;
  label: string;
}

interface Runtime {
  config: LiveMachineConfig;
  state: LiveState;
  lastLiveAt: string | null;
  error: string | null;
  failures: number;
  running: boolean;
  startedAt: number | null;
  timer?: unknown;
  staleTimer?: unknown;
  probeTimer?: unknown;
  probe: ProbeRun | null;
}

const CLOCK: LiveClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    // A cadence timer should not keep the process alive after the hub has closed.
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class LiveSchedule {
  private db: Db;
  private clock: LiveClock;
  private reader: LiveReader;
  private runtimes: Runtime[];
  private listeners = new Set<(notice: LiveNotice) => void>();
  private storedListeners = new Set<(read: LiveChanged) => void>();
  private watchers = 0;
  private started = false;

  constructor(db: Db, options: LiveScheduleOptions) {
    this.db = db;
    this.clock = options.clock ?? CLOCK;
    this.reader = options.reader ?? ((machine, read) => readLive(db, machine, { slow: read.slow, ...(read.onProbe ? { onProbe: read.onProbe } : {}) }));
    this.runtimes = options.machines.map((config) => ({
      config, state: "never", lastLiveAt: null, error: null, failures: 0, running: false, startedAt: null, probe: null,
    }));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const runtime of this.runtimes) if (!runtime.running) this.kick(runtime, true);
  }

  stop(): void {
    this.started = false;
    for (const runtime of this.runtimes) {
      this.clear(runtime, "timer");
      this.clear(runtime, "staleTimer");
      this.clear(runtime, "probeTimer");
    }
  }

  status(): LiveMachineState[] {
    return this.runtimes.map((runtime) => ({
      id: runtime.config.id,
      state: runtime.state,
      lastLiveAt: runtime.lastLiveAt,
      cadenceMs: this.waitMs(runtime),
      error: runtime.error,
    }));
  }

  machines(): { id: string; name: string; os: LiveMachineConfig["os"] }[] {
    return this.runtimes.map((runtime) => ({ id: runtime.config.id, name: runtime.config.name, os: runtime.config.os }));
  }

  watcherCount(): number {
    return this.watchers;
  }

  /** The page is watching. The returned function drops that watch. */
  watch(): () => void {
    this.watchers += 1;
    if (this.watchers === 1) this.rearmAll();
    let used = false;
    return () => {
      if (used) return;
      used = true;
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0) this.rearmAll();
    };
  }

  subscribe(listener: (notice: LiveNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStored(listener: (read: LiveChanged) => void): () => void {
    this.storedListeners.add(listener);
    return () => { this.storedListeners.delete(listener); };
  }

  refresh(machineId?: string, slow = false): { started: true; machines: string[] } | { started: false; reason: "running" } {
    const targets: Runtime[] = [];
    if (machineId === undefined) targets.push(...this.runtimes);
    else {
      const found = this.runtimes.find((runtime) => runtime.config.id === machineId);
      if (!found) throw new Error("no such machine");
      targets.push(found);
    }
    const idle = targets.filter((runtime) => !runtime.running);
    if (idle.length === 0) return { started: false, reason: "running" };
    for (const runtime of idle) this.kick(runtime, slow);
    return { started: true, machines: idle.map((runtime) => runtime.config.id) };
  }

  private emit(notice: LiveNotice): void {
    for (const listener of this.listeners) {
      try { listener(notice); } catch { /* one page must not stop the others */ }
    }
  }

  private transition(runtime: Runtime, state: LiveState, error = runtime.error): void {
    const changed = runtime.state !== state;
    runtime.state = state;
    runtime.error = error;
    if (!changed) return;
    this.emit({ kind: "machine", data: { id: runtime.config.id, state, lastLiveAt: runtime.lastLiveAt, error: runtime.error } });
  }

  private baseMs(runtime: Runtime): number {
    if (this.watchers <= 0) return SLOW_MS;
    return runtime.config.os === "windows" ? FAST_WINDOWS_MS : FAST_OTHER_MS;
  }

  private waitMs(runtime: Runtime): number {
    const factor = runtime.failures === 0 ? 1 : 2 ** runtime.failures;
    return Math.min(this.baseMs(runtime) * factor, MAX_BACKOFF_MS);
  }

  /** Wait left until the next read, measured from the start of the last one so a long read is not stacked. */
  private delayAfter(runtime: Runtime): number {
    if (runtime.startedAt === null) return this.waitMs(runtime);
    return Math.max(0, this.waitMs(runtime) - (this.clock.now() - runtime.startedAt));
  }

  private clear(runtime: Runtime, key: "timer" | "staleTimer" | "probeTimer"): void {
    const timer = runtime[key];
    if (timer !== undefined) this.clock.clearTimeout(timer);
    runtime[key] = undefined;
  }

  private arm(runtime: Runtime, delay: number): void {
    this.clear(runtime, "timer");
    runtime.timer = this.clock.setTimeout(() => this.kick(runtime, false), delay);
  }

  private kick(runtime: Runtime, slow: boolean): void {
    if (runtime.running) return;
    runtime.running = true;
    runtime.startedAt = this.clock.now();
    this.clear(runtime, "timer");
    void this.execute(runtime, slow);
  }

  private rearmAll(): void {
    if (!this.started) return;
    for (const runtime of this.runtimes) {
      if (runtime.running) continue;
      const delay = this.delayAfter(runtime);
      if (delay === 0) this.kick(runtime, false);
      else this.arm(runtime, delay);
    }
  }

  private armStale(runtime: Runtime): void {
    this.clear(runtime, "staleTimer");
    runtime.staleTimer = this.clock.setTimeout(() => {
      if (!runtime.running || runtime.state === "unreachable") return;
      this.transition(runtime, "stale");
    }, this.baseMs(runtime));
  }

  private openProbe(runtime: Runtime, update: LiveProbeUpdate): void {
    this.clear(runtime, "probeTimer");
    const startedMs = this.clock.now();
    runtime.probe = { startedMs, startedAt: new Date(startedMs).toISOString(), probe: update.probe, label: update.label };
    this.emitProbe(runtime, "start", null);
    const tick = (): void => {
      if (!runtime.probe) return;
      this.emitProbe(runtime, "start", null);
      if (!runtime.probe) return;
      runtime.probeTimer = this.clock.setTimeout(tick, PROBE_TICK_MS);
    };
    runtime.probeTimer = this.clock.setTimeout(tick, PROBE_TICK_MS);
  }

  private emitProbe(runtime: Runtime, phase: LiveProbeEvent["phase"], message: string | null): void {
    if (!runtime.probe) return;
    this.emit({
      kind: "probe",
      data: {
        machineId: runtime.config.id,
        probe: runtime.probe.probe,
        label: runtime.probe.label,
        phase,
        startedAt: runtime.probe.startedAt,
        elapsedMs: this.clock.now() - runtime.probe.startedMs,
        message,
      },
    });
  }

  private closeProbe(runtime: Runtime, phase: "done" | "failed", message: string | null): void {
    if (!runtime.probe) return;
    this.clear(runtime, "probeTimer");
    this.emitProbe(runtime, phase, message);
    runtime.probe = null;
  }

  private followUp(runtime: Runtime): void {
    if (!this.started || runtime.running) return;
    const delay = this.delayAfter(runtime);
    if (delay === 0) this.kick(runtime, false);
    else this.arm(runtime, delay);
  }

  private async execute(runtime: Runtime, slow: boolean): Promise<void> {
    let result: LiveReadResult = { changed: false, tables: [], status: "failed", error: "live read failed" };
    try {
      this.armStale(runtime);
      upsertMachine(this.db, { id: runtime.config.id, name: runtime.config.name, os: runtime.config.os, kind: "host" });
      const onProbe = (update: LiveProbeUpdate): void => {
        if (update.phase === "start") this.openProbe(runtime, update);
        else this.closeProbe(runtime, update.phase, update.message);
      };
      try {
        result = await this.reader(runtime.config, { slow, onProbe });
      } catch (err) {
        result = { changed: false, tables: [], status: "failed", error: err instanceof Error ? err.message : "live read failed" };
      }
      if (!result || (result.status !== "ok" && result.status !== "partial" && result.status !== "failed")) {
        result = { changed: false, tables: [], status: "failed", error: "live read failed" };
      }
      if (!Array.isArray(result.tables)) result.tables = [];
      if (runtime.probe) this.closeProbe(runtime, result.status === "failed" ? "failed" : "done", result.status === "failed" ? result.error : null);
      this.clear(runtime, "staleTimer");
      const at = new Date(this.clock.now()).toISOString();
      if (result.status === "failed") {
        runtime.failures += 1;
        this.transition(runtime, "unreachable", result.error ?? "unreachable");
      } else {
        runtime.failures = 0;
        runtime.lastLiveAt = at;
        this.transition(runtime, "fresh", null);
      }
      // The read is finished, so a subscriber can request another one from this event.
      runtime.running = false;
      if (result.changed || result.status !== "failed") for (const listener of this.storedListeners) {
        try { listener({ machineId: runtime.config.id, tables: result.tables, at }); } catch { /* Alert subscribers must not interrupt live reads. */ }
      }
      if (result.changed) this.emit({ kind: "changed", data: { machineId: runtime.config.id, tables: result.tables, at } });
      this.followUp(runtime);
    } catch (err) {
      this.clear(runtime, "staleTimer");
      this.clear(runtime, "probeTimer");
      runtime.probe = null;
      runtime.failures += 1;
      runtime.running = false;
      this.transition(runtime, "unreachable", err instanceof Error ? err.message : "live read failed");
      this.followUp(runtime);
    }
  }
}
