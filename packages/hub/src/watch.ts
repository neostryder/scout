import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { hubMachineId, hubMachineName, isPaused, outageNotice, recordMonitorGap, recordObservations, resetWatchCounters, serviceObservations, settleUnwatched, updateWatchFile, urlObservations, watchedKeys, watchFileReader, type Db, type Observation, type OutageChange, type WatchConfig } from "@scout/core";
import { runMachineChecks, type MachineCheckOptions, type WatchedMachine } from "@scout/ops";
import type { HubAlerts } from "./alerts.ts";
import type { LiveClock } from "./live.ts";
import { Notifier, type ChannelResult } from "./notify.ts";

export const WATCH_INTERVAL_MS = 120_000;
export const HEARTBEAT_MS = 30_000;
/** A hub that was silent this long on start has a gap in the record. */
export const GAP_AFTER_MS = 300_000;

export interface HubWatchOptions {
  intervalMs?: number;
  machines: () => WatchedMachine[];
  configPath: string;
  heartbeatPath: string;
  /** Posts each heartbeat to the relay Worker as well as the file. Omit it and only the file is written. */
  relay?: { post(): void };
  notifier?: Notifier;
  alerts?: HubAlerts;
  clock?: LiveClock;
  check?: Pick<MachineCheckOptions, "probe" | "now">;
  /** Whether a TCP connection to a port succeeds. A test replaces it. */
  reach?: (host: string, port: number) => Promise<boolean>;
  log?: (line: string) => void;
}

const REACH_TIMEOUT_MS = 1_500;

