import type { IncomingMessage, ServerResponse } from "node:http";
import { cloudflareReader, listRoutes, loadTunnelHosts, type Db, type RouteRow, type RouteState } from "@scout/core";
import type { CloudflareSchedule } from "./cloudflare.ts";

type SendJson = (res: ServerResponse, status: number, value: unknown) => void;

const STATES = ["ok", "origin-down", "dns-dangling", "no-origin", "unknown"] as const;
const MAX_BODY = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function choice(params: URLSearchParams, key: string): RouteState | undefined {
  const value = params.get(key);
  if (value === null || value === "") return undefined;
  return (STATES as readonly string[]).includes(value) ? value as RouteState : undefined;
}

function paging(params: URLSearchParams): { limit: number; offset: number } {
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 200,
    offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
  };
}

function textQuery(params: URLSearchParams): string | undefined {
  const text = params.get("q")?.trim();
  return text ? text : undefined;
}

function facet(rows: { value: string; label?: string }[]): { value: string; label?: string; count: number }[] {
  const counts = new Map<string, { count: number; label?: string }>();
  for (const row of rows) {
    const current = counts.get(row.value);
    if (current) current.count += 1;
    else counts.set(row.value, { count: 1, ...(row.label !== undefined ? { label: row.label } : {}) });
  }
  return [...counts.entries()]
    .map(([value, item]) => ({ value, count: item.count, ...(item.label !== undefined ? { label: item.label } : {}) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function narrow(rows: RouteRow[], machine: string | undefined, state: RouteState | undefined, except?: "machine" | "state"): RouteRow[] {
  return rows.filter((row) =>
    (except === "machine" || machine === undefined || row.machineId === machine) &&
    (except === "state" || state === undefined || row.state === state)
  );
}

function routesBody(db: Db, params: URLSearchParams, enabled: boolean, tunnelHosts: Record<string, string>): unknown {
  const machine = params.get("machine")?.trim() || undefined;
  const state = choice(params, "state");
  const q = textQuery(params);
  const pool = listRoutes(db, { tunnelHosts, ...(q ? { q } : {}) });
  const matched = narrow(pool, machine, state);
  const { limit, offset } = paging(params);
  const facetRows = (except?: "machine" | "state"): RouteRow[] => narrow(pool, machine, state, except);
  return {
    reader: cloudflareReader(db, enabled),
    total: matched.length,
    rows: matched.slice(offset, offset + limit),
    facets: {
      machine: facet(facetRows("machine").flatMap((row) => row.machineId ? [{ value: row.machineId, label: row.machineName ?? row.machineId }] : [])),
      state: facet(facetRows("state").map((row) => ({ value: row.state, label: row.state }))),
      via: facet(facetRows().map((row) => ({ value: row.via, label: row.via }))),
    },
    generatedAt: new Date().toISOString(),
  };
}

function overviewBody(db: Db, enabled: boolean, tunnelHosts: Record<string, string>): unknown {
  const rows = listRoutes(db, { tunnelHosts });
  const count = (state: RouteState): number => rows.filter((row) => row.state === state).length;
  return {
    reader: cloudflareReader(db, enabled),
    totals: {
      domains: rows.length,
      ok: count("ok"),
      originDown: count("origin-down"),
      dnsDangling: count("dns-dangling"),
      noOrigin: count("no-origin"),
      unknown: count("unknown"),
    },
    generatedAt: new Date().toISOString(),
  };
}

async function readJson(req: IncomingMessage, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson): Promise<Record<string, unknown> | undefined> {
  const origin = req.headers.origin;
  if (origin !== undefined && !hostAllowed(URL.canParse(origin) ? new URL(origin).host : undefined)) {
    json(res, 403, { error: "cross-origin request refused" });
    return undefined;
  }
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    json(res, 415, { error: "content type must be application/json" });
    return undefined;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      json(res, 413, { error: "body too large" });
      return undefined;
    }
  }
  try {
    const body = JSON.parse(raw) as unknown;
    if (!isRecord(body)) throw new Error("body must be an object");
    return body;
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
    return undefined;
  }
}

export async function routesApi(db: Db, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson, cloudflare: CloudflareSchedule | undefined, tunnelHostsPath?: string): Promise<void> {
  const path = url.pathname;
  if (path === "/api/services/routes/refresh") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req, res, hostAllowed, json);
    if (!body) return;
    if (!cloudflare) return json(res, 404, { error: "cloudflare reader is off" });
    const result = cloudflare.refresh();
    if (!result.started) return json(res, 200, { started: false, reason: "running" });
    return json(res, 202, { started: true });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
  const enabled = cloudflare !== undefined;
  if (path === "/api/services/routes") return json(res, 200, routesBody(db, url.searchParams, enabled, loadTunnelHosts(tunnelHostsPath)));
  if (path === "/api/services/routes/overview") return json(res, 200, overviewBody(db, enabled, loadTunnelHosts(tunnelHostsPath)));
  return json(res, 404, { error: "no such route" });
}
