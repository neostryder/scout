import type { IncomingMessage, ServerResponse } from "node:http";
import { hubMachineId, cloudflareReader, emptyProvenance, listListeners, listServices, programFlags, type Flag, type ProvenanceContext, type Db, type Listener, type ListenerBind, type Service, type ServiceClass, type ServiceKind, type ServiceState } from "@scout/core";
import type { CloudflareSchedule } from "./cloudflare.ts";
import type { LiveMachineState, LiveSchedule } from "./live.ts";
import { DESCRIPTION_SOURCES, describeRow, descriptionsOverview, loadDescriptionResolver, setHandDescription, validateHandDescription } from "@scout/core";
import { idleDescriptionStatus, type DescriptionRun } from "./descriptions.ts";
import { controlRow, joinedInstall, listActions, protectedResponse, rowControl, uninstallInstructions, type ProtectedContext, type ProtectedFile } from "@scout/core";
import { resolveControlRow, type ControlRunner } from "@scout/ops";
import { controlPlanResponse, controlRunResponse } from "./control-api.ts";
import { acknowledgeAlerts, alertMutes, alertsResponse, alertsSummary, defaultWatchConfig, outagesResponse, setAlertMute } from "@scout/core";
import { RecipeError, recipesResponse } from "@scout/core";
import type { HubRecipes } from "./recipes.ts";
import type { HubAlerts } from "./alerts.ts";
import { healthResponse, healthSummary } from "@scout/core";
import type { HealthSchedule } from "./health.ts";
import type { HubWatch } from "./watch.ts";
import { portsFileReader, portsResponse } from "@scout/core";
import type { HubStacks } from "./stacks.ts";

interface ServicesRegistries { ports(): ReturnType<typeof portsResponse>; stacks: HubStacks }
const readPorts = portsFileReader();

export interface ServicesControl {
  runner: ControlRunner | null;
  protectedFile(): ProtectedFile;
  context(): ProtectedContext;
}

type SendJson = (res: ServerResponse, status: number, value: unknown) => void;
type Exposure = "none" | "loopback" | "lan" | "all";
type Dir = "asc" | "desc";

const SERVICE_KINDS = ["windows-service", "scheduled-task", "launchd", "systemd"] as const;
const SERVICE_STATES = ["running", "stopped", "disabled", "other"] as const;
const SERVICE_CLASSES = ["essential", "optional", "third-party"] as const;
const SERVICE_SORTS = ["name", "machine", "kind", "state", "class", "lastSeen", "ports"] as const;
const BINDS = ["loopback", "lan", "all"] as const;
const EVENT_KINDS = ["service_new", "service_gone", "service_changed", "listener_new", "listener_gone", "listener_changed"] as const;
const MAX_BODY = 4096;
const SLOW_CADENCE_MS = 120_000;
const WIDTH: Record<Exclude<Exposure, "none">, number> = { loopback: 0, lan: 1, all: 2 };

// Same policy headers as the other hub responses, plus the buffering flags the stream needs.
const STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
  "connection": "keep-alive",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

interface ServiceQuery {
  desc?: string[];
  machine?: string;
  kind?: ServiceKind;
  state?: ServiceState;
  class?: ServiceClass;
  all: boolean;
}

interface ListenerQuery {
  desc?: string[];
  machine?: string;
  bind?: ListenerBind;
  class?: ServiceClass;
  all: boolean;
}

function choice<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[]): T | undefined {
  const value = params.get(key);
  if (value === null || value === "") return undefined;
  return (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function paging(params: URLSearchParams, fallback: number, max: number): { limit: number; offset: number } {
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), max) : fallback,
    offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
  };
}

function textQuery(params: URLSearchParams): string | undefined {
  const text = params.get("q")?.trim();
  return text ? text : undefined;
}

