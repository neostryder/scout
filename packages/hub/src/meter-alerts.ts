import { MeterAlertTracker, latestMeters, updateMeterAlertsFile, type ActiveMeterAlert, type Db, type MeterAlertSettings, type OutageNotice } from "@scout/core";
import type { Notifier } from "./notify.ts";

export interface MeterAlertsOptions {
  /** The settings, read from `.scout-data/meter-alerts.json` and re-read when the file changes. */
  settings: () => MeterAlertSettings;
  path: string;
  notifier: Pick<Notifier, "send" | "channels">;
  now?: () => number;
  log?: (line: string) => void;
}

/** Runs after each meter cycle: sends the quiet notices the tracker produces and keeps the list of alerts that are up. */
export class HubMeterAlerts {
  private db: Db;
  private options: MeterAlertsOptions;
  private tracker = new MeterAlertTracker();

  constructor(db: Db, options: MeterAlertsOptions) {
    this.db = db;
    this.options = options;
  }

  async check(): Promise<OutageNotice[]> {
    const names = new Map((this.db.prepare("SELECT id, name FROM machines").all() as { id: string; name: string }[]).map((row) => [row.id, row.name]));
    const notices = this.tracker.evaluate(latestMeters(this.db), names, this.options.settings(), (this.options.now ?? Date.now)());
    for (const notice of notices) {
      try { await this.options.notifier.send(notice); } catch (error) { (this.options.log ?? console.error)(`meter alert notice failed (${(error as Error).message})`); }
    }
    return notices;
  }

  status(): { settings: MeterAlertSettings; channels: { discord: boolean; desktop: boolean }; active: ActiveMeterAlert[] } {
    return { settings: this.options.settings(), channels: this.options.notifier.channels(), active: this.tracker.active() };
  }

  /** Applies a page edit (any of the `disk`, `memory`, and `vram` rules) and returns the new status. */
  update(body: unknown): ReturnType<HubMeterAlerts["status"]> {
    updateMeterAlertsFile(this.options.path, this.options.settings(), body);
    return this.status();
  }
}
