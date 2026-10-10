import { connect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { hubMachineId, evaluateAlerts, healthDomain, retainHealthSamples, storeHealthSample, syncHealthTargets, type AlertChange, type AlertOptions, type Db, type HealthIdentity, type HealthNotice, type HealthSample } from "@scout/core";

export const HEALTH_TIMEOUT_MS = 5_000;
export interface HealthHttpResponse { status: number; body?: { cancel(): Promise<unknown> } | null }
export interface HealthRequest { method: "HEAD" | "GET"; redirect: "manual"; credentials: "omit"; headers: { "User-Agent": string }; signal: AbortSignal }
export type HealthFetch = (url: string, options: HealthRequest) => Promise<HealthHttpResponse>;
export interface HealthTls { notAfter: string | null; trusted: boolean; error?: string | null }
export type HealthTlsReader = (hostname: string, signal: AbortSignal) => Promise<HealthTls>;
export interface HealthProbeOptions {
  fetch?: HealthFetch;
  tls?: HealthTlsReader;
  now?: () => number;
  timeoutMs?: number;
  /** Starts a stall meter and returns a function that stops it and gives the worst event-loop stall in milliseconds. Tests replace it. */
  watchStall?: () => () => number;
}
export interface HealthCycleOptions extends HealthProbeOptions {
  tunnelHosts?: Record<string, string>;
  publish?: (notice: HealthNotice) => void;
  alerts?: AlertOptions;
  evaluate?: typeof evaluateAlerts;
  onAlerts?: (changes: AlertChange[]) => void;
  log?: (line: string) => void;
}

export type HealthTlsSocket = Pick<TLSSocket, "once" | "destroy" | "getPeerCertificate" | "authorized">;

export function readHealthTls(hostname: string, signal: AbortSignal, dial: (options: ConnectionOptions) => HealthTlsSocket = connect): Promise<HealthTls> {
  if (!healthDomain(hostname)) return Promise.resolve({ notAfter: null, trusted: false, error: "invalid hostname" });
  return new Promise((resolve) => {
    let finished = false;
    let socket: HealthTlsSocket | undefined;
    const finish = (result: HealthTls): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      socket?.destroy();
      resolve(result);
    };
    const abort = (): void => finish({ notAfter: null, trusted: false, error: "timeout" });
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      // The reader needs the expiry date even when the certificate cannot be verified.
      socket = dial({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: false });
      socket.once("error", () => finish({ notAfter: null, trusted: false, error: "TLS connection error" }));
      socket.once("close", () => finish({ notAfter: null, trusted: false, error: "TLS connection closed" }));
      socket.once("secureConnect", () => {
        try {
          const expiry = Date.parse(socket!.getPeerCertificate().valid_to);
          const trusted = socket!.authorized;
          finish({ notAfter: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null, trusted, error: trusted ? null : "certificate not trusted" });
        } catch { finish({ notAfter: null, trusted: false, error: "certificate unavailable" }); }
      });
    } catch { finish({ notAfter: null, trusted: false, error: "TLS connection error" }); }
  });
}

function nonHttp(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; cause?: unknown };
  return typeof row.code === "string" && (/^HPE_/.test(row.code) || ["UND_ERR_SOCKET", "ECONNRESET"].includes(row.code)) || row.cause !== undefined && nonHttp(row.cause);
}

/** A failed probe is tried again once when this process stalled for at least this long while it ran, since the stall, not the address, may have used up the time. */
export const STALL_RETRY_MS = 750;
const STALL_TICK_MS = 100;

function watchLoopStall(): () => number {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const at = performance.now();
    worst = Math.max(worst, at - last - STALL_TICK_MS);
    last = at;
  }, STALL_TICK_MS);
  timer.unref();
  return () => { clearInterval(timer); return worst; };
}

export async function probeHealth(target: HealthIdentity, options: HealthProbeOptions = {}): Promise<HealthSample> {
  const stop = (options.watchStall ?? watchLoopStall)();
  const first = await probeOnce(target, options);
  const stalled = stop();
  const retryable = !first.ok && !first.notHttp && (first.error === "timeout" || first.error === "connection error" || first.error === "TLS connection error");
  if (!retryable || stalled < STALL_RETRY_MS) return first;
  return probeOnce(target, options);
}

