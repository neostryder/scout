import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { hubMachineId, hubMachineName, resourcesResponse, changelogSummaryFor, mineFileReader, trayFileReader, protectedFileReader, provenanceContext, provenanceResponse, refreshProjectGit, type Db } from "@scout/core";
import { runDiscovery, type ModelRunner } from "@scout/core";
import { summarizeChangelogs, type ChangelogOptions } from "@scout/research";
import { revalidate } from "./etag.ts";
import { trayApi } from "./tray-api.ts";
import { isPublicInstallAsset, serviceTokenMayReach, verifyAccessJwt, type AccessConfig, type KeySource } from "./access.ts";
import { coverageResponse, decideProposalRequest, installDetail, installsResponse, proposalsResponse, summaryResponse, updatesResponse } from "./api.ts";
import { ControlRunner, Runner, runHealthCycle, subscribeServiceReads, type ControlRunnerDeps, type RunnerDeps } from "@scout/ops";
import { createDownloadJobsResponse, createJobsResponse, jobResponse, planResponse } from "./jobs-api.ts";
import { createDownloadKinds, createDownloadResolver, type DownloadsOptions } from "./downloads-api.ts";
import { filtersApi } from "./filters-api.ts";
import type { CloudflareSchedule } from "./cloudflare.ts";
import type { LiveSchedule } from "./live.ts";
import { routesApi } from "./routes-api.ts";
import type { ResearchSchedule } from "./schedule.ts";
import type { ScanSchedule } from "./scan-schedule.ts";
import { readJson, servicesApi } from "./services-api.ts";
import type { DescriptionRun } from "./descriptions.ts";
import { HubRecipes } from "./recipes.ts";
import type { Project } from "@scout/core";
import { HubAlerts, type HubAlertOptions } from "./alerts.ts";
import { HealthSchedule, type HealthScheduleOptions } from "./health.ts";
import type { MeterSchedule } from "./meters.ts";
import type { HubMeterAlerts } from "./meter-alerts.ts";
import { HubBackupWatch, type BackupWatchOptions } from "./backup-watch.ts";
import type { HubWatch } from "./watch.ts";
import { portsFileReader, portsResponse } from "@scout/core";
import { HubStacks } from "./stacks.ts";

// Development server: loopback only and no sign-in. It refuses any Host header that is not a loopback name, which
// stops a web page in another tab from reaching it through DNS rebinding. Proposal decisions and update jobs need a
// JSON content type (a cross-site form cannot send one) and a loopback Origin. The production entry point
// (behind Cloudflare Access with its own token checks) is a separate step and does not reuse this listener.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface HubOptions {
  db: Db;
  /** Directory holding index.html and the page's scripts. */
  webRoot: string;
  /**
   * Production mode: the hub answers only the configured public host and only requests that carry a valid Cloudflare
   * Access token. Without it (development) it answers only loopback host names and needs no sign-in.
   */
  access?: { config: AccessConfig; keys: KeySource; log?: (line: string) => void };
  jobs?: RunnerDeps;
  control?: ControlRunnerDeps | false;
  recipeProjects?: () => Project[];
  portsPath?: string;
  stacksPath?: string;
  protectedPath?: string;
  /** JSON file of the owners and author emails that count as the user. Absent means no project is marked as theirs. */
  minePath?: string;
  /** The tray panel's hide rules and pins. */
  trayPath?: string;
  downloads?: DownloadsOptions;
  research?: ResearchSchedule;
  scans?: ScanSchedule;
  /** Live listener and service reads. Omit it and the stream still says hello, while refresh answers 404. */
  live?: LiveSchedule;
  /** Cloudflare route reader. Omit it and route reads report off, while route refresh answers 404. */
  cloudflare?: CloudflareSchedule;
  /** Optional JSON file of tunnel name to machine id for tunnels the join cannot place by itself. */
  tunnelHostsPath?: string;
  alerts?: HubAlertOptions;
  health?: HealthScheduleOptions | false;
  /** Samples machine resources for /api/resources. Off when omitted. */
  meters?: MeterSchedule;
  /** The quiet meter alerts: their settings and the alerts that are up. Omit it and the settings route answers 404. */
  meterAlerts?: HubMeterAlerts;
  /** Watches the Galadriel backup health file and raises an alert while the backup is critical. Omit it and no backup alert is raised. */
  backup?: Omit<BackupWatchOptions, "machineName">;
  /** Outage watch: machine, web address and service checks, notices and the heartbeat. Omit it and the outage routes answer with an empty, read-only record. */
  watch?: HubWatch;
  /** Heartbeat comment interval for /api/services/live. Tests pass a short one. */
  streamHeartbeatMs?: number;
  changelog?: Pick<ChangelogOptions, "summarize" | "fetch">;
  discoverModel?: ModelRunner;
  descriptions?: DescriptionRun;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), TYPES[".json"] as string);

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