/** True when something accepts a connection on the port. */
export function tcpReachable(host: string, port: number, timeoutMs: number = REACH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
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

interface Heartbeat { at: string; pid: number; startedAt: string }

/** Machine and web address checks every two minutes, service checks from fresh live reads, outage notices, and a heartbeat file the watchdog reads. */
export class HubWatch {
  private db: Db;
  private options: HubWatchOptions;
  private clock: LiveClock;
  private intervalMs: number;
  private readConfig: () => WatchConfig;
  private notifier: Notifier;
  private started = false;
  private running = false;
  private cycleTimer: unknown;
  private beatTimer: unknown;
  private startedAt = "";
  private lastCycleAt: string | null = null;
  private lastServiceAt = new Map<string, number>();
  private alerts: HubAlerts | undefined;

  constructor(db: Db, options: HubWatchOptions) {
    this.db = db;
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS;
    this.readConfig = watchFileReader(options.configPath);
    this.notifier = options.notifier ?? new Notifier();
    this.alerts = options.alerts;
  }

  /** The hub builds its alerts after the watch, so it hands them over once they exist. */
  attachAlerts(alerts: HubAlerts): void {
    this.alerts = alerts;
  }

  config(): WatchConfig {
    return this.readConfig();
  }

  /** The config reader, shared with the alert evaluation so both see the same switches. */
  configReader(): () => WatchConfig {
    return this.readConfig;
  }

  update(body: Record<string, unknown>): WatchConfig {
    return updateWatchFile(this.options.configPath, this.readConfig(), body);
  }

  status(): { running: boolean; intervalMs: number; lastCycleAt: string | null; paused: boolean; channels: { discord: boolean; desktop: boolean } } {
    const now = new Date(this.clock.now()).toISOString();
    return { running: this.started, intervalMs: this.intervalMs, lastCycleAt: this.lastCycleAt, paused: isPaused(this.readConfig(), now), channels: this.notifier.channels() };
  }

  /** Sends a sample notice to every channel, so a broken webhook is found before an outage needs it. */
  testNotice(): Promise<ChannelResult[]> {
    return this.notifier.send({ title: "Scout test notice", body: "If you can read this, outage notices reach you here.", severity: "info" });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = new Date(this.clock.now()).toISOString();
    this.startedAt = now;
    resetWatchCounters(this.db);
    const previous = this.readHeartbeat();
    this.writeHeartbeat();
    if (previous && this.clock.now() - Date.parse(previous.at) > GAP_AFTER_MS) {
      void this.notify([recordMonitorGap(this.db, previous.at, now, hubMachineName())]);
      this.alerts?.evaluate(now);
    }
    this.beatTimer = this.clock.setTimeout(() => this.beat(), HEARTBEAT_MS);
    // The first round waits a few seconds so the live reads that start with the hub have filled the catalog.
    this.cycleTimer = this.clock.setTimeout(() => void this.cycle(), Math.min(10_000, this.intervalMs));
  }

  stop(): void {
    this.started = false;
    if (this.cycleTimer !== undefined) this.clock.clearTimeout(this.cycleTimer);
    if (this.beatTimer !== undefined) this.clock.clearTimeout(this.beatTimer);
  }

  private readHeartbeat(): Heartbeat | null {
    try {
      const data = JSON.parse(readFileSync(this.options.heartbeatPath, "utf8")) as Partial<Heartbeat>;
      return typeof data.at === "string" && Number.isFinite(Date.parse(data.at)) ? { at: data.at, pid: Number(data.pid), startedAt: String(data.startedAt) } : null;
    } catch { return null; }
  }

  private writeHeartbeat(): void {
    try {
      mkdirSync(dirname(this.options.heartbeatPath), { recursive: true });
      const tmp = `${this.options.heartbeatPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: new Date(this.clock.now()).toISOString(), pid: process.pid, startedAt: this.startedAt }), "utf8");
      renameSync(tmp, this.options.heartbeatPath);
    } catch { (this.options.log ?? console.error)("The watch heartbeat could not be written."); }
    try { this.options.relay?.post(); } catch { /* the relay reports its own failures and must never stop a beat */ }
  }

  private beat(): void {
    if (!this.started) return;
    this.writeHeartbeat();
    this.beatTimer = this.clock.setTimeout(() => this.beat(), HEARTBEAT_MS);
  }

  private async notify(changes: OutageChange[]): Promise<void> {
    for (const change of changes) {
      // An item switched off closes its outage quietly, and a change of failure state is not worth a notice.
      if (change.change === "updated" || change.outage.detail.endsWith("(no longer watched)")) continue;
      try { await this.notifier.send(outageNotice(change)); } catch { /* the notifier logs its own failures */ }
    }
  }

  /** One round of machine and web address checks. */
  async cycle(): Promise<OutageChange[]> {
    if (this.running) return [];
    this.running = true;
    const changes: OutageChange[] = [];
    try {
      const config = this.readConfig();
      const at = new Date(this.clock.now()).toISOString();
      if (!isPaused(config, at)) {
        changes.push(...await runMachineChecks(this.db, this.options.machines(), config, { ...this.options.check, now: this.options.check?.now ?? (() => this.clock.now()) }));
        const urls = urlObservations(this.db, config, at);
        changes.push(...settleUnwatched(this.db, { kind: "url", machineId: null }, watchedKeys(urls), at), ...recordObservations(this.db, urls));
        this.lastCycleAt = at;
      }
      if (changes.length) this.alerts?.evaluate(at);
      await this.notify(changes);
    } catch (err) {
      (this.options.log ?? console.error)(`Outage watch round failed: ${err instanceof Error ? err.message : "error"}`);
    } finally {
      this.running = false;
      if (this.started) this.cycleTimer = this.clock.setTimeout(() => void this.cycle(), this.intervalMs);
    }
    return changes;
  }

  /**
   * The hub machine's own listener table is not always complete: some Windows builds drop loopback listeners from it or list them under an unknown owner, so a service
   * that is running looks gone. A listener that the table does not show is therefore confirmed by connecting to it before it counts as down. Other machines are read
   * over ssh and are not second-guessed here.
   */
  private async confirmReachable(machineId: string, observations: Observation[]): Promise<Observation[]> {
    if (machineId !== hubMachineId()) return observations;
    const reach = this.options.reach ?? tcpReachable;
    return Promise.all(observations.map(async (obs) => {
      if (obs.ok || obs.endpoint === undefined) return obs;
      if (!(await reach(obs.endpoint.host, obs.endpoint.port).catch(() => false))) return obs;
      return { ...obs, ok: true, state: "up", detail: "The port accepts connections although the listener table did not list it." };
    }));
  }

  /** A fresh, complete live read of one machine. Reads come every few seconds while a page watches, so a check counts at most once an interval. */
  async observeServices(machineId: string, at: string): Promise<OutageChange[]> {
    const nowMs = this.clock.now();
    const last = this.lastServiceAt.get(machineId);
    if (last !== undefined && nowMs - last < this.intervalMs - 15_000) return [];
    this.lastServiceAt.set(machineId, nowMs);
    const config = this.readConfig();
    if (isPaused(config, at) || !this.options.machines().some((machine) => machine.id === machineId) && machineId !== hubMachineId()) return [];
    const observations = await this.confirmReachable(machineId, serviceObservations(this.db, machineId, config, at));
    const changes = [...settleUnwatched(this.db, { kind: "service", machineId }, watchedKeys(observations), at), ...recordObservations(this.db, observations)];
    if (changes.length) {
      this.alerts?.evaluate(at);
      void this.notify(changes);
    }
    return changes;
  }
}