async function probeOnce(target: HealthIdentity, options: HealthProbeOptions = {}): Promise<HealthSample> {
  const now = options.now ?? Date.now;
  const started = now();
  const sample: HealthSample = { at: new Date(started).toISOString(), ok: false, status: null, latencyMs: null, error: null, tlsNotAfter: null };
  const domain = target.kind === "domain" && healthDomain(target.label) && target.key === `domain:${target.label}` && target.url === `https://${target.label}/`;
  const listener = target.kind === "listener" && target.machineId === hubMachineId() && Number.isInteger(target.port) && target.port! > 0 && target.port! <= 65535 && target.key === `listener:${hubMachineId()}:${target.port}` && target.url === `http://127.0.0.1:${target.port}/`;
  if (!domain && !listener) return { ...sample, error: "invalid target" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, options.timeoutMs ?? HEALTH_TIMEOUT_MS);
  });
  const work = async (): Promise<void> => {
    try {
      const request = async (method: HealthRequest["method"]): Promise<number> => {
        const response = await (options.fetch ?? fetch)(target.url, { method, redirect: "manual", credentials: "omit", headers: { "User-Agent": "scout-health/1" }, signal: controller.signal });
        const status = response.status;
        await response.body?.cancel();
        return status;
      };
      let status = await request("HEAD");
      if (status === 405 || status === 501) status = await request("GET");
      sample.latencyMs = Math.max(0, now() - started);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        sample.notHttp = listener;
        sample.error = "not HTTP";
      } else {
        sample.status = status;
        sample.ok = status < 500;
        sample.error = sample.ok ? null : `HTTP ${status}`;
      }
    } catch (error) {
      sample.latencyMs = Math.max(0, now() - started);
      sample.notHttp = listener && !controller.signal.aborted && nonHttp(error);
      sample.error = controller.signal.aborted ? "timeout" : sample.notHttp ? "not HTTP" : "connection error";
    }
    if (domain && !controller.signal.aborted) {
      try {
        const tls = await (options.tls ?? readHealthTls)(target.label, controller.signal);
        sample.tlsNotAfter = tls.notAfter;
        if (tls.notAfter !== null && !tls.trusted) sample.error = "certificate not trusted";
        else if (tls.error && sample.error === null) sample.error = tls.error;
      } catch { if (sample.error === null) sample.error = "TLS connection error"; }
    }
  };
  try {
    await Promise.race([work(), timeout]);
    if (controller.signal.aborted) return { ...sample, ok: false, latencyMs: Math.max(0, now() - started), error: "timeout", notHttp: false };
    return { ...sample };
  } finally { clearTimeout(timer); }
}

export async function runHealthCycle(db: Db, options: HealthCycleOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const targets = syncHealthTargets(db, new Date(now()).toISOString(), options.tunnelHosts);
  const groups = new Map<string, HealthIdentity[]>();
  for (const target of targets) {
    const host = new URL(target.url).hostname;
    const group = groups.get(host) ?? [];
    group.push(target);
    groups.set(host, group);
  }
  const pending = [...groups.values()];
  let done = 0;
  const publish = (notice: HealthNotice): void => {
    try { options.publish?.(notice); } catch { /* A closed stream must not interrupt sample storage. */ }
  };
  const progress = (running: boolean): void => publish({ kind: "health-run", data: { running, done, total: targets.length } });
  progress(true);
  try {
    const worker = async (): Promise<void> => {
      let group;
      while ((group = pending.shift())) for (const target of group) {
        const sample = await probeHealth(target, options);
        const change = storeHealthSample(db, target.key, sample);
        if (change) publish({ kind: "health", data: change });
        done++;
        progress(true);
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, worker));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const at = new Date(now()).toISOString();
    retainHealthSamples(db, at);
    try {
      const changes = (options.evaluate ?? evaluateAlerts)(db, at, { ...options.alerts, tunnelHosts: options.tunnelHosts ?? options.alerts?.tunnelHosts });
      options.onAlerts?.(changes);
    }
    catch { (options.log ?? console.error)("Alert evaluation failed; the next probe cycle will retry."); }
    db.prepare("INSERT INTO meta (key, value) VALUES ('health_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(at);
  } finally { progress(false); }
}
