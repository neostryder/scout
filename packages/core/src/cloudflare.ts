import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { listListeners, type Listener, type ListenerBind } from "./listeners.ts";
import { listServices, type Service } from "./services.ts";
import { loadDescriptionResolver, type Description, type DescriptionResolver } from "./descriptions.ts";
import { healthDomain, healthRow, type HealthRow } from "./health.ts";

export type TunnelStatus = "healthy" | "degraded" | "down" | "inactive";
export type RouteVia = "tunnel" | "worker" | "proxied-origin" | "dns-only";
export type RouteState = "ok" | "origin-down" | "dns-dangling" | "no-origin" | "unknown";
export type MachineConfidence = "listener" | "cloudflared" | "single-host" | "configured";
export type ReaderState = "never" | "fresh" | "stale" | "failed" | "off";

export interface CfZone { id: string; name: string }
export interface CfDns { zone: string; name: string; type: "A" | "AAAA" | "CNAME"; content: string; proxied: boolean }
export interface CfTunnel { id: string; name: string; status: TunnelStatus; connections: number; remoteManaged: boolean }
export interface CfIngress { tunnelId: string; position: number; hostname: string | null; path: string | null; service: string }
export interface CfAccessApp { id: string; name: string; domain: string; policies: number }
export interface CfWorkerRoute { zone: string; pattern: string; script: string | null }

/** Absent parts keep their previous rows, so a 403 on one endpoint does not wipe that part. */
export interface CloudflareSnapshot {
  zones?: CfZone[];
  dns?: CfDns[];
  tunnels?: CfTunnel[];
  ingress?: CfIngress[];
  accessApps?: CfAccessApp[];
  workerRoutes?: CfWorkerRoute[];
}

export interface RouteDns { type: string; content: string; proxied: boolean }
export interface RouteTunnel { id: string; name: string; status: TunnelStatus; connections: number }
export interface RouteWorker { pattern: string; script: string | null }
export interface RouteAccess { name: string; appId: string; policies: number }
export interface RouteOrigin { service: string; scheme: string; host: string; port: number }
export interface RouteListener { id: number; port: number; bind: ListenerBind; processName: string | null; serviceName: string | null }

export interface RouteRow {
  hostname: string;
  path: string | null;
  zone: string | null;
  via: RouteVia;
  dns: RouteDns | null;
  tunnel: RouteTunnel | null;
  worker: RouteWorker | null;
  access: RouteAccess | null;
  origin: RouteOrigin | null;
  machineId: string | null;
  machineName: string | null;
  machineConfidence: MachineConfidence | null;
  listener: RouteListener | null;
  description: Description | null;
  state: RouteState;
  stateText: string;
  health: HealthRow | null;
}

export interface RouteQuery {
  /** Tunnel name (any case) to machine id, from the optional tunnel-hosts file, for tunnels Scout cannot place by itself. */
  tunnelHosts?: Record<string, string>;
  machine?: string;
  state?: RouteState;
  q?: string;
}

export interface CloudflareReaderView {
  state: ReaderState;
  lastReadAt: string | null;
  error: string | null;
  zones: number;
  tunnels: number;
}

