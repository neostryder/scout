import { backupAlertState, backupNotice, type BackupReading, type OutageNotice } from "@scout/core";
import type { HubAlerts } from "./alerts.ts";
import type { Notifier } from "./notify.ts";

export interface BackupWatchOptions {
  /** Reads the backup's health file; called every interval and by the alert evaluation itself. */
  read: () => BackupReading;
  notifier: Pick<Notifier, "send">;
  machineName: () => string;
  intervalMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Checks the backup's health file on a timer. Alerts are otherwise evaluated only when a scan or a live read lands, which says nothing about a
 * file that changes by itself, so a change in the reading starts an evaluation and sends one quiet notice when the alert is raised and one when it clears.
 */
export class HubBackupWatch {
  private alerts: HubAlerts;
  private options: BackupWatchOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastState: "alert" | "clear" = "clear";
  private lastSignature: string | null = null;

  constructor(alerts: HubAlerts, options: BackupWatchOptions) {
    this.alerts = alerts;
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async check(): Promise<OutageNotice | null> {
    const reading = this.options.read();
    const state = backupAlertState(reading);
    const signature = JSON.stringify(reading);
    if (signature === this.lastSignature) return null;
    this.lastSignature = signature;
    this.alerts.evaluate((this.options.now ?? (() => new Date()))().toISOString());
    if (state === "hold") return null;
    const notice = backupNotice(this.lastState, state, reading, this.options.machineName());
    this.lastState = state;
    if (notice) {
      try { await this.options.notifier.send(notice); } catch (error) { (this.options.log ?? console.error)(`backup notice failed (${(error as Error).message})`); }
    }
    return notice;
  }
}
