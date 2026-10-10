import { alertMutes, alertsFileReader, evaluateAlerts, loadTunnelHosts, refreshAlertMutes, type AlertChange, type AlertOptions, type Db, type WatchConfig } from "@scout/core";

export interface HubAlertOptions {
  alertsPath?: string;
  tunnelHostsPath?: string;
  evaluate?: typeof evaluateAlerts;
  log?: (line: string) => void;
  loadPorts?: AlertOptions["loadPorts"];
  /** The outage watch's config, so a service it reports is not also reported the moment it stops. */
  loadWatch?: () => WatchConfig;
}

export class HubAlerts {
  private db: Db;
  private config: HubAlertOptions;
  private loadMutes: NonNullable<AlertOptions["loadMutes"]>;
  private listeners = new Set<(change: AlertChange) => void>();
  private muteStamp: string | null = null;

  constructor(db: Db, config: HubAlertOptions = {}) {
    this.db = db;
    this.config = config;
    this.loadMutes = alertsFileReader(config.alertsPath ?? ".scout-data/alerts.json");
  }

  options(): AlertOptions {
    return { loadMutes: this.loadMutes, loadPorts: this.config.loadPorts, tunnelHosts: loadTunnelHosts(this.config.tunnelHostsPath), ...(this.config.loadWatch ? { loadWatch: this.config.loadWatch } : {}) };
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
    try {
      this.publish((this.config.evaluate ?? evaluateAlerts)(this.db, now, { ...this.options(), ...(machineId ? { machineId } : {}) }));
    } catch {
      (this.config.log ?? console.error)("Alert evaluation failed; the next read will retry.");
    }
  }
}
