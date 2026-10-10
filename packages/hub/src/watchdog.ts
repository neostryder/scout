import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Notifier } from "./notify.ts";

// Watches the hub from outside it. The hub writes .scout-data/heartbeat.json every 30 seconds; this process alerts when the file goes quiet and again when it moves.
// It runs on Windows, macOS, and Linux, uses the same Discord and desktop channels as the hub, and never reads the catalog.

export const STALE_SECONDS = 180;
export const INTERVAL_SECONDS = 60;

export interface WatchdogOptions {
  heartbeatPath: string;
  notifier: Notifier;
  staleSeconds?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export class Watchdog {
  private silentSince: number | null = null;
  private options: WatchdogOptions;

  constructor(options: WatchdogOptions) {
    this.options = options;
  }

  private beat(): number | null {
    try {
      const at = Date.parse((JSON.parse(readFileSync(this.options.heartbeatPath, "utf8")) as { at?: unknown }).at as string);
      return Number.isFinite(at) ? at : null;
    } catch { return null; }
  }

  /** One look at the heartbeat. Returns what it announced, if anything. */
  async check(): Promise<"silent" | "recovered" | null> {
    const at = this.beat();
    if (at === null) return null;
    const now = (this.options.now ?? Date.now)();
    const age = now - at;
    const limit = (this.options.staleSeconds ?? STALE_SECONDS) * 1000;
    const log = this.options.log ?? console.error;
    if (age > limit && this.silentSince === null) {
      this.silentSince = at;
      log(`heartbeat is ${Math.round(age / 1000)} s old`);
      await this.options.notifier.send({ title: "Scout hub is not responding", body: `The hub has not written a heartbeat since ${new Date(at).toLocaleString()}. Outage checks are not running.`, severity: "high" });
      return "silent";
    }
    if (age <= limit && this.silentSince !== null) {
      const span = formatSpan(at - this.silentSince);
      this.silentSince = null;
      log(`heartbeat resumed after ${span}`);
      await this.options.notifier.send({ title: "Scout hub recovered", body: `The hub is writing heartbeats again after ${span}.`, severity: "info" });
      return "recovered";
    }
    return null;
  }
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const args = process.argv.slice(2);
  const option = (name: string, fallback: number): number => {
    const index = args.indexOf(name);
    const value = index >= 0 ? Number(args[index + 1]) : fallback;
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const logPath = join(root, ".scout-data", "watch-hub.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const log = (line: string): void => { try { appendFileSync(logPath, `[watchdog] ${new Date().toISOString()} ${line}\n`); } catch { /* the log is a convenience */ } };
  const watchdog = new Watchdog({ heartbeatPath: join(root, ".scout-data", "heartbeat.json"), notifier: new Notifier({ log }), staleSeconds: option("--stale", STALE_SECONDS), log });
  const every = option("--interval", INTERVAL_SECONDS) * 1000;
  log("started");
  const tick = (): void => { watchdog.check().catch(() => log("a check failed")).finally(() => setTimeout(tick, every)); };
  tick();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
