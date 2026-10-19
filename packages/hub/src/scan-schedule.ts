import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants, setPriority } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { upsertMachine, type Db } from "@scout/core";
import { loadAllMachines, loadMachines, pausedMachineIds } from "@scout/ops";
import type { ScheduleClock } from "./schedule.ts";

export interface ScanStatus {
  machineId: string;
  lastScanAt: string | null;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  nextDueAt: string;
  running: boolean;
}

export type ScanChild = Pick<ChildProcess, "pid" | "stdout" | "stderr" | "once" | "kill">;
export interface ScanScheduleOptions {
  machinesPath: string;
  dbPath: string;
  root: string;
  intervalMs?: number;
  startupDelayMs?: number;
  timeoutMs?: number;
  clock?: ScheduleClock;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ScanChild;
  kill?: (child: ScanChild) => Promise<void> | void;
  log?: (line: string) => void;
}

export function scanIntervalFromArgs(args: string[]): number {
  const index = args.indexOf("--scan-interval");
  const value = index < 0 ? "6" : args[index + 1];
  const hours = Number(value);
  if (!value || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("--scan-interval must be an integer from 1 to 168 hours");
  return hours * 3_600_000;
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

async function killTree(child: ScanChild): Promise<void> {
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", reject);
      killer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
    });
  } else child.kill("SIGKILL");
}

export class ScanSchedule {
  private db: Db;
  private options: ScanScheduleOptions;
  private clock: ScheduleClock;
  private intervalMs: number;
  private states = new Map<string, ScanStatus>();
  private retries = new Map<string, number>();
  private started = false;
  private readyAt = 0;
  private timer: unknown;
  private active = false;
  private cancelRun: (() => void) | null = null;
  private generation = 0;

  constructor(db: Db, options: ScanScheduleOptions) {
    this.db = db;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.intervalMs = options.intervalMs ?? 6 * 3_600_000;
    this.refresh();
  }

  intervalSeconds(): number { return this.intervalMs / 1000; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.readyAt = this.clock.now() + (this.options.startupDelayMs ?? 180_000);
    this.refresh();
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.generation++;
    this.clearTimer();
    this.cancelRun?.();
  }

