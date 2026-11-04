import { incidentIsOpen, parsePacket, reconcileCatalog, redact, redactPacket, fingerprint, remotePackets, remoteUnreachable, runArgv, type Db, type Exec, type IncidentPacket, type RemoteObservation, type Transport } from "@scout/core";
import type { FleetService, TimerHandle } from "./fleet.ts";

export interface FleetRemoteOptions {
  machines: () => { id: string; transport: Transport }[];
  exec?: Exec;
  now?: () => Date;
  every?: (fn: () => void, ms: number) => TimerHandle;
  log?: (line: string) => void;
  intervalMs?: number;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "failed";
  return redact(message).text.replace(/https?:\/\/\S+/gi, "[redacted:url]").replace(/\bBearer\s+\S+/gi, "[redacted:bearer]").slice(0, 200);
}

function defaultEvery(fn: () => void, ms: number): TimerHandle {
  const timer = setInterval(fn, ms);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function capped(text: string): string {
  return new TextDecoder().decode(Buffer.from(text).subarray(0, 65_536), { stream: true });
}

export class FleetRemoteSource {
  private db: Db;
  private fleet: FleetService;
  private machines: FleetRemoteOptions["machines"];
  private exec: Exec;
  private now: () => Date;
  private every: NonNullable<FleetRemoteOptions["every"]>;
  private log: (line: string) => void;
  private intervalMs: number;
  private timer: TimerHandle | undefined;
  private busy = false;

  constructor(db: Db, fleet: FleetService, options: FleetRemoteOptions) {
    this.db = db;
    this.fleet = fleet;
    this.machines = options.machines;
    this.exec = options.exec ?? runArgv;
    this.now = options.now ?? (() => new Date());
    this.every = options.every ?? defaultEvery;
    this.log = options.log ?? (() => undefined);
    this.intervalMs = options.intervalMs ?? 120_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.every(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    this.timer?.stop();
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const file = this.fleet.config();
      const config = file.sources?.remote;
      if (file.fileError || config?.enabled !== true) return;
      const previous = new Map<string, IncidentPacket>();
      const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'fleet_remote_state'").get() as { value: string } | undefined;
      if (stored) {
        const items: unknown = JSON.parse(stored.value);
        if (!Array.isArray(items)) throw new Error("invalid remote source state");
        for (const item of items) {
          const parsed = parsePacket(item);
          if (!parsed.ok) throw new Error("invalid remote source packet");
          previous.set(parsed.packet.fingerprint, parsed.packet);
        }
      }
      const machines = new Map(this.machines().map((machine) => [machine.id, machine.transport]));
      const observations: RemoteObservation[] = [];
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < config.checks.length) {
          const index = cursor++;
          const entry = config.checks[index]!;
          const transport = machines.get(entry.machine);
          if (!transport) {
            observations[index] = { kind: "missing-machine", index };
            continue;
          }
          try {
            const result = await this.exec(transport, entry.argv, entry.timeoutSeconds * 1000, undefined, undefined, { maxOutputBytes: 65_536 });
            observations[index] = { kind: "result", index, result: { code: result.exitCode, stdout: capped(result.stdout), stderr: capped(result.stderr), error: result.exitCode === -1 ? "timeout" : null } };
          } catch (error) {
            observations[index] = { kind: "result", index, result: { code: null, stdout: "", stderr: "", error: safeError(error) } };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, config.checks.length) }, () => worker()));
      const now = this.now().toISOString();
      const current = remotePackets(config, observations, now).map((item) => {
        const safe = redactPacket(item);
        safe.summary = safe.summary.slice(0, 299);
        if (safe.evidence.journalTail !== undefined) safe.evidence.journalTail = safe.evidence.journalTail.slice(0, 1500);
        if (safe.evidence.stderrTail !== undefined) safe.evidence.stderrTail = safe.evidence.stderrTail.slice(0, 1500);
        return safe;
      });
      // A check that could not run says nothing about its incident, so an open one is carried forward instead of recovering.
      const held = new Set<string>();
      for (const [index, observation] of observations.entries()) {
        if (observation?.kind !== "result" || !remoteUnreachable(observation.result)) continue;
        const entry = config.checks[index]!;
        const prior = previous.get(fingerprint(entry.machine, entry.component, entry.failureClass));
        if (!prior || current.some((item) => item.fingerprint === prior.fingerprint)) continue;
        // A recovery in progress is paused rather than counted: a check that could not run is not a clean check.
        if (prior.recovered) held.add(prior.fingerprint);
        else current.push(prior);
      }
      const reconciled = reconcileCatalog(previous, current, now, (key) => incidentIsOpen(this.db, key));
      const next = reconciled.next;
      const send = reconciled.send.filter((item) => !held.has(item.fingerprint));
      if (send.length > 0) {
        const result = await this.fleet.accept(send);
        if (result.rejected.length > 0) throw new Error("remote source packets were rejected");
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('fleet_remote_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...next.values()]));
    } catch (error) {
      this.log(`fleet remote tick failed: ${safeError(error)}`);
    } finally {
      this.busy = false;
    }
  }
}
