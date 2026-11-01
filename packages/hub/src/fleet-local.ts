import { open, stat, statfs } from "node:fs/promises";
import { localPackets, parsePacket, reconcileCatalog, redact, redactPacket, windowsEventQuery, type Db, type IncidentPacket, type LocalObservation } from "@scout/core";
import { runCommandCapture, type FleetService, type FleetServiceOptions, type TimerHandle } from "./fleet.ts";

export interface FleetLocalOptions {
  now?: () => Date;
  every?: (fn: () => void, ms: number) => TimerHandle;
  log?: (line: string) => void;
  intervalMs?: number;
  statfs?: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  runCapture?: FleetServiceOptions["runCapture"];
  readTail?: (path: string, bytes: number) => Promise<string>;
  stat?: (path: string) => Promise<{ mtimeMs: number }>;
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

async function readTail(path: string, bytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("log path is not a regular file");
    const size = Math.min(bytes, info.size);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, Math.max(0, info.size - size));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export class FleetLocalSource {
  private db: Db;
  private fleet: FleetService;
  private now: () => Date;
  private every: NonNullable<FleetLocalOptions["every"]>;
  private log: (line: string) => void;
  private intervalMs: number;
  private statfs: NonNullable<FleetLocalOptions["statfs"]>;
  private runCapture: NonNullable<FleetLocalOptions["runCapture"]>;
  private readTail: NonNullable<FleetLocalOptions["readTail"]>;
  private stat: NonNullable<FleetLocalOptions["stat"]>;
  private timer: TimerHandle | undefined;
  private busy = false;

  constructor(db: Db, fleet: FleetService, options: FleetLocalOptions = {}) {
    this.db = db;
    this.fleet = fleet;
    this.now = options.now ?? (() => new Date());
    this.every = options.every ?? defaultEvery;
    this.log = options.log ?? (() => undefined);
    this.intervalMs = options.intervalMs ?? 120_000;
    this.statfs = options.statfs ?? statfs;
    this.runCapture = options.runCapture ?? runCommandCapture;
    this.readTail = options.readTail ?? readTail;
    this.stat = options.stat ?? stat;
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
      const config = file.sources?.local;
      if (file.fileError || config?.enabled !== true) return;
      const previous = new Map<string, IncidentPacket>();
      const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'fleet_local_state'").get() as { value: string } | undefined;
      if (stored) {
        const items: unknown = JSON.parse(stored.value);
        if (!Array.isArray(items)) throw new Error("invalid local source state");
        for (const item of items) {
          const parsed = parsePacket(item);
          if (!parsed.ok) throw new Error("invalid local source packet");
          previous.set(parsed.packet.fingerprint, parsed.packet);
        }
      }
      const run = async (program: string, args: string[]) => {
        try {
          return await this.runCapture(program, args, "", 15_000);
        } catch (error) {
          return { code: null, stdout: "", error: (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "ENOENT" : safeError(error) };
        }
      };
      const probes: Promise<LocalObservation>[] = config.disk.paths.map(async (path): Promise<LocalObservation> => {
        try { return { kind: "disk", path, ...await this.statfs(path) }; }
        catch (error) { return { kind: "disk-error", path, error: safeError(error) }; }
      });
      for (const [index, entry] of config.windowsEvents.entries()) {
        probes.push(run("wevtutil.exe", ["qe", entry.log, `/q:${windowsEventQuery(entry)}`, "/c:20", "/rd:true", "/f:xml"]).then((result) => ({ kind: "windowsEvents", index, result })));
      }
      if (config.wsl.enabled) probes.push(run("wsl.exe", ["--status"]).then((result) => ({ kind: "wsl", result })));
      for (const [index, entry] of config.logs.entries()) {
        probes.push((async (): Promise<LocalObservation> => {
          try {
            const [info, text] = await Promise.all([this.stat(entry.path), this.readTail(entry.path, entry.tailKilobytes * 1024)]);
            return { kind: "log", index, text, mtimeMs: info.mtimeMs };
          } catch (error) {
            return { kind: "log-error", index, error: safeError(error) };
          }
        })());
      }
      const observations = await Promise.all(probes);
      const now = this.now().toISOString();
      const current = localPackets(config, observations, now).map((item) => {
        const safe = redactPacket(item);
        safe.summary = safe.summary.slice(0, 299);
        if (safe.evidence.journalTail !== undefined) safe.evidence.journalTail = safe.evidence.journalTail.slice(0, 1500);
        if (safe.evidence.stderrTail !== undefined) safe.evidence.stderrTail = safe.evidence.stderrTail.slice(0, 1500);
        return safe;
      });
      const { send, next } = reconcileCatalog(previous, current, now);
      if (send.length > 0) {
        const result = await this.fleet.accept(send);
        if (result.rejected.length > 0) throw new Error("local source packets were rejected");
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('fleet_local_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...next.values()]));
    } catch (error) {
      this.log(`fleet local tick failed: ${safeError(error)}`);
    } finally {
      this.busy = false;
    }
  }
}
