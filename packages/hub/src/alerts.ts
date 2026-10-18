import { alertMutes, alertsFileReader, evaluateAlerts, loadTunnelHosts, refreshAlertMutes, type AlertChange, type AlertOptions, type Db, type WatchConfig } from "@scout/core";

export interface HubAlertOptions {
  alertsPath?: string;
  tunnelHostsPath?: string;
  evaluate?: typeof evaluateAlerts;
  log?: (line: string) => void;
  loadPorts?: AlertOptions["loadPorts"];
  /** Reads the backup health file; omit it and no backup alert is raised. */
  loadBackup?: AlertOptions["loadBackup"];
  /** The outage watch's config, so a service it reports is not also reported the moment it stops. */
  loadWatch?: () => WatchConfig;
  /** Evaluations requested within this many milliseconds of each other run once, so several machines finishing a scan together do not stack full checks on the event loop. Zero runs each request at once. */
  coalesceMs?: number;
}

export class HubAlerts {
  private db: Db;
  private config: HubAlertOptions;
  private loadMutes: NonNullable<AlertOptions["loadMutes"]>;
  private listeners = new Set<(change: AlertChange) => void>();
  private muteStamp: string | null = null;
  private pending: { timer: ReturnType<typeof setTimeout>; now: string; machines: Set<string> } | null = null;

  constructor(db: Db, config: HubAlertOptions = {}) {
    this.db = db;
    this.config = config;
    this.loadMutes = alertsFileReader(config.alertsPath ?? ".scout-data/alerts.json");
  }

  options(): AlertOptions {
    return { loadMutes: this.loadMutes, loadPorts: this.config.loadPorts, ...(this.config.loadBackup ? { loadBackup: this.config.loadBackup } : {}), tunnelHosts: loadTunnelHosts(this.config.tunnelHostsPath), ...(this.config.loadWatch ? { loadWatch: this.config.loadWatch } : {}) };
  }

  subscribe(listener: (change: AlertChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(changes: AlertChange[]): void {
    for (const change of changes) for (const listener of this.listeners) {
      try { listener(change); } catch { /* A closed stream must not interrupt alert storage. */ }
    }
  }

  refreshMutes(): void {
    const file = this.loadMutes();
    const stamp = JSON.stringify({ file, mutes: alertMutes(this.db, file) });
    if (stamp === this.muteStamp) return;
    this.publish(refreshAlertMutes(this.db, { ...this.options(), loadMutes: () => file }));
    this.muteStamp = stamp;
  }

  evaluate(now: string, machineId?: string): void {
    const wait = this.config.coalesceMs ?? 0;
    if (wait <= 0) { this.run(now, machineId === undefined ? [] : [machineId]); return; }
    if (this.pending) {
      this.pending.now = now;
      if (machineId !== undefined) this.pending.machines.add(machineId);
      return;
    }
    const pending = { timer: setTimeout(() => {
      this.pending = null;
      this.run(pending.now, [...pending.machines]);
    }, wait), now, machines: new Set<string>(machineId === undefined ? [] : [machineId]) };
    pending.timer.unref();
    this.pending = pending;
  }

  /** Stops a waiting evaluation; the hub calls it on close. */
  stop(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private run(now: string, machines: string[]): void {
    try {
      this.publish((this.config.evaluate ?? evaluateAlerts)(this.db, now, { ...this.options(), ...(machines.length === 1 ? { machineId: machines[0]! } : machines.length > 1 ? { machineIds: machines } : {}) }));
    } catch {
      (this.config.log ?? console.error)("Alert evaluation failed; the next read will retry.");
    }
  }
}
