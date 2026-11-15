// Posts a quiet status event to Cresset every few minutes so Cresset's silence watch can tell when the hub stops. It runs beside the relay-heartbeat post, which is unchanged.
// The post goes through the client kit, so it only happens while the kit config has an active `scout-notify` sender. Like the relay post, it never throws and never holds anything back.

export const CRESSET_BEAT_MS = 300_000;

export type CressetBeatResult = "sent" | "spooled" | "off";

export interface CressetBeatOptions {
  /** Hands one beat to the kit. Resolves "off" when Scout is not set up as a Cresset sender. */
  send: () => Promise<CressetBeatResult>;
  log?: (line: string) => void;
}

/** One beat per call. The log gets a line when Cresset goes quiet and another when it answers again, not one per beat. */
export class CressetBeat {
  private options: CressetBeatOptions;
  private inFlight = false;
  private failing = false;

  constructor(options: CressetBeatOptions) {
    this.options = options;
  }

  /** Starts a beat and returns at once. */
  post(): void {
    void this.send();
  }

  private note(ok: boolean, reason: string): void {
    if (ok === !this.failing) return;
    this.failing = !ok;
    (this.options.log ?? console.error)(ok ? "The Cresset heartbeat is delivered again." : `The Cresset heartbeat could not be delivered: ${reason}.`);
  }

  private async send(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const result = await this.options.send();
      if (result === "sent") this.note(true, "");
      else if (result === "spooled") this.note(false, "Cresset could not be reached, so the kit kept the beat to send later");
    } catch (err) {
      // The error text can quote the command line, so only its kind is kept.
      this.note(false, err instanceof Error && err.name === "TimeoutError" ? "no answer in time" : "the kit failed");
    } finally {
      this.inFlight = false;
    }
  }
}
