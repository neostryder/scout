// Posts the hub's heartbeat to the relay-heartbeat Worker, a dead-man's switch that lives outside this machine. The local heartbeat.json write and the watchdog are unchanged.
// A post that cannot be sent is dropped: it is never retried inside the same beat, never throws, and never holds the next beat back.

export const RELAY_URL = "https://relay-heartbeat.rpgm-tools.workers.dev/beat/scout";
export const RELAY_SECRET = "SCOUT_HEARTBEAT_BEAT_TOKEN";
export const RELAY_TIMEOUT_MS = 10_000;
/** How long to wait before asking the secret store again after it failed. */
export const TOKEN_RETRY_MS = 300_000;

export type RelayFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>;

export interface RelayOptions {
  url?: string;
  /** The beat token. It is read once and held in memory only. A thrown error means it is not available yet. */
  token: () => Promise<string>;
  fetch?: RelayFetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** One heartbeat post per call. The log gets a line when the relay goes quiet and another when it answers again, not one per beat. */
export class RelayBeat {
  private options: RelayOptions;
  private token: string | null = null;
  private tokenRetryAt = 0;
  private inFlight = false;
  private failing = false;

  constructor(options: RelayOptions) {
    this.options = options;
  }

  /** Starts a post and returns at once. */
  post(): void {
    void this.send();
  }

  private note(ok: boolean, reason: string): void {
    if (ok === !this.failing) return;
    this.failing = !ok;
    (this.options.log ?? console.error)(ok ? "The heartbeat relay answers again." : `The heartbeat relay could not be reached: ${reason}.`);
  }

  private async send(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = (this.options.now ?? Date.now)();
      if (this.token === null) {
        if (now < this.tokenRetryAt) return;
        try { this.token = (await this.options.token()).trim(); } catch { this.token = null; }
        if (!this.token) {
          this.token = null;
          this.tokenRetryAt = now + TOKEN_RETRY_MS;
          this.note(false, "the beat token is not available");
          return;
        }
      }
      const doFetch = this.options.fetch ?? (fetch as unknown as RelayFetch);
      const response = await doFetch(this.options.url ?? RELAY_URL, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
      if (response.status === 401 || response.status === 403) {
        // The stored token may have been rotated, so read it again at the next beat window.
        this.token = null;
        this.tokenRetryAt = now + TOKEN_RETRY_MS;
        this.note(false, `the relay refused the token (${response.status})`);
      } else if (response.status === 204) this.note(true, "");
      else this.note(false, `the relay answered ${response.status}`);
    } catch (err) {
      // The error text can quote the request, so only its kind is kept.
      this.note(false, err instanceof Error && err.name === "TimeoutError" ? "no answer in time" : "the network failed");
    } finally {
      this.inFlight = false;
    }
  }
}
