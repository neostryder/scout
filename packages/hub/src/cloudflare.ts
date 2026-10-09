import { cloudflareReader, type Db } from "@scout/core";

export const CLOUDFLARE_START_DELAY_MS = 5_000;
export const CLOUDFLARE_INTERVAL_MS = 30 * 60 * 1000;
export const CLOUDFLARE_MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

export interface CloudflareClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface EdgeEvent {
  state: "fresh" | "failed";
  lastReadAt: string | null;
  error: string | null;
  changed: boolean;
}

export interface CloudflareReadResult {
  changed: boolean;
  state: "fresh" | "stale" | "failed";
  error: string | null;
  lastReadAt: string | null;
}

export type CloudflareRead = () => Promise<CloudflareReadResult>;

export interface CloudflareStatus {
  state: "never" | "fresh" | "stale" | "failed" | "off";
  lastReadAt: string | null;
  error: string | null;
  running: boolean;
}

const CLOCK: CloudflareClock = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function publicError(error: string | null): string | null {
  if (error === null) return null;
  if (/bearer|authorization/i.test(error)) return "cloudflare read failed";
  return error;
}

export class CloudflareSchedule {
  private db: Db;
  private clock: CloudflareClock;
  private read: CloudflareRead;
  private listeners = new Set<(event: EdgeEvent) => void>();
  private started = false;
  private running = false;
  private failures = 0;
  private startedAt = 0;
  private timer: unknown;

  constructor(db: Db, options: { read: CloudflareRead; clock?: CloudflareClock }) {
    this.db = db;
    this.clock = options.clock ?? CLOCK;
    this.read = options.read;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.running) this.arm(CLOUDFLARE_START_DELAY_MS);
  }

  stop(): void {
    this.started = false;
    this.clear();
  }

  hello(): { state: CloudflareStatus["state"]; lastReadAt: string | null; error: string | null } {
    const view = cloudflareReader(this.db, true);
    return { state: view.state, lastReadAt: view.lastReadAt, error: view.error };
  }

  status(): CloudflareStatus {
    return { ...this.hello(), running: this.running };
  }

  subscribe(listener: (event: EdgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  refresh(): { started: true } | { started: false; reason: "running" } {
    if (this.running) return { started: false, reason: "running" };
    this.kick();
    return { started: true };
  }

  private emit(event: EdgeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one page must not stop the others */ }
    }
  }

  private waitMs(): number {
    const factor = this.failures === 0 ? 1 : 2 ** Math.min(this.failures, 6);
    return Math.min(CLOUDFLARE_INTERVAL_MS * factor, CLOUDFLARE_MAX_BACKOFF_MS);
  }

  private clear(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delay: number): void {
    this.clear();
    this.timer = this.clock.setTimeout(() => this.kick(), delay);
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.clock.now();
    this.clear();
    void this.execute();
  }

  private followUp(): void {
    if (!this.started || this.running) return;
    const delay = Math.max(0, this.waitMs() - (this.clock.now() - this.startedAt));
    if (delay === 0) this.kick();
    else this.arm(delay);
  }

  private async execute(): Promise<void> {
    let result: CloudflareReadResult = { changed: false, state: "failed", error: "cloudflare read failed", lastReadAt: null };
    try {
      try { result = await this.read(); } catch { result = { changed: false, state: "failed", error: "cloudflare read failed", lastReadAt: null }; }
      if (!result || (result.state !== "fresh" && result.state !== "stale" && result.state !== "failed")) {
        result = { changed: false, state: "failed", error: "cloudflare read failed", lastReadAt: null };
      }
      if (result.state === "fresh") this.failures = 0;
      else this.failures += 1;
      this.running = false;
      this.emit({
        state: result.state === "fresh" ? "fresh" : "failed",
        lastReadAt: result.lastReadAt,
        error: publicError(result.error),
        changed: result.changed === true,
      });
      this.followUp();
    } catch {
      this.failures += 1;
      this.running = false;
      this.emit({ state: "failed", lastReadAt: null, error: "cloudflare read failed", changed: false });
      this.followUp();
    }
  }
}