function officialQuery(params: URLSearchParams): boolean | undefined {
  const value = params.get("official");
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

function descriptionQuery(params: URLSearchParams): string[] | undefined {
  const values = params.get("desc")?.split(",").filter((value) => [...DESCRIPTION_SOURCES, "none"].includes(value as typeof DESCRIPTION_SOURCES[number]));
  return values?.length ? values : undefined;
}

function exposureOf(ports: { bind: Exclude<Exposure, "none"> }[]): Exposure {
  let best: Exposure = "none";
  for (const port of ports) {
    if (best === "none" || WIDTH[port.bind] > WIDTH[best]) best = port.bind;
  }
  return best;
}

function shown<T extends { classification: { hidden: boolean } }>(rows: T[], all: boolean): T[] {
  return all ? rows : rows.filter((row) => !row.classification.hidden);
}

function facet(rows: { value: string; label?: string }[]): { value: string; count: number; label?: string }[] {
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

function narrowServices(rows: Service[], query: ServiceQuery, except?: "machine" | "kind" | "state" | "class" | "desc"): Service[] {
  return rows.filter((row) =>
    (except === "desc" || query.desc === undefined || query.desc.includes(row.description?.source ?? "none")) &&
    (except === "machine" || query.machine === undefined || row.machineId === query.machine) &&
    (except === "kind" || query.kind === undefined || row.kind === query.kind) &&
    (except === "state" || query.state === undefined || row.state === query.state) &&
    (except === "class" || query.class === undefined || row.classification.class === query.class)
  );
}

function serviceQuery(params: URLSearchParams): ServiceQuery {
  return {
    desc: descriptionQuery(params),
    ...(choice(params, "machine", params.getAll("machine")) ? {} : {}),
    ...(params.get("machine") ? { machine: params.get("machine") as string } : {}),
    ...(choice(params, "kind", SERVICE_KINDS) ? { kind: choice(params, "kind", SERVICE_KINDS) } : {}),
    ...(choice(params, "state", SERVICE_STATES) ? { state: choice(params, "state", SERVICE_STATES) } : {}),
    ...(choice(params, "class", SERVICE_CLASSES) ? { class: choice(params, "class", SERVICE_CLASSES) } : {}),
    all: params.get("all") === "1",
  };
}

function compareServices(a: Service, b: Service, sort: string, dir: Dir): number {
  if (sort === "ports") {
    const aEmpty = a.ports.length === 0;
    const bEmpty = b.ports.length === 0;
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    const cmp = Math.min(...a.ports.map((port) => port.port)) - Math.min(...b.ports.map((port) => port.port));
    return (dir === "desc" ? -cmp : cmp) || a.id - b.id;
  }
  const value = (row: Service): string => {
    if (sort === "name") return (row.displayName ?? row.name).toLowerCase();
    if (sort === "kind") return row.kind;
    if (sort === "state") return row.state;
    if (sort === "class") return row.classification.class;
    if (sort === "lastSeen") return row.lastSeenAt;
    return row.machineName.toLowerCase();
  };
  const cmp = value(a).localeCompare(value(b));
  return (dir === "desc" ? -cmp : cmp) || a.id - b.id;
}

/** Flags for a running program from its path and every port it holds, without repeating one. */
function rowFlags(context: ProvenanceContext, machineId: string, path: string | null, ports: number[]): Flag[] {
  const seen = new Set<string>();
  return [programFlags(machineId, path, null, context), ...ports.map((port) => programFlags(machineId, path, port, context))].flat().filter((flag) => !seen.has(flag.kind + flag.evidence) && seen.add(flag.kind + flag.evidence));
}

function servicesResponse(db: Db, params: URLSearchParams, control?: ServicesControl, provenance?: () => ProvenanceContext): unknown {
  const flagContext = provenance?.() ?? emptyProvenance();
  const context = control?.context() ?? {};
  const query = serviceQuery(params);
  const gone = params.get("gone") === "gone" ? "gone" : "present";
  const official = officialQuery(params);
  const q = textQuery(params);
  const pool = listServices(db, {
    ...(q ? { q } : {}),
    ...(params.get("hasPort") === "1" ? { hasPort: true } : {}),
    gone,
    ...(official !== undefined ? { official } : {}),
    includeHidden: true,
  });
  const matched = narrowServices(pool, query);
  const visible = shown(matched, query.all);
  const sort = choice(params, "sort", SERVICE_SORTS) ?? "machine";
  const dir: Dir = params.get("dir") === "desc" ? "desc" : "asc";
  const { limit, offset } = paging(params, 100, 500);
  const ordered = [...visible].sort((a, b) => compareServices(a, b, sort, dir));
  const facetRows = (except?: "machine" | "kind" | "state" | "class" | "desc"): Service[] => shown(narrowServices(pool, query, except), query.all);
  return {
    total: visible.length,
    hiddenCount: matched.filter((row) => row.classification.hidden).length,
    rows: ordered.slice(offset, offset + limit).map((row) => ({ ...row, exposure: exposureOf(row.ports), flags: rowFlags(flagContext, row.machineId, row.program, row.ports.map((port) => port.port)), control: rowControl(controlRow(row), context, control?.runner != null) })),
    facets: {
      description: facet(facetRows("desc").map((row) => ({ value: row.description?.source ?? "none", label: row.description?.source ?? "none" }))),
      machine: facet(facetRows("machine").map((row) => ({ value: row.machineId, label: row.machineName }))),
      kind: facet(facetRows("kind").map((row) => ({ value: row.kind }))),
      class: facet(facetRows("class").map((row) => ({ value: row.classification.class }))),
      state: facet(facetRows("state").map((row) => ({ value: row.state }))),
      exposure: facet(facetRows().map((row) => ({ value: exposureOf(row.ports) }))),
    },
  };
}

function narrowListeners(rows: Listener[], query: ListenerQuery, except?: "machine" | "bind" | "class" | "desc"): Listener[] {
  return rows.filter((row) =>
    (except === "desc" || query.desc === undefined || query.desc.includes(row.description?.source ?? "none")) &&
    (except === "machine" || query.machine === undefined || row.machineId === query.machine) &&
    (except === "bind" || query.bind === undefined || row.bind === query.bind) &&
    (except === "class" || query.class === undefined || row.classification.class === query.class)
  );
}

function joinedService(listener: Listener, services: Service[]): { serviceName: string | null; serviceKind: ServiceKind | null } {
  const mine = services.filter((service) => service.machineId === listener.machineId);
  const samePath = (service: Service): boolean => {
    if (service.program === null || listener.processPath === null) return false;
    return service.kind === "launchd" ? service.program === listener.processPath : service.program.toLowerCase() === listener.processPath.toLowerCase();
  };
  const byPid = listener.pid === null ? undefined : mine.find((service) => service.pid !== null && service.pid === listener.pid);
  const service = byPid ?? mine.find((service) => service.pid === null && samePath(service)) ?? null;
  return { serviceName: service?.name ?? null, serviceKind: service?.kind ?? null };
}

function listenersResponse(db: Db, params: URLSearchParams, control?: ServicesControl, provenance?: () => ProvenanceContext): unknown {
  const flagContext = provenance?.() ?? emptyProvenance();
  const context = control?.context() ?? {};
  const query: ListenerQuery = {
    desc: descriptionQuery(params),
    ...(params.get("machine") ? { machine: params.get("machine") as string } : {}),
    ...(choice(params, "bind", BINDS) ? { bind: choice(params, "bind", BINDS) } : {}),
    ...(choice(params, "class", SERVICE_CLASSES) ? { class: choice(params, "class", SERVICE_CLASSES) } : {}),
    all: params.get("all") === "1",
  };
  const official = officialQuery(params);
  const q = textQuery(params);
  const portRaw = params.get("port");
  const portNum = portRaw === null ? NaN : Number(portRaw);
  const port = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : undefined;
  const descriptions = loadDescriptionResolver(db);
  const pool = listListeners(db, {
    ...(q ? { q } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(official !== undefined ? { official } : {}),
    state: params.get("gone") === "gone" ? "gone" : "present",
    includeHidden: true,
  }, descriptions);
  const matched = narrowListeners(pool, query);
  const visible = shown(matched, query.all);
  const { limit, offset } = paging(params, 100, 500);
  const services = listServices(db, { gone: "present", includeHidden: true }, descriptions);
  const facetRows = (except?: "machine" | "bind" | "class" | "desc"): Listener[] => shown(narrowListeners(pool, query, except), query.all);
  return {
    total: visible.length,
    hiddenCount: matched.filter((row) => row.classification.hidden).length,
    rows: visible.slice(offset, offset + limit).map((row) => ({ ...row, ...joinedService(row, services), flags: rowFlags(flagContext, row.machineId, row.processPath, [row.port]), control: rowControl(controlRow(row, services), context, control?.runner != null) })),
    facets: {
      description: facet(facetRows("desc").map((row) => ({ value: row.description?.source ?? "none", label: row.description?.source ?? "none" }))),
      machine: facet(facetRows("machine").map((row) => ({ value: row.machineId, label: row.machineName }))),
      bind: facet(facetRows("bind").map((row) => ({ value: row.bind }))),
      class: facet(facetRows("class").map((row) => ({ value: row.classification.class }))),
    },
  };
}

function bindPhrase(bind: unknown): string {
  if (bind === "all") return "all interfaces";
  if (bind === "lan") return "LAN";
  if (bind === "loopback") return "loopback";
  return "an unknown bind";
}

function serviceLabel(kind: unknown): string {
  if (kind === "windows-service") return "service";
  if (kind === "scheduled-task") return "scheduled task";
  if (kind === "launchd") return "launchd job";
  if (kind === "systemd") return "systemd service";
  return typeof kind === "string" ? kind : "service";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventSummary(kind: string, detail: Record<string, unknown>, machineName: string): string {
  if (kind === "listener_new" || kind === "listener_gone" || kind === "listener_changed") {
    const port = typeof detail.port === "number" ? String(detail.port) : "unknown";
    const process = typeof detail.process === "string" && detail.process !== "" ? ` ${detail.process}` : "";
    if (kind === "listener_new") return `${machineName}: new listener ${port}${process} (${bindPhrase(detail.newBind)})`;
    if (kind === "listener_gone") return `${machineName}: listener ${port}${process} gone (${bindPhrase(detail.oldBind)})`;
    return `${machineName}: listener ${port}${process} now listens on ${bindPhrase(detail.newBind)}`;
  }
  const name = typeof detail.name === "string" && detail.name !== "" ? detail.name : "unknown";
  const label = serviceLabel(detail.kind);
  if (kind === "service_new") return `${machineName}: new ${label} ${name}`;
  if (kind === "service_gone") return `${machineName}: ${label} ${name} is gone`;
  const previous = isRecord(detail.old) ? detail.old.state : undefined;
  const next = isRecord(detail.new) ? detail.new.state : undefined;
  if (typeof previous === "string" && typeof next === "string" && previous !== next) return `${machineName}: ${name} changed from ${previous} to ${next}`;
  return `${machineName}: ${name} changed`;
}

function eventsResponse(db: Db, params: URLSearchParams): unknown {
  const { limit } = paging(params, 50, 200);
  const machine = params.get("machine");
  const rows = db.prepare(
    `SELECT e.id, e.at, e.machine_id AS machineId, m.name AS machineName, e.kind, e.detail_json AS detail
     FROM events e LEFT JOIN machines m ON m.id = e.machine_id
     WHERE e.kind IN (${EVENT_KINDS.map(() => "?").join(", ")}) AND (? IS NULL OR e.machine_id = ?)
     ORDER BY e.id DESC LIMIT ?`,
  ).all(...EVENT_KINDS, machine, machine, limit) as unknown as { id: number; at: string; machineId: string | null; machineName: string | null; kind: string; detail: string }[];
  return {
    events: rows.map((row) => {
      let detail: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.detail) as unknown;
        if (isRecord(parsed)) detail = parsed;
      } catch { /* a damaged event still lists, with an empty detail */ }
      return {
        id: row.id,
        at: row.at,
        machineId: row.machineId,
        kind: row.kind,
        summary: eventSummary(row.kind, detail, row.machineName ?? row.machineId ?? "unknown"),
        detail,
      };
    }),
  };
}

function liveFields(live: LiveSchedule | undefined, id: string): Omit<LiveMachineState, "id"> {
  const row = live?.status().find((item) => item.id === id);
  if (!row) return { state: "never", lastLiveAt: null, cadenceMs: SLOW_CADENCE_MS, error: null };
  return { state: row.state, lastLiveAt: row.lastLiveAt, cadenceMs: row.cadenceMs, error: row.error };
}

function overviewResponse(db: Db, live: LiveSchedule | undefined): unknown {
  const catalog = db.prepare("SELECT id, name, os, state FROM machines WHERE kind = 'host'").all() as unknown as { id: string; name: string; os: string; state?: string }[];
  const byId = new Map(catalog.map((row) => [row.id, row]));
  for (const machine of live?.machines() ?? []) if (!byId.has(machine.id)) byId.set(machine.id, machine);
  const machines = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const descriptions = loadDescriptionResolver(db);
  const services = listServices(db, { gone: "present", includeHidden: true }, descriptions).filter((row) => !row.classification.hidden);
  const listeners = listListeners(db, { state: "present", includeHidden: true }, descriptions).filter((row) => !row.classification.hidden);
  return {
    machines: machines.map((machine) => {
      const ownServices = services.filter((row) => row.machineId === machine.id);
      const ownListeners = listeners.filter((row) => row.machineId === machine.id);
      return {
        id: machine.id,
        name: machine.name,
        os: machine.os,
        hub: machine.id === hubMachineId(),
        services: {
          total: ownServices.length,
          running: ownServices.filter((row) => row.state === "running").length,
          optionalRunning: ownServices.filter((row) => row.classification.class === "optional" && row.state === "running").length,
          thirdParty: ownServices.filter((row) => row.classification.class === "third-party").length,
        },
        listeners: {
          total: ownListeners.length,
          loopback: ownListeners.filter((row) => row.bind === "loopback").length,
          lan: ownListeners.filter((row) => row.bind === "lan").length,
          all: ownListeners.filter((row) => row.bind === "all").length,
        },
        live: machine.state === "paused" ? { state: "paused", lastLiveAt: null, cadenceMs: SLOW_CADENCE_MS, error: null } : liveFields(live, machine.id),
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

function helloMachines(db: Db, live: LiveSchedule | undefined): LiveMachineState[] {
  const body = overviewResponse(db, live) as { machines: { id: string; live: Omit<LiveMachineState, "id"> }[] };
  return body.machines.map((machine) => ({ id: machine.id, ...machine.live }));
}

function edgeHello(db: Db, cloudflare: CloudflareSchedule | undefined): { state: string; lastReadAt: string | null; error: string | null } {
  if (cloudflare) return cloudflare.hello();
  const view = cloudflareReader(db, false);
  return { state: view.state, lastReadAt: view.lastReadAt, error: view.error };
}

function openStream(req: IncomingMessage, res: ServerResponse, db: Db, live: LiveSchedule | undefined, heartbeatMs: number, cloudflare: CloudflareSchedule | undefined, descriptions: DescriptionRun | undefined, control?: ServicesControl, alerts?: HubAlerts, recipes?: HubRecipes, health?: HealthSchedule, registries?: ServicesRegistries): void {
  alerts?.refreshMutes();
  let closed = false;
  const unwatch = live ? live.watch() : (): void => undefined;
  const unwatchHealth = health?.watch();
  const write = (chunk: string): void => {
    if (closed || res.writableEnded) return;
    try { res.write(chunk); } catch { close(); }
  };
  const unsubscribe = live ? live.subscribe((notice) => {
    write(`event: ${notice.kind}\ndata: ${JSON.stringify(notice.data)}\n\n`);
  }) : (): void => undefined;
  const unsubscribeEdge = cloudflare ? cloudflare.subscribe((event) => {
    write(`event: edge\ndata: ${JSON.stringify(event)}\n\n`);
  }) : (): void => undefined;
  const unsubscribeDescribe = descriptions ? descriptions.subscribe((event) => {
    write(`event: describe\ndata: ${JSON.stringify(event)}\n\n`);
  }) : (): void => undefined;
  const heartbeat = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
  const unsubscribeRecipes = recipes?.subscribe((event) => write(`event: recipe\ndata: ${JSON.stringify(event)}\n\n`));
  const unsubscribeStacks = registries?.stacks.subscribe((event) => write(`event: stack\ndata: ${JSON.stringify(event)}\n\n`));
  const unsubscribeAlerts = alerts?.subscribe((event) => write(`event: alert\ndata: ${JSON.stringify(event)}\n\n`));
  const unsubscribeHealth = health?.subscribe((notice) => write(`event: ${notice.kind}\ndata: ${JSON.stringify(notice.data)}\n\n`));
  const action = (event: unknown): void => write(`event: action\ndata: ${JSON.stringify(event)}\n\n`);
  control?.runner?.on("action", action);
  heartbeat.unref();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeEdge();
    unsubscribeDescribe();
    unsubscribeAlerts?.();
    unsubscribeRecipes?.();
    unsubscribeStacks?.();
    unsubscribeHealth?.();
    unwatchHealth?.();
    control?.runner?.off("action", action);
    unwatch();
  };
  // A finished GET request does not mean the client left. The response closes when the client does.
  req.on("close", close);
  req.on("error", close);
  res.on("close", close);
  res.on("error", close);
  // Proxies and Nagle must not hold the heartbeat or a one-line change.
  res.socket?.setNoDelay(true);
  res.writeHead(200, STREAM_HEADERS);
  res.flushHeaders();
  const summary = alertsSummary(db);
  write(`event: hello\ndata: ${JSON.stringify({ machines: helloMachines(db, live), edge: edgeHello(db, cloudflare), describe: descriptions?.status() ?? idleDescriptionStatus(), actions: { running: control?.runner?.running() ?? 0 }, recipes: (({ proposed, approved }) => ({ proposed, approved }))(recipesResponse(db).counts), stacks: registries?.stacks.summary() ?? { total: 0, running: 0 }, alerts: { open: summary.open, high: summary.high }, health: healthSummary(db, new Date().toISOString(), alerts?.options().tunnelHosts) })}\n\n`);
}

export async function readJson(req: IncomingMessage, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson): Promise<Record<string, unknown> | undefined> {
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

export async function servicesApi(db: Db, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson, live: LiveSchedule | undefined, heartbeatMs: number, cloudflare?: CloudflareSchedule, descriptions?: DescriptionRun, control?: ServicesControl, alerts?: HubAlerts, recipes?: HubRecipes, health?: HealthSchedule, registries?: ServicesRegistries, watch?: HubWatch, provenance?: () => ProvenanceContext): Promise<void> {
  const path = url.pathname;
  if (path === "/api/services/outages" || path === "/api/services/outages/watch" || path === "/api/services/outages/test") {
    const post = path !== "/api/services/outages";
    if (post ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    if (post && !watch) return json(res, 404, { error: "the outage watch is off" });
    const body = post ? await readJson(req, res, hostAllowed, json) : {};
    if (!body) return;
    try {
      if (path.endsWith("/watch")) { watch!.update(body); return json(res, 200, { ...outagesResponse(db, watch!.config(), new URLSearchParams("limit=1")), watch: watch!.status() }); }
      if (path.endsWith("/test")) {
        if (Object.keys(body).length) return json(res, 400, { error: "body must be {}" });
        return json(res, 200, { results: await watch!.testNotice() });
      }
      const config = watch?.config() ?? defaultWatchConfig();
      return json(res, 200, { ...outagesResponse(db, config, url.searchParams), watch: watch?.status() ?? null });
    } catch (error) { return json(res, 400, { error: (error as Error).message }); }
  }
  if (path === "/api/services/ports" || path === "/api/services/ports/next" || path === "/api/services/stacks") {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    if (path === "/api/services/stacks") return json(res, 200, registries?.stacks.response() ?? { stacks: [], file: { path: ".scout-data/stacks.json", exists: false, error: null }, generatedAt: new Date().toISOString() });
    const ports = registries?.ports() ?? portsResponse(db, readPorts());
    if (path.endsWith("/next")) {
      const range = ports.ranges.find((row) => row.name === url.searchParams.get("range"));
      return !range ? json(res, 404, { error: "unknown range" }) : range.next === null ? json(res, 409, { error: "range is full" }) : json(res, 200, { range: range.name, port: range.next });
    }
    return json(res, 200, ports);
  }
  if (path === "/api/services/health" || path === "/api/services/health/refresh") {
    const post = path.endsWith("/refresh");
    if (post ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    if (post && !health) return json(res, 404, { error: "health checks are off" });
    const body = post ? await readJson(req, res, hostAllowed, json) : {};
    if (!body) return;
    try {
      if (post) {
        if (Object.keys(body).length) return json(res, 400, { error: "body must be {}" });
        return health!.refresh() ? json(res, 202, { state: "running" }) : json(res, 409, { error: "a probe is already running" });
      }
      return json(res, 200, healthResponse(db, url.searchParams, new Date().toISOString(), health?.status() ?? { running: false, lastRunAt: null, nextRunAt: null, intervalSeconds: 0 }, alerts?.options().tunnelHosts));
    } catch (error) { return json(res, 400, { error: (error as Error).message }); }
  }
  if (path === "/api/services/recipes" || path === "/api/services/recipes/scan" || path === "/api/services/recipes/decide") {
    const post = path !== "/api/services/recipes";
    if (post ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    if (path.endsWith("/decide") && !control?.runner) return json(res, 404, { error: "control is off" });
    const body = post ? await readJson(req, res, hostAllowed, json) : {};
    if (!body) return;
    try {
      if (path.endsWith("/scan")) return json(res, 200, recipes?.scan() ?? { found: 0, proposed: 0 });
      if (path.endsWith("/decide")) return json(res, 200, { recipe: recipes!.decide(body) });
      return json(res, 200, recipesResponse(db, url.searchParams.get("state") ?? "all"));
    } catch (error) { return json(res, error instanceof RecipeError ? error.status : 400, { error: (error as Error).message }); }
  }
  if (path === "/api/services/alerts" || path === "/api/services/alerts/summary" || path === "/api/services/alerts/ack" || path === "/api/services/alerts/mute") {
    const post = path.endsWith("/ack") || path.endsWith("/mute");
    if (post ? req.method !== "POST" : req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const body = post ? await readJson(req, res, hostAllowed, json) : {};
    if (!body) return;
    try {
      alerts?.refreshMutes();
      if (path.endsWith("/ack")) {
        const changes = acknowledgeAlerts(db, body);
        if (changes === null) return json(res, 404, { error: "not found" });
        alerts?.publish(changes);
        return json(res, 200, { acknowledged: changes.length });
      }
      if (path.endsWith("/mute")) {
        setAlertMute(db, body);
        alerts?.refreshMutes();
        return json(res, 200, { mutes: alertMutes(db, alerts?.options().loadMutes?.()) });
      }
      return json(res, 200, path.endsWith("/summary") ? alertsSummary(db) : alertsResponse(db, url.searchParams, new Date().toISOString(), alerts?.options()));
    } catch (err) { return json(res, 400, { error: (err as Error).message }); }
  }
  if (path === "/api/services/actions/plan" || path === "/api/services/actions/run") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!control?.runner) return json(res, 404, { error: "control is off" });
    const body = await readJson(req, res, hostAllowed, json);
    if (!body) return;
    const result = path.endsWith("/plan") ? await controlPlanResponse(control.runner, body) : await controlRunResponse(control.runner, body);
    return json(res, result.status, result.body);
  }
  if (path === "/api/services/actions" || path === "/api/services/protected" || path === "/api/services/uninstall") {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    if (path === "/api/services/actions") {
      const raw = url.searchParams.get("limit");
      const limit = raw === null ? 50 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return json(res, 400, { error: "limit must be an integer from 1 to 200" });
      const machine = url.searchParams.get("machine");
      return json(res, 200, { items: listActions(db, { limit, ...(machine !== null ? { machine } : {}) }), generatedAt: new Date().toISOString() });
    }
    if (path === "/api/services/protected") return json(res, 200, protectedResponse(control?.protectedFile() ?? { config: { disable: [], names: [] }, fileError: null }));
    const target = url.searchParams.get("target");
    const id = Number(url.searchParams.get("id"));
    if (target !== "service" && target !== "listener" || !Number.isSafeInteger(id) || id <= 0) return json(res, 400, { error: "target and a positive id are required" });
    const row = resolveControlRow(db, target, id);
    return row ? json(res, 200, uninstallInstructions(row, joinedInstall(db, row))) : json(res, 404, { error: "not found" });
  }
  if (path === "/api/services/live") {
    if (req.method === "HEAD") {
      res.writeHead(200, STREAM_HEADERS);
      res.end();
      return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    return openStream(req, res, db, live, heartbeatMs, cloudflare, descriptions, control, alerts, recipes, health, registries);
  }
  if (path === "/api/services/description") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req, res, hostAllowed, json);
    if (!body) return;
    if (body.target !== "service" && body.target !== "listener") return json(res, 400, { error: "target must be service or listener" });
    if (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) return json(res, 400, { error: "id must be a positive integer" });
    const problem = validateHandDescription(body.text);
    if (problem) return json(res, 400, { error: problem });
    const resolver = loadDescriptionResolver(db);
    const rows = body.target === "service" ? listServices(db, {}, resolver) : listListeners(db, {}, resolver);
    const row = rows.find((item) => item.id === body.id);
    if (!row) return json(res, 404, { error: "not found" });
    setHandDescription(db, resolver.subject(row), body.text as string | null);
    return json(res, 200, { description: describeRow(db, row) });
  }
  if (path === "/api/services/descriptions/refresh") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req, res, hostAllowed, json);
    if (!body) return;
    if (body.scope === "project") {
      if (!descriptions) return json(res, 404, { error: "project descriptions are off" });
      try {
        const result = await descriptions.start("project");
        return result.started ? json(res, 202, result) : json(res, 200, result);
      } catch { return json(res, 404, { error: "project descriptions are off" }); }
    }
    if (body.scope !== "public") return json(res, 400, { error: "scope must be public or project" });
    if (!descriptions) return json(res, 404, { error: "descriptions model is off" });
    const result = descriptions.start("public");
    return result.started ? json(res, 202, { started: true }) : json(res, 200, result);
  }
  if (path === "/api/services/refresh") {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req, res, hostAllowed, json);
    if (!body) return;
    if (!live) return json(res, 404, { error: "live refresh is off" });
    if (body.machineId !== undefined && typeof body.machineId !== "string") return json(res, 400, { error: "machineId must be a string" });
    if (body.slow !== undefined && typeof body.slow !== "boolean") return json(res, 400, { error: "slow must be a boolean" });
    try {
      const result = live.refresh(typeof body.machineId === "string" ? body.machineId : undefined, body.slow === true);
      if (!result.started) return json(res, 200, { started: false, reason: result.reason });
      return json(res, 202, { started: true, machines: result.machines });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
  if (path === "/api/services/descriptions/overview") return json(res, 200, descriptions ? await descriptions.overview() : descriptionsOverview(db));
  if (path === "/api/services") return json(res, 200, servicesResponse(db, url.searchParams, control, provenance));
  if (path === "/api/listeners") return json(res, 200, listenersResponse(db, url.searchParams, control, provenance));
  if (path === "/api/services/events") return json(res, 200, eventsResponse(db, url.searchParams));
  if (path === "/api/services/overview") return json(res, 200, overviewResponse(db, live));
  return json(res, 404, { error: "no such route" });
}
