import {
  failCloudflareRead,
  recordCloudflare,
  cloudflareCounts,
  cloudflareReader,
  type CfAccessApp,
  type CfDns,
  type CfIngress,
  type CfTunnel,
  type CfWorkerRoute,
  type CfZone,
  type CloudflareSnapshot,
  type Db,
  type TunnelStatus,
} from "@scout/core";

export const CLOUDFLARE_TIMEOUT_MS = 20_000;
const RETRIES = 2;
const BASE_URL = "https://api.cloudflare.com/client/v4";
const RETRY_CAP_MS = 30_000;

export class CloudflareStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Cloudflare request failed (HTTP ${status})`);
    this.name = "CloudflareStatusError";
    this.status = status;
  }
}

export interface CloudflareRequest {
  method: string;
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

interface Envelope {
  success?: boolean;
  result?: unknown;
  result_info?: { page?: number; total_pages?: number; per_page?: number };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimeout(err: unknown): boolean {
  return isRecord(err) && (err.name === "TimeoutError" || err.name === "AbortError");
}

function statusOf(err: unknown): number | null {
  return err instanceof CloudflareStatusError ? err.status : null;
}

function retryDelay(response: Response, attempt: number, now: number): number {
  const header = response.headers.get("retry-after");
  let ms = 200 * 2 ** attempt;
  if (header !== null && header.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(header.trim())) ms = Number(header.trim()) * 1000;
    else {
      const date = Date.parse(header);
      if (!Number.isNaN(date)) ms = Math.max(0, date - now);
    }
  }
  return Math.min(Math.max(0, ms), RETRY_CAP_MS);
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function endpoint(base: string, path: string, params: CloudflareRequest["params"], page: number): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(path.replace(/^\/+/, ""), root);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  return url.toString();
}

async function onePage(input: CloudflareRequest, page: number): Promise<Envelope> {
  // Scout never changes Cloudflare. Refuse before a URL or a header is built, so the token stays out of the attempt.
  if (input.method !== "GET") throw new Error("Cloudflare client is read only");
  const fetchImpl = input.fetch ?? fetch;
  const sleep = input.sleep ?? delay;
  const timeoutMs = input.timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
  const now = input.now ?? Date.now;
  const url = endpoint(input.baseUrl ?? BASE_URL, input.path, input.params, page);
  let lastStatus = 0;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) throw new Error("Cloudflare request timed out");
      throw new Error("Cloudflare request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await drain(response);
      throw new Error("Cloudflare request failed");
    }
    if (response.status === 429 || response.status >= 500) {
      lastStatus = response.status;
      const wait = retryDelay(response, attempt, now());
      await drain(response);
      if (attempt === RETRIES) throw new CloudflareStatusError(lastStatus);
      await sleep(wait);
      continue;
    }
    if (response.status >= 400) {
      await drain(response);
      throw new CloudflareStatusError(response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("Cloudflare response was not JSON"); }
    if (!isRecord(body) || body.success === false) throw new Error("Cloudflare request failed");
    return body as Envelope;
  }
  throw new CloudflareStatusError(lastStatus || 500);
}

/** GET one Cloudflare path and follow `result_info` pages. Any other method throws before `fetch`. */
export async function cloudflareRequest(input: CloudflareRequest): Promise<unknown> {
  const first = await onePage(input, 1);
  const info = first.result_info;
  const pages = info?.total_pages ?? 1;
  if (!Array.isArray(first.result) || pages <= 1) return first.result ?? null;
  const items = [...first.result];
  for (let page = 2; page <= pages; page++) {
    const next = await onePage(input, page);
    if (Array.isArray(next.result)) items.push(...next.result);
  }
  return items;
}

export class CloudflareClient {
  private options: Omit<CloudflareRequest, "method" | "path" | "params">;
  constructor(options: Omit<CloudflareRequest, "method" | "path" | "params">) {
    this.options = options;
  }
  get(path: string, params?: CloudflareRequest["params"]): Promise<unknown> {
    return cloudflareRequest({ ...this.options, method: "GET", path, ...(params ? { params } : {}) });
  }
}

function hostName(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function tunnelStatus(value: unknown): TunnelStatus {
  return value === "healthy" || value === "degraded" || value === "down" || value === "inactive" ? value : "inactive";
}

function connectionCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (Array.isArray(value)) return value.length;
  return 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseZones(result: unknown): CfZone[] {
  if (!Array.isArray(result)) return [];
  const zones: CfZone[] = [];
  for (const item of result) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") continue;
    zones.push({ id: item.id, name: hostName(item.name) });
  }
  return zones;
}

function parseDns(result: unknown, zone: string): CfDns[] {
  if (!Array.isArray(result)) return [];
  const rows: CfDns[] = [];
  for (const item of result) {
    if (!isRecord(item) || (item.type !== "A" && item.type !== "AAAA" && item.type !== "CNAME")) continue;
    const name = text(item.name);
    const content = text(item.content) ?? "";
    if (!name) continue;
    rows.push({ zone, name: hostName(name), type: item.type, content, proxied: item.proxied === true });
  }
  return rows;
}

function parseWorkers(result: unknown, zone: string): CfWorkerRoute[] {
  if (!Array.isArray(result)) return [];
  const rows: CfWorkerRoute[] = [];
  for (const item of result) {
    if (!isRecord(item) || typeof item.pattern !== "string" || item.pattern.trim() === "") continue;
    rows.push({ zone, pattern: item.pattern.trim(), script: text(item.script) });
  }
  return rows;
}

interface ListedTunnel { id: string; name: string; status: TunnelStatus; connections: number; remoteConfig: boolean | null }

function parseTunnels(result: unknown): ListedTunnel[] {
  if (!Array.isArray(result)) return [];
  const rows: ListedTunnel[] = [];
  for (const item of result) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") continue;
    if (item.is_deleted === true || item.deleted_at) continue;
    rows.push({
      id: item.id.trim(),
      name: text(item.name) ?? item.id.trim(),
      status: tunnelStatus(item.status),
      connections: connectionCount(item.connections),
      remoteConfig: typeof item.remote_config === "boolean" ? item.remote_config : null,
    });
  }
  return rows;
}

function parseIngress(result: unknown, tunnelId: string): { local: boolean; rules: CfIngress[] } {
  if (!isRecord(result) || result.config === null || result.config === undefined) return { local: true, rules: [] };
  if (!isRecord(result.config) || !Array.isArray(result.config.ingress)) return { local: true, rules: [] };
  const rules: CfIngress[] = [];
  result.config.ingress.forEach((item, position) => {
    if (!isRecord(item) || typeof item.service !== "string" || item.service.trim() === "") return;
    const hostname = text(item.hostname);
    rules.push({
      tunnelId,
      position,
      hostname: hostname ? hostName(hostname) : null,
      path: text(item.path),
      service: item.service.trim(),
    });
  });
  return { local: false, rules };
}

function parseAccess(result: unknown): CfAccessApp[] {
  if (!Array.isArray(result)) return [];
  const rows: CfAccessApp[] = [];
  for (const item of result) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.domain !== "string") continue;
    const policies = Array.isArray(item.policies) ? item.policies.length : 0;
    rows.push({ id: item.id, name: item.name, domain: hostName(item.domain), policies });
  }
  return rows;
}

function firstAccount(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  for (const item of result) {
    if (isRecord(item) && typeof item.id === "string" && item.id.trim() !== "") return item.id.trim();
  }
  return null;
}

async function readPart<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; missing: boolean }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const status = statusOf(err);
    if (status === 403) return { ok: false, missing: false };
    if (status === 404) return { ok: false, missing: true };
    throw err;
  }
}

export interface CloudflareReadOutcome {
  changed: boolean;
  state: "fresh" | "stale" | "failed";
  error: string | null;
  lastReadAt: string | null;
  counts: ReturnType<typeof cloudflareCounts>;
}

export interface ReadCloudflareOptions {
  token: string;
  accountId?: string | null;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => string;
}

function outcome(db: Db, changed: boolean, state: CloudflareReadOutcome["state"], error: string | null): CloudflareReadOutcome {
  const view = cloudflareReader(db, true);
  return { changed, state, error: error ?? view.error, lastReadAt: view.lastReadAt, counts: cloudflareCounts(db) };
}

/** One read. A 403 degrades that part and keeps its previous rows. Any other failure keeps every previous row. */
export async function readCloudflare(db: Db, options: ReadCloudflareOptions): Promise<CloudflareReadOutcome> {
  const client = new CloudflareClient({
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const at = options.now?.() ?? new Date().toISOString();
  const degraded: string[] = [];
  try {
    let accountId = options.accountId?.trim() || null;
    if (!accountId) {
      const accounts = await readPart(() => client.get("/accounts"));
      if (!accounts.ok) throw new CloudflareStatusError(403);
      accountId = firstAccount(accounts.value);
      if (!accountId) throw new Error("Cloudflare request failed");
    }
    const zonePart = await readPart(() => client.get("/zones"));
    let zones: CfZone[] | undefined;
    if (!zonePart.ok) {
      if (!zonePart.missing) degraded.push("Zones: not permitted");
      else zones = [];
    } else zones = parseZones(zonePart.value);

    let dns: CfDns[] | undefined;
    let workers: CfWorkerRoute[] | undefined;
    if (zones) {
      dns = [];
      workers = [];
      let dnsDenied = false;
      let workersDenied = false;
      for (const zone of zones) {
        if (!dnsDenied) {
          for (const type of ["A", "AAAA", "CNAME"] as const) {
            const part = await readPart(() => client.get(`/zones/${encodeURIComponent(zone.id)}/dns_records`, { type }));
            if (!part.ok) {
              if (part.missing) continue;
              dnsDenied = true;
              degraded.push("DNS records: not permitted");
              dns = undefined;
              break;
            }
            if (dns) dns.push(...parseDns(part.value, zone.name));
          }
        }
        if (!workersDenied) {
          const part = await readPart(() => client.get(`/zones/${encodeURIComponent(zone.id)}/workers/routes`));
          if (!part.ok) {
            if (!part.missing) {
              workersDenied = true;
              degraded.push("Workers routes: not permitted");
              workers = undefined;
            }
          } else if (workers) workers.push(...parseWorkers(part.value, zone.name));
        }
      }
    }

    const tunnelPart = await readPart(() => client.get(`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, { is_deleted: false }));
    let tunnels: CfTunnel[] | undefined;
    let ingress: CfIngress[] | undefined;
    if (!tunnelPart.ok) {
      if (!tunnelPart.missing) degraded.push("Tunnels: not permitted");
      else { tunnels = []; ingress = []; }
    } else {
      const listed = parseTunnels(tunnelPart.value);
      tunnels = listed.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        connections: row.connections,
        remoteManaged: row.remoteConfig === true,
      }));
      ingress = [];
      let configDenied = false;
      for (const row of listed) {
        const stored = tunnels.find((tunnel) => tunnel.id === row.id);
        if (!stored) continue;
        if (row.remoteConfig === false) {
          stored.remoteManaged = false;
          continue;
        }
        if (configDenied) continue;
        const part = await readPart(() => client.get(`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(row.id)}/configurations`));
        if (!part.ok) {
          if (part.missing) {
            stored.remoteManaged = false;
            continue;
          }
          configDenied = true;
          degraded.push("Tunnel configuration: not permitted");
          // Keep earlier ingress rows. This tunnel was not marked local, so it stays remote and those rows are not dropped.
          ingress = undefined;
          stored.remoteManaged = true;
          continue;
        }
        const parsed = parseIngress(part.value, row.id);
        stored.remoteManaged = !parsed.local;
        if (!parsed.local && ingress) ingress.push(...parsed.rules);
      }
    }

    const accessPart = await readPart(() => client.get(`/accounts/${encodeURIComponent(accountId)}/access/apps`));
    let accessApps: CfAccessApp[] | undefined;
    if (!accessPart.ok) {
      if (!accessPart.missing) degraded.push("Access apps: not permitted");
      else accessApps = [];
    } else accessApps = parseAccess(accessPart.value);

    const snapshot: CloudflareSnapshot = {};
    if (zones) snapshot.zones = zones;
    if (dns) snapshot.dns = dns;
    if (tunnels) snapshot.tunnels = tunnels;
    if (ingress) snapshot.ingress = ingress;
    if (accessApps) snapshot.accessApps = accessApps;
    if (workers) snapshot.workerRoutes = workers;
    const error = degraded.length > 0 ? degraded.join("; ") : null;
    const recorded = recordCloudflare(db, snapshot, at, error);
    return outcome(db, recorded.changed, "fresh", error);
  } catch (err) {
    const message = err instanceof CloudflareStatusError || (err instanceof Error && (err.message === "Cloudflare request failed" || err.message === "Cloudflare request timed out" || err.message === "Cloudflare response was not JSON"))
      ? err.message
      : "Cloudflare request failed";
    const failed = failCloudflareRead(db, message);
    return outcome(db, failed.changed, failed.state, message);
  }
}
