import { DEFAULT_CATALOG_SCOPE, catalogPackets, parsePacket, reconcileCatalog, type CatalogServiceRow, type CatalogSourceScope, type Db, type FleetCatalogConfig, type IncidentPacket } from "@scout/core";
import type { FleetService, TimerHandle } from "./fleet.ts";

export interface FleetCatalogOptions {
  now?: () => Date;
  every?: (fn: () => void, ms: number) => TimerHandle;
  log?: (line: string) => void;
  intervalMs?: number;
}

interface StoredService extends Omit<CatalogServiceRow, "enabled" | "keepAlive"> { enabled: number | null; keepAlive: number | null }

function safeError(error: string): string {
  return error
    .replace(/https?:\/\/\S+/gi, "[redacted:url]")
    .replace(/\bBearer\s+\S+/gi, "[redacted:bearer]")
    .replace(/(?:github_pat_|ghp_|gho_)\S+/g, "[redacted:github]")
    .slice(0, 200);
}

function defaultEvery(fn: () => void, ms: number): TimerHandle {
  const timer = setInterval(fn, ms);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function scopeFor(config: FleetCatalogConfig): CatalogSourceScope {
  const compile = (patterns: string[] | undefined, fallback: RegExp[]): RegExp[] => patterns === undefined ? fallback : patterns.map((pattern) => new RegExp(pattern, "i"));
  const scope = { ...DEFAULT_CATALOG_SCOPE };
  for (const key of ["tasks", "launchd", "systemd"] as const) {
    scope[key] = { include: compile(config[key]?.include, scope[key].include), exclude: compile(config[key]?.exclude, scope[key].exclude) };
  }
  scope.windowsServices = { include: compile(config.windowsServices?.include, scope.windowsServices.include) };
  scope.neverRan = compile(config.neverRan?.tasks, scope.neverRan);
  scope.neverRanGraceDays = config.neverRan?.graceDays ?? scope.neverRanGraceDays;
  scope.staleScanMinutes = config.staleScanMinutes ?? scope.staleScanMinutes;
  return scope;
}

export class FleetCatalogSource {
  private db: Db;
  private fleet: FleetService;
  private now: () => Date;
  private every: NonNullable<FleetCatalogOptions["every"]>;
  private log: (line: string) => void;
  private intervalMs: number;
  private timer: TimerHandle | undefined;
  private busy = false;

  constructor(db: Db, fleet: FleetService, options: FleetCatalogOptions = {}) {
    this.db = db;
    this.fleet = fleet;
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
      const config = file.sources?.catalog;
      if (file.fileError || config?.enabled !== true) return;
      const rows = this.db.prepare(`SELECT machines.name AS machine, services.kind, services.name, services.state,
        services.start_mode AS startMode, services.enabled, services.last_run AS lastRun,
        services.last_result AS lastResult, services.keep_alive AS keepAlive,
        services.first_seen_at AS firstSeenAt, services.last_seen_at AS lastSeenAt
        FROM services JOIN machines ON machines.id = services.machine_id
        WHERE services.gone_at IS NULL ORDER BY services.id`).all() as unknown as StoredService[];
      const services = rows.map((row) => ({ ...row, enabled: row.enabled !== null && row.enabled !== 0, keepAlive: row.keepAlive === null ? null : row.keepAlive !== 0 }));
      const previous = new Map<string, IncidentPacket>();
      const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'fleet_catalog_state'").get() as { value: string } | undefined;
      if (stored) {
        const items: unknown = JSON.parse(stored.value);
        if (!Array.isArray(items)) throw new Error("invalid catalog source state");
        for (const item of items) {
          const parsed = parsePacket(item);
          if (!parsed.ok) throw new Error("invalid catalog source packet");
          previous.set(parsed.packet.fingerprint, parsed.packet);
        }
      }
      const now = this.now().toISOString();
      const { send, next } = reconcileCatalog(previous, catalogPackets(services, scopeFor(config), now), now);
      if (send.length > 0) {
        const result = await this.fleet.accept(send);
        if (result.rejected.length > 0) throw new Error("catalog source packets were rejected");
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('fleet_catalog_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...next.values()]));
    } catch (error) {
      this.log(`fleet catalog tick failed: ${safeError(error instanceof Error ? error.message : "failed")}`);
    } finally {
      this.busy = false;
    }
  }
}