interface ReaderRow { state: ReaderState; lastReadAt: string | null; error: string | null }
interface MachineRow { id: string; name: string; kind: "host" | "guest"; parentId: string | null; guestType: string | null }
interface TunnelRow extends RouteTunnel { remoteManaged: boolean }
interface DnsRow extends CfDns {}
interface IngressRow extends CfIngress {}
interface AccessRow extends CfAccessApp {}
interface WorkerRow extends CfWorkerRoute {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const WIDTH: Record<ListenerBind, number> = { loopback: 0, lan: 1, all: 2 };

function bit(value: boolean): number {
  return value ? 1 : 0;
}

function dataFingerprint(db: Db): string {
  const zones = db.prepare("SELECT id, name FROM cf_zones ORDER BY id").all();
  const dns = db.prepare("SELECT zone, name, type, content, proxied FROM cf_dns ORDER BY zone, name, type, content, proxied").all();
  const tunnels = db.prepare("SELECT id, name, status, connections, remote_managed FROM cf_tunnels ORDER BY id").all();
  const ingress = db.prepare("SELECT tunnel_id, position, hostname, path, service FROM cf_ingress ORDER BY tunnel_id, position").all();
  const access = db.prepare("SELECT id, name, domain, policies FROM cf_access_apps ORDER BY id").all();
  const workers = db.prepare("SELECT zone, pattern, script FROM cf_worker_routes ORDER BY zone, pattern, script").all();
  return JSON.stringify({ zones, dns, tunnels, ingress, access, workers });
}

function readerFingerprint(db: Db): string {
  const row = db.prepare("SELECT state, error FROM cf_reader WHERE id = 1").get();
  return JSON.stringify(row ?? null);
}

function countData(db: Db): number {
  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM cf_zones) + (SELECT COUNT(*) FROM cf_dns) + (SELECT COUNT(*) FROM cf_tunnels) +
       (SELECT COUNT(*) FROM cf_ingress) + (SELECT COUNT(*) FROM cf_access_apps) + (SELECT COUNT(*) FROM cf_worker_routes) AS n`,
  ).get() as { n: number };
  return row.n;
}

function writeReader(db: Db, row: ReaderRow): void {
  db.prepare(
    `INSERT INTO cf_reader (id, state, last_read_at, error) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, last_read_at = excluded.last_read_at, error = excluded.error`,
  ).run(row.state, row.lastReadAt, row.error);
}

function readReader(db: Db): ReaderRow | null {
  const row = db.prepare("SELECT state, last_read_at AS lastReadAt, error FROM cf_reader WHERE id = 1").get() as ReaderRow | undefined;
  return row ?? null;
}

/** Replace the parts a read actually returned. `changed` ignores `last_read_at`, so a reread of the same catalog is quiet. */
export function recordCloudflare(db: Db, snapshot: CloudflareSnapshot, at: string, error: string | null): { changed: boolean } {
  const dataBefore = dataFingerprint(db);
  const readerBefore = readerFingerprint(db);
  db.exec("BEGIN");
  try {
    if (snapshot.zones) {
      db.prepare("DELETE FROM cf_zones").run();
      const insert = db.prepare("INSERT INTO cf_zones (id, name) VALUES (?, ?)");
      for (const zone of snapshot.zones) insert.run(zone.id, zone.name);
    }
    if (snapshot.dns) {
      db.prepare("DELETE FROM cf_dns").run();
      const insert = db.prepare("INSERT INTO cf_dns (zone, name, type, content, proxied) VALUES (?, ?, ?, ?, ?)");
      for (const row of snapshot.dns) insert.run(row.zone, row.name, row.type, row.content, bit(row.proxied));
    }
    if (snapshot.tunnels) {
      db.prepare("DELETE FROM cf_tunnels").run();
      const insert = db.prepare("INSERT INTO cf_tunnels (id, name, status, connections, remote_managed) VALUES (?, ?, ?, ?, ?)");
      for (const row of snapshot.tunnels) insert.run(row.id, row.name, row.status, row.connections, bit(row.remoteManaged));
    }
    if (snapshot.ingress) {
      db.prepare("DELETE FROM cf_ingress").run();
      const insert = db.prepare("INSERT INTO cf_ingress (tunnel_id, position, hostname, path, service) VALUES (?, ?, ?, ?, ?)");
      for (const row of snapshot.ingress) insert.run(row.tunnelId, row.position, row.hostname, row.path, row.service);
    } else if (snapshot.tunnels) {
      // Ingress we could not re-read is kept only for tunnels that are still remote.
      const remote = new Set(snapshot.tunnels.filter((row) => row.remoteManaged).map((row) => row.id));
      const stale = db.prepare("SELECT id, tunnel_id FROM cf_ingress").all() as { id: number; tunnel_id: string }[];
      const drop = db.prepare("DELETE FROM cf_ingress WHERE id = ?");
      for (const row of stale) if (!remote.has(row.tunnel_id)) drop.run(row.id);
    }
    if (snapshot.accessApps) {
      db.prepare("DELETE FROM cf_access_apps").run();
      const insert = db.prepare("INSERT INTO cf_access_apps (id, name, domain, policies) VALUES (?, ?, ?, ?)");
      for (const row of snapshot.accessApps) insert.run(row.id, row.name, row.domain, row.policies);
    }
    if (snapshot.workerRoutes) {
      db.prepare("DELETE FROM cf_worker_routes").run();
      const insert = db.prepare("INSERT INTO cf_worker_routes (zone, pattern, script) VALUES (?, ?, ?)");
      for (const row of snapshot.workerRoutes) insert.run(row.zone, row.pattern, row.script);
    }
    writeReader(db, { state: "fresh", lastReadAt: at, error });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { changed: dataFingerprint(db) !== dataBefore || readerFingerprint(db) !== readerBefore };
}

/** A failed read leaves the catalog rows in place. Prior rows make the state stale; an empty catalog stays failed. */
export function failCloudflareRead(db: Db, error: string): { state: "stale" | "failed"; changed: boolean } {
  const before = readerFingerprint(db);
  const existing = readReader(db);
  const state = countData(db) > 0 ? "stale" : "failed";
  writeReader(db, { state, lastReadAt: existing?.lastReadAt ?? null, error });
  return { state, changed: readerFingerprint(db) !== before };
}

export function cloudflareReader(db: Db, enabled: boolean): CloudflareReaderView {
  const row = readReader(db);
  const zones = (db.prepare("SELECT COUNT(*) AS n FROM cf_zones").get() as { n: number }).n;
  const tunnels = (db.prepare("SELECT COUNT(*) AS n FROM cf_tunnels").get() as { n: number }).n;
  if (!enabled) return { state: "off", lastReadAt: row?.lastReadAt ?? null, error: null, zones, tunnels };
  return {
    state: row?.state ?? "never",
    lastReadAt: row?.lastReadAt ?? null,
    error: row?.error ?? null,
    zones,
    tunnels,
  };
}

export function cloudflareCounts(db: Db): { zones: number; dns: number; tunnels: number; ingress: number; access: number; workers: number } {
  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    zones: count("cf_zones"),
    dns: count("cf_dns"),
    tunnels: count("cf_tunnels"),
    ingress: count("cf_ingress"),
    access: count("cf_access_apps"),
    workers: count("cf_worker_routes"),
  };
}

function hostName(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

function tunnelIdFromContent(content: string): string | null {
  const match = /^([a-z0-9-]+)\.cfargotunnel\.com\.?$/i.exec(content.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

function zoneFor(hostname: string, zones: string[], dnsZone: string | null): string | null {
  if (dnsZone) return dnsZone;
  const matches = zones.filter((zone) => hostname === zone || hostname.endsWith(`.${zone}`));
  matches.sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

function loadMachines(db: Db): Map<string, MachineRow> {
  const rows = db.prepare(
    "SELECT id, name, kind, parent_id AS parentId, guest_type AS guestType FROM machines",
  ).all() as unknown as MachineRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

function loadTunnels(db: Db): Map<string, TunnelRow> {
  const rows = db.prepare(
    "SELECT id, name, status, connections, remote_managed AS remoteManaged FROM cf_tunnels",
  ).all() as { id: string; name: string; status: TunnelStatus; connections: number; remoteManaged: number }[];
  return new Map(rows.map((row) => [row.id.toLowerCase(), {
    id: row.id,
    name: row.name,
    status: row.status,
    connections: row.connections,
    remoteManaged: row.remoteManaged !== 0,
  }]));
}

function loadDns(db: Db): DnsRow[] {
  const rows = db.prepare("SELECT zone, name, type, content, proxied FROM cf_dns").all() as { zone: string; name: string; type: "A" | "AAAA" | "CNAME"; content: string; proxied: number }[];
  return rows.map((row) => ({ ...row, name: hostName(row.name), proxied: row.proxied !== 0 }));
}

function loadIngress(db: Db): IngressRow[] {
  return db.prepare(
    "SELECT tunnel_id AS tunnelId, position, hostname, path, service FROM cf_ingress ORDER BY tunnel_id, position",
  ).all() as unknown as IngressRow[];
}

function loadAccess(db: Db): AccessRow[] {
  return db.prepare("SELECT id, name, domain, policies FROM cf_access_apps").all() as unknown as AccessRow[];
}

function loadWorkers(db: Db): WorkerRow[] {
  return db.prepare("SELECT zone, pattern, script FROM cf_worker_routes").all() as unknown as WorkerRow[];
}

function loadZones(db: Db): string[] {
  return (db.prepare("SELECT name FROM cf_zones").all() as { name: string }[]).map((row) => hostName(row.name));
}

/** A published Colima port is reachable on the host. A loopback socket inside the guest is a different network. */
function ownerOf(listener: Listener, machines: Map<string, MachineRow>): { id: string; name: string } | null {
  const machine = machines.get(listener.machineId);
  if (!machine) return { id: listener.machineId, name: listener.machineName };
  if (machine.kind === "guest" && machine.guestType === "colima") {
    const forwarded = listener.containerName !== null || listener.bind !== "loopback";
    if (!forwarded || !machine.parentId) return null;
    const parent = machines.get(machine.parentId);
    return parent ? { id: parent.id, name: parent.name } : null;
  }
  return { id: machine.id, name: machine.name };
}

function runningCloudflared(service: Service): boolean {
  if (service.state !== "running" || service.goneAt !== null) return false;
  return `${service.name} ${service.displayName ?? ""} ${service.program ?? ""}`.toLowerCase().includes("cloudflared");
}

function serviceNameFor(listener: Listener, services: Service[]): string | null {
  const mine = services.filter((service) => service.machineId === listener.machineId && service.goneAt === null);
  const samePath = (service: Service): boolean => {
    if (service.program === null || listener.processPath === null) return false;
    return service.kind === "launchd" ? service.program === listener.processPath : service.program.toLowerCase() === listener.processPath.toLowerCase();
  };
  const byPid = listener.pid === null ? undefined : mine.find((service) => service.pid !== null && service.pid === listener.pid);
  const service = byPid ?? mine.find((service) => service.pid === null && samePath(service));
  return service?.name ?? null;
}

function listenerView(listener: Listener, services: Service[]): RouteListener {
  return {
    id: listener.id,
    port: listener.port,
    bind: listener.bind,
    processName: listener.processName,
    serviceName: serviceNameFor(listener, services),
  };
}

interface JoinedMachine {
  machineId: string | null;
  machineName: string | null;
  confidence: MachineConfidence | null;
  listener: RouteListener | null;
  tie: "several" | "none";
}

// The machine that runs a tunnel is the one that runs its cloudflared, so when several machines listen on the port, the ones with a running cloudflared are the candidates.
function joinMachine(tunnelName: string, tunnelHosts: Record<string, string>, port: number, listeners: Listener[], services: Service[], machines: Map<string, MachineRow>): JoinedMachine {
  const cloudflared = new Map<string, string>();
  for (const service of services) {
    if (!runningCloudflared(service)) continue;
    const machine = machines.get(service.machineId);
    if (machine) cloudflared.set(machine.id, machine.name);
  }
  // Its metrics port also shows it where no service row names it (a plain background process).
  for (const listener of listeners) {
    if (listener.goneAt !== null || !`${listener.processName ?? ""} ${listener.processPath ?? ""}`.toLowerCase().includes("cloudflared")) continue;
    const owner = ownerOf(listener, machines);
    if (owner) cloudflared.set(owner.id, owner.name);
  }
  const attributed = new Map<string, { name: string; listener: Listener }>();
  for (const listener of listeners) {
    if (listener.goneAt !== null || listener.port !== port) continue;
    const owner = ownerOf(listener, machines);
    if (!owner) continue;
    const existing = attributed.get(owner.id);
    if (!existing || WIDTH[listener.bind] > WIDTH[existing.listener.bind] || (listener.bind === existing.listener.bind && listener.id < existing.listener.id)) {
      attributed.set(owner.id, { name: owner.name, listener });
    }
  }
  const view = (id: string, name: string, confidence: MachineConfidence): JoinedMachine => {
    const found = attributed.get(id);
    return { machineId: id, machineName: name, confidence, listener: found ? listenerView(found.listener, services) : null, tie: "none" };
  };
  const configured = Object.entries(tunnelHosts).find(([name]) => name.toLowerCase() === tunnelName.trim().toLowerCase());
  const host = configured ? machines.get(configured[1]) : undefined;
  if (host) return view(host.id, host.name, "configured");
  // A tunnel named after a machine that runs cloudflared lives there.
  const wanted = tunnelName.trim().toLowerCase();
  const named = [...cloudflared.entries()].filter(([id, name]) => id.toLowerCase() === wanted || name.toLowerCase() === wanted);
  if (named.length === 1 && named[0]) return view(named[0][0], named[0][1], "cloudflared");
  if (attributed.size === 1) {
    const entry = [...attributed.entries()][0];
    if (entry) return view(entry[0], entry[1].name, "listener");
  }
  // Several machines listen on the port: the ones that run cloudflared are the candidates.
  const connected = [...attributed.entries()].filter(([id]) => cloudflared.has(id));
  if (connected.length === 1 && connected[0]) return view(connected[0][0], connected[0][1].name, "cloudflared");
  if (cloudflared.size === 1) {
    const entry = [...cloudflared.entries()][0];
    if (entry) return view(entry[0], entry[1], "cloudflared");
  }
  const hosts = [...machines.values()].filter((machine) => machine.kind === "host");
  if (hosts.length === 1 && hosts[0]) return view(hosts[0].id, hosts[0].name, "single-host");
  return { machineId: null, machineName: null, confidence: null, listener: null, tie: attributed.size > 1 || cloudflared.size > 1 ? "several" : "none" };
}

function parseOrigin(service: string): { kind: "local"; origin: RouteOrigin } | { kind: "none"; reason: "status" | "unix" | "remote" } {
  const trimmed = service.trim();
  if (/^http_status:\d+$/i.test(trimmed)) return { kind: "none", reason: "status" };
  if (/^unix:/i.test(trimmed)) return { kind: "none", reason: "unix" };
  let url: URL;
  try { url = new URL(trimmed); } catch { return { kind: "none", reason: "remote" }; }
  // WHATWG hostname keeps the brackets around an IPv6 address.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const portText = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  const port = Number(portText);
  if (!LOOPBACK.has(host) || !Number.isInteger(port) || port <= 0 || port > 65535) return { kind: "none", reason: "remote" };
  return { kind: "local", origin: { service: trimmed, scheme: url.protocol.replace(":", ""), host, port } };
}

function dnsRank(row: DnsRow, tunnelId: string | null): number {
  const target = tunnelIdFromContent(row.content);
  if (row.type === "CNAME" && row.proxied && tunnelId && target === tunnelId) return 0;
  if (row.type === "CNAME" && row.proxied && target) return 1;
  if (row.proxied) return 2;
  return 3;
}

function dnsFor(hostname: string, rows: DnsRow[], tunnelId: string | null): DnsRow | null {
  const matches = rows.filter((row) => row.name === hostname);
  matches.sort((a, b) => dnsRank(a, tunnelId) - dnsRank(b, tunnelId) || a.type.localeCompare(b.type));
  return matches[0] ?? null;
}

function dnsView(row: DnsRow | null): RouteDns | null {
  return row ? { type: row.type, content: row.content, proxied: row.proxied } : null;
}

function tunnelView(row: TunnelRow | undefined): RouteTunnel | null {
  return row ? { id: row.id, name: row.name, status: row.status, connections: row.connections } : null;
}

function accessFor(hostname: string, apps: AccessRow[]): RouteAccess | null {
  const exact = apps.find((app) => hostName(app.domain) === hostname);
  if (exact) return { name: exact.name, appId: exact.id, policies: exact.policies };
  const wild = apps.filter((app) => {
    const domain = hostName(app.domain);
    if (!domain.startsWith("*.")) return false;
    const suffix = domain.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length && !hostname.slice(0, -suffix.length).includes(".");
  });
  wild.sort((a, b) => hostName(b.domain).length - hostName(a.domain).length);
  const best = wild[0];
  return best ? { name: best.name, appId: best.id, policies: best.policies } : null;
}

function workerHost(pattern: string): string {
  return hostName((pattern.split("/")[0] ?? pattern).trim());
}

function workerMatches(pattern: string, hostname: string): boolean {
  const host = workerHost(pattern);
  if (host.startsWith("*.")) {
    const suffix = host.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length && !hostname.slice(0, -suffix.length).includes(".");
  }
  return host === hostname;
}

function workerFor(hostname: string, workers: WorkerRow[]): RouteWorker | null {
  const exact = workers.find((row) => !workerHost(row.pattern).startsWith("*.") && workerMatches(row.pattern, hostname));
  const wild = workers.find((row) => workerHost(row.pattern).startsWith("*.") && workerMatches(row.pattern, hostname));
  const match = exact ?? wild;
  return match ? { pattern: match.pattern, script: match.script } : null;
}

function blank(hostname: string, path: string | null, zone: string | null, via: RouteVia): RouteRow {
  return {
    hostname, path, zone, via, dns: null, tunnel: null, worker: null, access: null, origin: null,
    machineId: null, machineName: null, machineConfidence: null, listener: null, description: null, state: "unknown", stateText: "", health: null,
  };
}

function judgeLocal(tunnel: TunnelRow, origin: RouteOrigin, joined: JoinedMachine): Pick<RouteRow, "state" | "stateText" | "machineId" | "machineName" | "machineConfidence" | "listener"> {
  const base = {
    machineId: joined.machineId,
    machineName: joined.machineName,
    machineConfidence: joined.confidence,
    listener: joined.listener,
  };
  if (!joined.machineId) {
    const stateText = joined.tie === "several"
      ? `Several machines qualify for port ${origin.port}, so Scout names none`
      : "No machine matches this tunnel";
    return { ...base, state: "unknown", stateText };
  }
  const name = joined.machineName ?? joined.machineId;
  if (joined.listener) {
    return { ...base, state: "ok", stateText: `Tunnel ${tunnel.status} and port ${origin.port} is listening on ${name}` };
  }
  if (tunnel.status === "healthy") {
    return { ...base, state: "origin-down", stateText: `Tunnel healthy and port ${origin.port} is not listening on ${name}` };
  }
  return { ...base, state: "unknown", stateText: `Tunnel ${tunnel.status} and port ${origin.port} is not listening on ${name}` };
}

function noOriginText(reason: "status" | "unix" | "remote", service: string): string {
  if (reason === "unix") return "Ingress targets a unix socket";
  if (reason === "remote") return "Ingress targets a remote origin";
  const code = /^http_status:(\d+)$/i.exec(service.trim())?.[1] ?? "404";
  return `Ingress answers HTTP ${code} and names no origin`;
}

function buildRoutes(db: Db, tunnelHosts: Record<string, string>, descriptions: DescriptionResolver): RouteRow[] {
  const zones = loadZones(db);
  const tunnels = loadTunnels(db);
  const dns = loadDns(db);
  const ingress = loadIngress(db);
  const apps = loadAccess(db);
  const workers = loadWorkers(db);
  const machines = loadMachines(db);
  const listeners = listListeners(db, { state: "present", includeHidden: true }, descriptions);
  const services = listServices(db, { gone: "present", includeHidden: true }, descriptions);
  const rows: RouteRow[] = [];
  const covered = new Set<string>();
  for (const rule of ingress) {
    if (!rule.hostname) continue;
    const hostname = hostName(rule.hostname);
    covered.add(hostname);
    const tunnel = tunnels.get(rule.tunnelId.toLowerCase());
    const record = dnsFor(hostname, dns, tunnel?.id.toLowerCase() ?? null);
    const row = blank(hostname, rule.path, zoneFor(hostname, zones, record?.zone ?? null), "tunnel");
    row.dns = dnsView(record);
    row.tunnel = tunnel ? tunnelView(tunnel) : null;
    row.worker = workerFor(hostname, workers);
    row.access = accessFor(hostname, apps);
    const parsed = parseOrigin(rule.service);
    if (!tunnel) {
      row.state = "dns-dangling";
      row.stateText = "Proxied CNAME points at a tunnel that is gone";
    } else if (parsed.kind === "none") {
      row.state = "no-origin";
      row.stateText = noOriginText(parsed.reason, rule.service);
    } else {
      const joined = joinMachine(tunnel.name, tunnelHosts, parsed.origin.port, listeners, services, machines);
      Object.assign(row, judgeLocal(tunnel, parsed.origin, joined));
      row.origin = parsed.origin;
    }
    rows.push(row);
  }

  for (const worker of workers) {
    const hostname = workerHost(worker.pattern);
    if (!hostname || hostname === "*" || covered.has(hostname)) continue;
    if (rows.some((row) => row.hostname === hostname)) continue;
    covered.add(hostname);
    const record = dnsFor(hostname, dns, null);
    const row = blank(hostname, null, zoneFor(hostname, zones, record?.zone ?? worker.zone), "worker");
    row.dns = dnsView(record);
    row.worker = { pattern: worker.pattern, script: worker.script };
    row.access = accessFor(hostname, apps);
    if (worker.script) {
      row.state = "ok";
      row.stateText = `Worker ${worker.script} serves ${hostname}`;
    } else {
      row.state = "no-origin";
      row.stateText = "Worker route has no script";
    }
    rows.push(row);
  }

  const pendingDns = [...dns].sort((a, b) => {
    const score = (row: DnsRow): number => (row.type === "CNAME" && tunnelIdFromContent(row.content) ? 0 : row.proxied ? 1 : 2);
    return score(a) - score(b) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type);
  });
  for (const record of pendingDns) {
    if (covered.has(record.name)) continue;
    const target = record.type === "CNAME" ? tunnelIdFromContent(record.content) : null;
    const tunnel = target ? tunnels.get(target) : undefined;
    if (record.proxied && target) {
      const row = blank(record.name, null, zoneFor(record.name, zones, record.zone), "tunnel");
      row.dns = dnsView(record);
      row.tunnel = tunnel ? tunnelView(tunnel) : null;
      row.access = accessFor(record.name, apps);
      row.worker = workerFor(record.name, workers);
      if (!tunnel) {
        row.state = "dns-dangling";
        row.stateText = "Proxied CNAME points at a tunnel that is gone";
      } else if (!tunnel.remoteManaged) {
        row.state = "unknown";
        row.stateText = `Tunnel ${tunnel.name} is locally managed, so its origin is not in the catalog`;
      } else {
        row.state = "dns-dangling";
        row.stateText = "Proxied CNAME has no ingress rule";
      }
      rows.push(row);
      covered.add(record.name);
      continue;
    }
    if (!record.content.trim()) {
      const row = blank(record.name, null, zoneFor(record.name, zones, record.zone), record.proxied ? "proxied-origin" : "dns-only");
      row.dns = dnsView(record);
      row.access = accessFor(record.name, apps);
      row.state = "dns-dangling";
      row.stateText = "Record points at nothing Scout can resolve";
      rows.push(row);
      covered.add(record.name);
      continue;
    }
    const via: RouteVia = record.proxied ? "proxied-origin" : "dns-only";
    const row = blank(record.name, null, zoneFor(record.name, zones, record.zone), via);
    row.dns = dnsView(record);
    row.access = accessFor(record.name, apps);
    row.worker = workerFor(record.name, workers);
    row.state = "ok";
    row.stateText = record.proxied ? `Proxied to ${record.content}` : `DNS only, points at ${record.content}`;
    rows.push(row);
    covered.add(record.name);
  }

  rows.sort((a, b) => a.hostname.localeCompare(b.hostname) || (a.path ?? "").localeCompare(b.path ?? "") || a.via.localeCompare(b.via) || (a.dns?.type ?? "").localeCompare(b.dns?.type ?? ""));
  const byListener = new Map(listeners.map((listener) => [listener.id, listener.description]));
  for (const row of rows) {
    row.description = row.listener ? byListener.get(row.listener.id) ?? null : null;
    row.health = healthDomain(row.hostname) ? healthRow(db, `domain:${row.hostname}`) : null;
  }
  return rows;
}

function queryHit(row: RouteRow, q: string): boolean {
  const haystack = [row.hostname, row.tunnel?.name ?? "", row.origin?.service ?? "", row.worker?.script ?? ""].join("\n").toLowerCase();
  return haystack.includes(q.trim().toLowerCase());
}

export function listRoutes(db: Db, query: RouteQuery = {}, descriptions: DescriptionResolver = loadDescriptionResolver(db)): RouteRow[] {
  return buildRoutes(db, query.tunnelHosts ?? {}, descriptions).filter((row) =>
    (query.machine === undefined || row.machineId === query.machine) &&
    (query.state === undefined || row.state === query.state) &&
    (query.q === undefined || query.q.trim() === "" || queryHit(row, query.q))
  );
}

/** Reads the optional tunnel-hosts file: a JSON object of tunnel name to machine id. A missing or unreadable file means no overrides. */
export function loadTunnelHosts(path: string | undefined): Record<string, string> {
  if (!path) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}
