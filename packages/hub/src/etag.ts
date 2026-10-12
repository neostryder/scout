import { createHash } from "node:crypto";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

/** The reads the portal polls or reloads often. Everything else under /api/ keeps its no-store, so a research status, a job, or a proposal is never kept by a browser. */
const VALIDATED = new Set(["/api/services", "/api/listeners", "/api/services/overview", "/api/services/routes", "/api/services/health", "/api/services/ports", "/api/services/stacks", "/api/services/alerts", "/api/services/outages", "/api/resources", "/api/summary"]);
const VALIDATED_PREFIXES = ["/api/installs", "/api/updates"];
const validated = (url: string): boolean => { const path = url.split("?")[0] ?? ""; return VALIDATED.has(path) || VALIDATED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/")); };

/** A cache or a CDN may weaken a validator to W/"..." or send several, so any listed value that matches ours counts. */
function holds(header: string | undefined, etag: string): boolean {
  return header !== undefined && header.split(",").some((value) => value.trim().replace(/^W\//, "") === etag);
}

/**
 * Lets a browser poll an API read cheaply. A JSON answer to a GET of one of the polled reads above carries an ETag made from its body, and a request that
 * already holds that exact answer gets a 304 with no body. The portal's polls and a phone on a slow link both benefit; the data
 * itself is unchanged and the cache is private to the browser that asked.
 */
export function revalidate(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" || !req.url || !validated(req.url)) return;
  const writeHead = res.writeHead.bind(res) as (status: number, headers?: OutgoingHttpHeaders) => ServerResponse;
  const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const end = res.end.bind(res) as (chunk?: unknown, ...rest: unknown[]) => ServerResponse;
  let held: { status: number; headers: OutgoingHttpHeaders } | null = null;
  const release = (): void => { if (held) { const { status, headers } = held; held = null; writeHead(status, headers); } };
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const headers = rest.find((value): value is OutgoingHttpHeaders => typeof value === "object" && value !== null && !Array.isArray(value)) ?? {};
    held = { status, headers };
    return res;
  }) as typeof res.writeHead;
  const flushHeaders = res.flushHeaders.bind(res) as () => void;
  res.flushHeaders = (() => { release(); flushHeaders(); }) as typeof res.flushHeaders;
  res.write = ((chunk: unknown, ...rest: unknown[]) => { release(); return write(chunk, ...rest); }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    const pending = held;
    const body = typeof chunk === "string" || Buffer.isBuffer(chunk) ? chunk : null;
    const json = pending !== null && pending.status === 200 && String(pending.headers["content-type"] ?? res.getHeader("content-type") ?? "").startsWith("application/json");
    if (!pending || body === null || !json || res.getHeader("etag") !== undefined || pending.headers["etag"] !== undefined) {
      release();
      return end(chunk, ...rest);
    }
    held = null;
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
    const headers: OutgoingHttpHeaders = { ...pending.headers, etag, "cache-control": "private, no-cache" };
    if (holds(req.headers["if-none-match"], etag)) {
      delete headers["content-type"];
      writeHead(304, headers);
      return end();
    }
    writeHead(200, headers);
    return end(body);
  }) as typeof res.end;
}