  status(): ScanStatus[] {
    this.refresh();
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  runNow(machineId?: string): { started: true; status: ScanStatus[] } | { started: false; reason: string } {
    this.refresh();
    if (machineId !== undefined && (!this.states.has(machineId) || !loadMachines(this.options.machinesPath).some((machine) => machine.id === machineId))) throw new Error(`unknown or paused machine: ${machineId}`);
    if (this.active) return { started: false, reason: "a catalog scan is already running" };
    const selected = this.ordered().filter((state) => machineId === undefined || state.machineId === machineId).map((state) => state.machineId);
    if (!selected.length) throw new Error("no machines available to scan");
    this.kick(selected, true);
    return { started: true, status: this.status() };
  }

  private refresh(): void {
    const paused = new Set(pausedMachineIds(this.options.machinesPath));
    for (const machine of loadAllMachines(this.options.machinesPath)) {
      const info = machine as typeof machine & { name?: string; os?: "windows" | "macos" | "linux" };
      if (paused.has(machine.id) && info.name && info.os && !this.db.prepare("SELECT 1 FROM machines WHERE id = ?").get(machine.id)) upsertMachine(this.db, { id: machine.id, name: info.name, os: info.os, kind: "host" });
    }
    const rows = this.db.prepare("SELECT id, parent_id AS parentId, kind, last_scan AS lastScanAt, state FROM machines").all() as { id: string; parentId: string | null; kind: string; lastScanAt: string | null; state: string }[];
    // A host pause also covers guests reached through that host's connection.
    for (let count = 0; count < rows.length; count++) {
      let changed = false;
      for (const row of rows) if (row.parentId && paused.has(row.parentId) && !paused.has(row.id)) { paused.add(row.id); changed = true; }
      if (!changed) break;
    }
    for (const row of rows) {
      if (paused.has(row.id) && row.state !== "paused") this.db.prepare("UPDATE machines SET state = 'paused' WHERE id = ?").run(row.id);
      else if (!paused.has(row.id) && row.state === "paused") this.db.prepare("UPDATE machines SET state = 'unknown' WHERE id = ?").run(row.id);
    }
    const enabled = loadMachines(this.options.machinesPath).filter((machine) => !(machine.transport.type === "ssh" && machine.transport.guest) && !paused.has(machine.id) && rows.find((row) => row.id === machine.id)?.kind !== "guest");
    const ids = new Set(enabled.map((machine) => machine.id));
    for (const id of this.states.keys()) if (!ids.has(id) && !this.states.get(id)?.running) this.states.delete(id);
    for (const machine of enabled) {
      const lastScanAt = rows.find((row) => row.id === machine.id)?.lastScanAt ?? null;
      const state = this.states.get(machine.id) ?? { machineId: machine.id, lastScanAt, lastRunAt: null, lastOk: null, lastError: null, nextDueAt: "", running: false };
      state.lastScanAt = lastScanAt;
      const due = this.retries.get(machine.id) ?? (lastScanAt === null ? this.clock.now() : Date.parse(lastScanAt) + this.intervalMs);
      state.nextDueAt = new Date(Math.max(due, this.started ? this.readyAt : 0)).toISOString();
      this.states.set(machine.id, state);
    }
  }

  private ordered(): ScanStatus[] {
    return [...this.states.values()].sort((a, b) => (a.lastScanAt === null ? -Infinity : Date.parse(a.lastScanAt)) - (b.lastScanAt === null ? -Infinity : Date.parse(b.lastScanAt)) || a.machineId.localeCompare(b.machineId));
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.clearTimer();
    if (!this.started || this.active) return;
    const next = Math.min(this.clock.now() + 60_000, ...[...this.states.values()].map((state) => Date.parse(state.nextDueAt)));
    this.timer = this.clock.setTimeout(() => {
      try {
        this.refresh();
        const due = this.ordered().filter((state) => Date.parse(state.nextDueAt) <= this.clock.now()).map((state) => state.machineId);
        if (due.length) this.kick(due);
        else this.arm();
      } catch (error) { this.log(`schedule failed: ${(error as Error).message}`); this.timer = this.clock.setTimeout(() => this.arm(), 60_000); }
    }, Math.max(0, next - this.clock.now()));
  }

  private kick(ids: string[], force = false): void {
    this.active = true;
    this.clearTimer();
    void this.drain(ids, force).catch((error: Error) => this.log(`schedule failed: ${error.message}`)).finally(() => {
      this.active = false;
      this.arm();
    });
  }

  private async drain(ids: string[], force: boolean): Promise<void> {
    const generation = this.generation;
    for (const id of ids) {
      if (generation !== this.generation) break;
      this.refresh();
      const state = this.states.get(id);
      if (!state || !loadMachines(this.options.machinesPath).some((machine) => machine.id === id)) continue;
      if (!force && Date.parse(state.nextDueAt) > this.clock.now()) continue;
      const start = this.clock.now();
      state.running = true;
      state.lastRunAt = new Date(start).toISOString();
      let error: string | null = null;
      try {
        const code = await this.run(id);
        const row = this.db.prepare("SELECT last_scan AS at FROM machines WHERE id = ?").get(id) as { at: string | null } | undefined;
        if (code !== 0) error = `scan exited with code ${code}`;
        else if (!row?.at || !(Date.parse(row.at) >= start)) error = "scan did not update the catalog last_scan";
      } catch (err) { error = (err as Error).message; }
      state.running = false;
      state.lastOk = error === null;
      state.lastError = error;
      if (error) { this.retries.set(id, this.clock.now() + Math.min(this.intervalMs, 3_600_000)); this.log(`[scan ${id}] failed: ${error}`); }
      else this.retries.delete(id);
      this.refresh();
    }
  }

  private log(line: string): void { (this.options.log ?? console.error)(line); }

  private run(machineId: string): Promise<number | null> {
    return new Promise((resolveRun, reject) => {
      const child = (this.options.spawn ?? spawn)(process.execPath, [resolve(this.options.root, "packages/cli/src/scan.ts"), machineId, "--db", this.options.dbPath], { cwd: this.options.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let failure: string | null = null;
      let settled = false;
      const readers = [child.stdout, child.stderr].filter((stream) => stream !== null).map((stream) => createInterface({ input: stream }));
      for (const reader of readers) reader.on("line", (line) => this.log(`[scan ${machineId}] ${line}`));
      const terminate = (reason: string): void => {
        if (failure) return;
        failure = reason;
        void Promise.resolve().then(() => (this.options.kill ?? killTree)(child)).catch((error: Error) => this.log(`[scan ${machineId}] kill failed: ${error.message}`));
      };
      const timeout = this.clock.setTimeout(() => terminate("scan timed out"), this.options.timeoutMs ?? 45 * 60_000);
      this.cancelRun = () => terminate("scan stopped");
      const finish = (code: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timeout);
        this.cancelRun = null;
        for (const reader of readers) reader.close();
        if (error || failure) reject(error ?? new Error(failure!));
        else resolveRun(code);
      };
      child.once("error", (error) => finish(null, error));
      child.once("close", (code) => finish(code));
      child.once("spawn", () => {
        if (child.pid !== undefined) try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Priority changes depend on host permissions. */ }
      });
    });
  }
}