async function serveStatic(webRoot: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^([/\\])+/, "");
  const file = resolve(join(webRoot, rel));
  if (file !== resolve(webRoot) && !file.startsWith(resolve(webRoot) + sep)) return send(res, 403, "forbidden", "text/plain");
  try {
    const body = await readFile(file);
    const ext = extname(file);
    // The icons and the install manifest are what a browser reads when it saves the page as an app, and some installers read them from the cache, so they may be kept for an hour. Everything else stays uncached.
    const installAsset = ext === ".png" || ext === ".webmanifest" || file.endsWith(`${sep}icon.svg`);
    send(res, 200, body, TYPES[ext] ?? "application/octet-stream", installAsset ? { "cache-control": "private, max-age=3600" } : {});
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

const MAX_BODY = 4096;

async function decide(db: Db, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, runner: Runner | null, research: ResearchSchedule | undefined, changelog: HubOptions["changelog"], discoverModel: ModelRunner | undefined, scans: ScanSchedule | undefined): Promise<void> {
  const m = /^\/api\/proposals\/(\d+)$/.exec(url.pathname);
  const jobId = /^\/api\/jobs\/(\d+)\/stop$/.exec(url.pathname);
  const creating = url.pathname === "/api/jobs";
  const scanning = url.pathname === "/api/scans/run";
  const refreshing = url.pathname === "/api/research/refresh";
  const refreshingChangelog = url.pathname === "/api/changelog/refresh";
  const discovering = url.pathname === "/api/dependencies/discover";
  if (scanning && !scans) return json(res, 404, { error: "no such route" });
  if (refreshing && !research) return json(res, 404, { error: "no such route" });
  if (!runner && (creating || jobId)) return json(res, 404, { error: "no such route" });
  if (!m && !(runner && (jobId || creating)) && !refreshing && !refreshingChangelog && !discovering && !scanning) return json(res, 405, { error: "read only" });
  const origin = req.headers.origin;
  if (origin !== undefined && !hostAllowed(URL.canParse(origin) ? new URL(origin).host : undefined)) return json(res, 403, { error: "cross-origin request refused" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "content type must be application/json" });
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return json(res, 413, { error: "body too large" });
  }
  try {
    if (scanning && scans) {
      const body: unknown = JSON.parse(raw || "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
      const machineId = (body as { machineId?: unknown }).machineId;
      if (machineId !== undefined && typeof machineId !== "string") throw new Error("machineId must be a string");
      const result = scans.runNow(machineId);
      return result.started ? json(res, 202, result.status) : json(res, 409, { error: result.reason });
    }
    if (discovering) {
      const body: unknown = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error("body must be {}");
      return json(res, 200, discoverModel ? await runDiscovery(db, discoverModel) : { status: "no_model", proposed: 0 });
    }
    if (refreshingChangelog) {
      const body: unknown = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
      return json(res, 200, await summarizeChangelogs(db, changelog));
    }
    if (refreshing && research) {
      const body: unknown = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
      const sources = (body as { sources?: unknown }).sources;
      if (sources !== undefined && (!Array.isArray(sources) || sources.some((source) => typeof source !== "string"))) throw new Error("sources must be an array of source names");
      return json(res, 200, await research.runNow(sources as string[] | undefined));
    }
    if (m) return json(res, 200, decideProposalRequest(db, Number(m[1]), JSON.parse(raw)));
    if (jobId && runner) return runner.stop(Number(jobId[1])) ? json(res, 200, jobResponse(db, Number(jobId[1]))) : json(res, jobResponse(db, Number(jobId[1])) ? 409 : 404, { error: "job cannot be stopped" });
    if (runner) {
      const body: unknown = JSON.parse(raw);
      const result = (body as { action?: unknown } | null)?.action === "download" ? await createDownloadJobsResponse(db, runner, body) : createJobsResponse(db, runner, body);
      return json(res, result.status, result.body);
    }
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
}

export function createHub(options: HubOptions): Server {
  const { db, webRoot, access } = options;
  const recipes = new HubRecipes(db, options.recipeProjects ?? (() => []));
  recipes.scan();
  const unsubscribeRecipeDescriptions = options.descriptions?.subscribe((event) => { if (event.scope === "project" && event.state !== "running") recipes.scan(); });
  const mineFile = mineFileReader(options.minePath ?? ".scout-data/mine.json");
  const provenance = () => provenanceContext(db, mineFile().profile);
  const trayPath = options.trayPath ?? ".scout-data/tray.json";
  const trayFile = trayFileReader(trayPath);
  const readPorts = portsFileReader(options.portsPath);
  const stacksPath = options.stacksPath ?? (options.control ? options.control.stacksPath : undefined);
  const stacks = new HubStacks(db, stacksPath);
  const registries = { ports: () => portsResponse(db, readPorts()), stacks };
  const alerts = new HubAlerts(db, { tunnelHostsPath: options.tunnelHostsPath, loadPorts: readPorts, ...(options.watch ? { loadWatch: options.watch.configReader() } : {}), ...(options.backup ? { loadBackup: options.backup.read } : {}), ...options.alerts });
  const backupWatch = options.backup ? new HubBackupWatch(alerts, { ...options.backup, machineName: hubMachineName }) : undefined;
  options.watch?.attachAlerts(alerts);
  const unsubscribeWatchLive = options.live?.subscribeStored((read) => { if (read.status === "ok") void options.watch?.observeServices(read.machineId, read.at); });
  const unsubscribeStacksLive = options.live?.subscribeStored(() => stacks.evaluate());
  const unsubscribeStacksReads = subscribeServiceReads(db, () => stacks.evaluate());
  const health = options.health === false ? undefined : new HealthSchedule(db, {
    ...options.health,
    cycle: options.health?.cycle ?? ((catalog, probe) => runHealthCycle(catalog, { ...probe, alerts: alerts.options(), tunnelHosts: alerts.options().tunnelHosts })),
    probe: { ...options.health?.probe, onAlerts: (changes) => alerts.publish(changes) },
  });
  const unsubscribeAlertsLive = options.live?.subscribeStored((read) => alerts.evaluate(read.at, read.machineId));
  const unsubscribeAlertsEdge = options.cloudflare?.subscribe(() => alerts.evaluate(new Date().toISOString()));
  const unsubscribeAlertsReads = subscribeServiceReads(db, (machineId, at) => alerts.evaluate(at, machineId));
  const deps = options.jobs ? { ...options.jobs, get machines() { return options.jobs!.machines; } } : null;
  if (deps && !deps.resolveDownload) deps.resolveDownload = createDownloadResolver(db, deps, options.downloads);
  const runner = deps ? new Runner(db, deps) : null;
  const protectedFile = protectedFileReader(options.control && options.control.protectedPath || options.protectedPath || ".scout-data/protected.json");
  let controlPort: number | undefined;
  const controlRunner = options.control === false ? null : new ControlRunner(db, { ...(options.protectedPath ? { protectedPath: options.protectedPath } : {}), ...(options.tunnelHostsPath ? { tunnelHostsPath: options.tunnelHostsPath } : {}), ...options.control, get machines() { return options.control ? options.control.machines : deps?.machines ?? []; }, stacksPath, context: { machineId: hubMachineId(), pid: process.pid, parentPid: process.ppid, ...(options.control ? options.control.context : {}) } });
  const control = { runner: controlRunner, protectedFile, context: () => controlRunner?.context() ?? { machineId: hubMachineId(), pid: process.pid, parentPid: process.ppid, ...(controlPort !== undefined ? { port: controlPort } : {}), config: protectedFile().config } };
  const downloadKinds = deps?.resolveDownload ? createDownloadKinds(db, deps.resolveDownload) : null;
  const hostAllowed = (host: string | undefined): boolean => (access ? host === access.config.host : isLoopbackHost(host));
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!hostAllowed(req.headers.host)) return send(res, 421, "misdirected request", "text/plain");
    if (access && !isPublicInstallAsset(req.method, new URL(req.url ?? "/", "http://localhost").pathname)) {
      const header = req.headers["cf-access-jwt-assertion"];
      const checked = await verifyAccessJwt(Array.isArray(header) ? header[0] : header, access.config, access.keys);
      if (!checked.ok) {
        access.log?.(`refused ${req.method} ${req.url}: ${checked.reason}`);
        return send(res, 403, "forbidden", "text/plain");
      }
      if (checked.claims.serviceToken !== undefined && !serviceTokenMayReach(req.method, new URL(req.url ?? "/", "http://localhost").pathname)) {
        access.log?.(`refused ${req.method} ${req.url}: a service token may reach only the tray and control actions`);
        return send(res, 403, "forbidden", "text/plain");
      }
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/tray" || url.pathname.startsWith("/api/tray/")) return trayApi(db, req, url, res, hostAllowed, json, { rulesPath: trayPath, read: trayFile, stacks: () => stacks.response().stacks, provenance, live: options.live, control: { context: () => control.context() } });
    if (url.pathname === "/api/resources/alerts") {
      if (!options.meterAlerts) return json(res, 404, { error: "meter alerts are off" });
      if (req.method === "POST") {
        const body = await readJson(req, res, hostAllowed, json);
        if (!body) return;
        try { return json(res, 200, options.meterAlerts.update(body)); } catch (error) { return json(res, 400, { error: (error as Error).message }); }
      }
      return json(res, 200, options.meterAlerts.status());
    }
    if (url.pathname === "/api/filters" || url.pathname.startsWith("/api/filters/")) return filtersApi(db, req, url, res, hostAllowed, json);
    // Refresh is a POST. The generic POST handler answers every other post it does not know with "read only".
    if (url.pathname === "/api/services/routes" || url.pathname === "/api/services/routes/overview" || url.pathname === "/api/services/routes/refresh") {
      return routesApi(db, req, url, res, hostAllowed, json, options.cloudflare, options.tunnelHostsPath);
    }
    if (url.pathname === "/api/listeners" || url.pathname === "/api/services" || url.pathname.startsWith("/api/services/")) {
      return servicesApi(db, req, url, res, hostAllowed, json, options.live, options.streamHeartbeatMs ?? 15_000, options.cloudflare, options.descriptions, control, alerts, recipes, health, registries, options.watch, provenance);
    }
    if (req.method === "POST") return decide(db, req, url, res, hostAllowed, runner, options.research, options.changelog, options.discoverModel, options.scans);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", "text/plain");
    try {
      if (url.pathname === "/api/changelog") {
        const packageId = Number(url.searchParams.get("packageId"));
        const version = url.searchParams.get("version");
        if (!Number.isSafeInteger(packageId) || packageId <= 0 || !version?.trim()) return json(res, 400, { error: "packageId and version are required" });
        const summary = changelogSummaryFor(db, packageId, version);
        return summary ? json(res, 200, { summary: summary.summary, sourceUrl: summary.sourceUrl, model: summary.model, createdAt: summary.createdAt }) : json(res, 404, { error: "no changelog summary" });
      }
      if (options.scans && url.pathname === "/api/scans") return json(res, 200, { machines: options.scans.status(), intervalSeconds: options.scans.intervalSeconds() });
      if (options.research && url.pathname === "/api/research/status") return json(res, 200, options.research.status());
      if (url.pathname === "/api/resources") { options.meters?.touch(); return json(res, 200, { ...resourcesResponse(db), intervalSeconds: options.meters?.intervalSeconds() ?? null }); }
      if (url.pathname === "/api/summary") return json(res, 200, summaryResponse(db));
      if (url.pathname === "/api/installs") return json(res, 200, installsResponse(db, url.searchParams, provenance()));
      if (url.pathname === "/api/provenance") return json(res, 200, provenanceResponse(db, mineFile()));
      if (url.pathname === "/api/updates") return json(res, 200, updatesResponse(db, url.searchParams));
      if (runner && url.pathname === "/api/updates/plan") {
        const plan = planResponse(db, runner, Number(url.searchParams.get("installId")), url.searchParams.get("alsoInstallIds"));
        return plan ? json(res, 200, plan) : json(res, 404, { error: "no such install or update" });
      }
      if (downloadKinds && url.pathname === "/api/downloads/kinds") return json(res, 200, downloadKinds.snapshot());
      if (runner && url.pathname === "/api/downloads/plan") {
        const installId = Number(url.searchParams.get("installId"));
        if (!Number.isSafeInteger(installId) || installId <= 0) return json(res, 400, { error: "installId must be a positive integer" });
        const plan = await runner.deps.resolveDownload?.(installId);
        return plan ? json(res, 200, plan.preview) : json(res, 404, { error: "no such install or update" });
      }
      if (runner && url.pathname === "/api/jobs") return json(res, 200, runner.jobs(Number(url.searchParams.get("limit")) || 50));
      const jobMatch = runner ? /^\/api\/jobs\/(\d+)$/.exec(url.pathname) : null;
      if (jobMatch) {
        const job = jobResponse(db, Number(jobMatch[1]));
        return job ? json(res, 200, job) : json(res, 404, { error: "no such job" });
      }
      if (url.pathname === "/api/coverage") return json(res, 200, coverageResponse(db));
      if (url.pathname === "/api/proposals") return json(res, 200, proposalsResponse(db));
      const m = /^\/api\/installs\/(\d+)$/.exec(url.pathname);
      if (m) {
        const detail = installDetail(db, Number(m[1]), provenance());
        return detail ? json(res, 200, detail) : json(res, 404, { error: "no such install" });
      }
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "no such route" });
      await serveStatic(webRoot, decodeURIComponent(url.pathname), res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  };
  const server = createServer((req, res) => {
    revalidate(req, res);
    handle(req, res).catch((err: Error) => {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });
  server.once("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") { controlPort = address.port; controlRunner?.setContext({ port: address.port }); }
  });
  if (options.health && options.health.scheduled) server.once("listening", () => health?.start());
  if (options.watch) server.once("listening", () => options.watch?.start());
  if (options.meters) server.once("listening", () => options.meters?.start());
  if (backupWatch) server.once("listening", () => backupWatch.start());
  // Git facts of the projects are read once the hub is listening and every 6 hours after, only where project roots are configured.
  let gitTimer: ReturnType<typeof setInterval> | undefined;
  if (options.recipeProjects) {
    const readGit = (): void => { void refreshProjectGit(db, options.recipeProjects!()).catch(() => undefined); };
    server.once("listening", () => { readGit(); gitTimer = setInterval(readGit, 6 * 3_600_000); gitTimer.unref(); });
    server.once("close", () => clearInterval(gitTimer));
  }
  server.once("close", () => { alerts.stop(); options.scans?.stop(); backupWatch?.stop(); options.meters?.stop(); controlRunner?.close(); unsubscribeRecipeDescriptions?.(); unsubscribeAlertsLive?.(); unsubscribeAlertsEdge?.(); unsubscribeAlertsReads(); unsubscribeWatchLive?.(); options.watch?.stop(); unsubscribeStacksLive?.(); unsubscribeStacksReads(); health?.stop(); });
  return server;
}
