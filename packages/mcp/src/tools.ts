import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { actionById, applyGateChange, applyWatchChange, parseCompetitorsFile, readGateSettings,alertsFileReader, alertsResponse, claimCompetitorRun, completeCompetitorRun, failCompetitorRun, hubMachineId, listActions, listCompetitorRuns, listCompetitors, loadTunnelHosts, openCatalog, outagesResponse, portsFileReader, portsResponse, systemsMapMarkdown, watchFileReader, whoIs, type ActionRecord, type ControlAction, type ControlTarget, type Db } from "@scout/core";
import { ControlRunner, loadMachines, localMapInput, localStatus, localTray, type ControlRunnerDeps, type LocalPaths } from "@scout/ops";
import type { Tool } from "./server.ts";

export interface ToolContext {
  paths: LocalPaths;
  /** Overrides for the control runner, used by tests to stand in for the machine. */
  control?: Partial<ControlRunnerDeps>;
  /** Overrides for the competitor catalog functions, used by tests before those functions exist. */
  competitors?: {
    listCompetitors?: typeof listCompetitors;
    listCompetitorRuns?: typeof listCompetitorRuns;
    claimCompetitorRun?: typeof claimCompetitorRun;
    completeCompetitorRun?: typeof completeCompetitorRun;
    failCompetitorRun?: typeof failCompetitorRun;
  };
  now?: () => string;
}

const MAX_ROWS = 500;
const COMPETITOR_CAP = 200;
const STATES = ["up", "changed", "down", "stopped", "unknown"] as const;
const COMPETITOR_STATUS = ["new", "current", "unknown"] as const;
const QUEUE_STATES = ["queued", "claimed"] as const;

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });
const text = (args: Record<string, unknown>, key: string, max = 200): string | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${key} must be a string of at most ${max} characters`);
  return value;
};
const integer = (args: Record<string, unknown>, key: string, min: number, max: number): number | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return value;
};
const choice = <T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T => {
  const value = args[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  return value as T;
};
const queueStates = (args: Record<string, unknown>): Array<(typeof QUEUE_STATES)[number]> => {
  const value = args.states;
  if (value === undefined) return ["queued"];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !(QUEUE_STATES as readonly string[]).includes(item))) throw new Error("states must be a list of queued or claimed");
  return value as Array<(typeof QUEUE_STATES)[number]>;
};
const requiredText = (args: Record<string, unknown>, key: string, max: number): string => {
  const value = text(args, key, max);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
};
const runIdOf = (args: Record<string, unknown>): number => {
  const id = integer(args, "runId", 1, Number.MAX_SAFE_INTEGER);
  if (id === undefined) throw new Error("runId is required");
  return id;
};
const filters = (args: Record<string, unknown>, keys: string[]): URLSearchParams => {
  const params = new URLSearchParams();
  for (const key of keys) { const value = text(args, key); if (value !== undefined) params.set(key, value); }
  return params;
};

const brief = (record: ActionRecord | null): unknown => record && { id: record.id, state: record.state, action: record.action, name: record.name, machineId: record.machineId, message: record.message, at: record.at, finishedAt: record.finishedAt };
const withoutToken = <T extends { token?: unknown }>(plan: T): Omit<T, "token"> => { const { token: _token, ...rest } = plan; void _token; return rest; };

/** The tools an agent gets. Reads are free. scout_start_service can only start a stopped service. scout_competitor_claim, scout_competitor_complete, and scout_competitor_fail move a research run state and never touch files, repositories, or machines. scout_competitor_gate and scout_competitor_watch edit only the competitors registry file. */
export function createTools(context: ToolContext): Tool[] {
  const { paths } = context;
  const now = (): string => context.now?.() ?? new Date().toISOString();
  const competitors = {
    listCompetitors: context.competitors?.listCompetitors ?? listCompetitors,
    listCompetitorRuns: context.competitors?.listCompetitorRuns ?? listCompetitorRuns,
    claimCompetitorRun: context.competitors?.claimCompetitorRun ?? claimCompetitorRun,
    completeCompetitorRun: context.competitors?.completeCompetitorRun ?? completeCompetitorRun,
    failCompetitorRun: context.competitors?.failCompetitorRun ?? failCompetitorRun,
  };
  const writeRegistry = <T>(next: string, result: (text: string) => T): T => {
    parseCompetitorsFile(next);
    const temp = `${paths.competitors}.tmp`;
    writeFileSync(temp, next, "utf8");
    renameSync(temp, paths.competitors);
    return result(next);
  };
  const withDb = async <T>(use: (db: Db) => T | Promise<T>): Promise<T> => {
    const db = openCatalog(paths.db);
    try { return await use(db); } finally { db.close(); }
  };
  /** A plan reads the catalog only; a live runner also reads the machine's real state before it acts. */
  const runner = (db: Db, live: boolean): ControlRunner => new ControlRunner(db, {
    machines: context.control?.machines ?? loadMachines(paths.machines), protectedPath: paths.protectedFile, stacksPath: paths.stacks, tunnelHostsPath: paths.tunnelHosts,
    context: { machineId: hubMachineId(), pid: process.pid, parentPid: process.ppid },
    ...(live ? {} : { reader: async (_machine, stored) => stored }),
    ...context.control,
  });
  const row = (args: Record<string, unknown>): { target: ControlTarget; id: number } => {
    const id = integer(args, "id", 1, Number.MAX_SAFE_INTEGER);
    if (id === undefined) throw new Error("id is required");
    return { target: choice(args, "target", ["service", "listener"] as const), id };
  };
  const rowProps = { target: { type: "string", enum: ["service", "listener"], description: "What kind of row the id belongs to." }, id: { type: "integer", minimum: 1, description: "The row id from scout_services or scout_whois." } };

  return [
    { name: "scout_status", readOnly: true, description: "How the fleet is doing right now: the overall state (up, changed, down), each machine with counts of up, changed, down and stopped rows, the open outages, and the rows that are down or changed. Start here.", inputSchema: object({}), run: () => withDb((db) => localStatus(db, paths, now())) },
    { name: "scout_whois", readOnly: true, description: "Finds what is listening on a port (a number) or what matches a name (text) on every machine, with the program behind it and the machine it runs on.", inputSchema: object({ query: { type: "string", description: "A port number from 1 to 65535, or part of a service, process, container or image name." } }, ["query"]), run: (args) => withDb((db) => { const query = text(args, "query") ?? ""; return { query, matches: whoIs(db, query) }; }) },
    { name: "scout_services", readOnly: true, description: "Lists the services, listeners, stacks and launch recipes Scout keeps up on each machine, with the id and target to use with the action tools, the state, port, whether the row is protected, and which actions are available.", inputSchema: object({ machine: { type: "string", description: "A machine id, such as eru or bilbo." }, state: { type: "string", enum: [...STATES] }, query: { type: "string", description: "Part of a row's name." }, limit: { type: "integer", minimum: 1, maximum: MAX_ROWS, description: "At most this many rows; the default is 100." } }), run: (args) => withDb((db) => {
      const machine = text(args, "machine");
      const state = args.state === undefined ? undefined : choice(args, "state", STATES);
      const query = text(args, "query")?.toLowerCase();
      const limit = integer(args, "limit", 1, MAX_ROWS) ?? 100;
      const rows = localTray(db, paths, now()).machines.filter((m) => machine === undefined || m.id === machine).flatMap((m) => m.rows).filter((r) => (state === undefined || r.state === state) && (query === undefined || `${r.label} ${r.name}`.toLowerCase().includes(query)));
      return { total: rows.length, rows: rows.slice(0, limit).map((r) => ({ key: r.key, target: r.target, id: r.id, name: r.label, machine: r.machineId, kind: r.kind, state: r.state, port: r.port, detail: r.detail, protected: r.protected, protectedReason: r.protectedReason, availableActions: r.actions.filter((a) => a.available).map((a) => a.action), needsAdmin: r.needsAdmin })) };
    }) },
    { name: "scout_outages", readOnly: true, description: "The outage log: what went down, when, how long, and whether it is still open.", inputSchema: object({ state: { type: "string", enum: ["open", "closed", "all"] }, machine: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } }), run: (args) => withDb((db) => {
      const params = filters(args, ["state", "machine"]);
      const limit = integer(args, "limit", 1, 500);
      if (limit !== undefined) params.set("limit", String(limit));
      const { outages, open, generatedAt } = outagesResponse(db, watchFileReader(paths.watch)(), params, now());
      return { open, outages, generatedAt };
    }) },
    { name: "scout_alerts", readOnly: true, description: "Alerts Scout has raised (outages, expiring certificates, and similar), with their state.", inputSchema: object({ state: { type: "string" }, kind: { type: "string" }, machine: { type: "string" } }), run: (args) => withDb((db) => alertsResponse(db, filters(args, ["state", "kind", "machine"]), now(), { loadMutes: alertsFileReader(paths.alerts), tunnelHosts: loadTunnelHosts(paths.tunnelHosts) })) },
    { name: "scout_ports", readOnly: true, description: "The port registry: each range with how many ports are used and the next free one, and each reserved port with what holds it.", inputSchema: object({}), run: () => withDb((db) => portsResponse(db, portsFileReader(paths.ports)(), now())) },
    { name: "scout_systems_map", readOnly: true, description: "One markdown document of what runs where: every machine's rows with state and port, the stacks, and the port registry.", inputSchema: object({}), run: () => withDb((db) => systemsMapMarkdown(localMapInput(db, paths, now()))) },
    { name: "scout_action_log", readOnly: true, description: "The audit log of start, stop, restart, disable and enable actions: what was done, where, and how it ended.", inputSchema: object({ machine: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200, description: "The default is 20." } }), run: (args) => withDb((db) => {
      const machine = text(args, "machine");
      return { items: listActions(db, { limit: integer(args, "limit", 1, 200) ?? 20, ...(machine ? { machine } : {}) }).map(brief) };
    }) },
    { name: "scout_plan_action", readOnly: true, description: "Drafts a start, stop, restart, disable or enable for a service or listener and returns the plan: whether it is allowed, what it would do, what would break, and why it is refused when it is. It never carries the action out. To stop, restart, disable or enable, a person confirms on the Scout page, in the tray panel, or with the control command on the CLI.", inputSchema: object({ ...rowProps, action: { type: "string", enum: ["start", "stop", "restart", "disable", "enable"] }, hard: { type: "boolean", description: "Force-stop instead of a graceful stop; only for stop." } }, ["target", "id", "action"]), run: (args) => withDb(async (db) => {
      const { target, id } = row(args);
      const action: ControlAction = choice(args, "action", ["start", "stop", "restart", "disable", "enable"] as const);
      const hard = args.hard === true;
      if (hard && action !== "stop") throw new Error("hard is allowed only for stop");
      const control = runner(db, false);
      try {
        const plan = await control.plan(target, id, action, hard);
        if (!plan) throw new Error("not found");
        return { plan: withoutToken(plan), carriedOut: false, confirmWith: action === "start" ? "scout_start_service" : `node packages/cli/src/main.ts control run ${target} ${id} ${action}${hard ? " --hard" : ""} --yes (or the Scout page, or the tray panel)` };
      } finally { control.close(); }
    }) },
    { name: "scout_start_service", readOnly: false, description: "Starts a stopped service or listener in one call: plans the start, and when the plan is allowed, carries it out and waits for the result. It cannot stop or restart anything. A protected or already-running row is refused with the reason. When the start needs admin rights, it returns the command or the prompt to approve instead of waiting.", inputSchema: object(rowProps, ["target", "id"]), run: (args) => withDb(async (db) => {
      const { target, id } = row(args);
      const control = runner(db, true);
      try {
        const plan = await control.plan(target, id, "start", false);
        if (!plan) throw new Error("not found");
        if (!plan.allowed || !plan.id || !plan.token) return { started: false, plan: withoutToken(plan) };
        const started = await control.run(plan.id, plan.token);
        if (started.state === "waiting") return { started: false, state: "waiting", actionId: started.actionId, sudoCommand: started.sudoCommand ?? null, note: "The start needs admin rights. Approve the prompt on the machine or run the command, then check scout_action_log." };
        const done = await control.wait(started.actionId);
        return { started: done?.state === "done", result: brief(done ?? actionById(db, started.actionId)) };
      } finally { control.close(); }
    }) },
    { name: "scout_competitors", readOnly: true, description: "Lists the competitors Scout watches, with status, the last analyzed version, the latest version, mirror sync, any pending gate, and any research run. The research queue fills itself when a change is large enough. Pass status to keep only new, current, or unknown. At most 200 rows come back.", inputSchema: object({ status: { type: "string", enum: [...COMPETITOR_STATUS], description: "Keep only competitors in this status." } }), run: (args) => {
      const status = args.status === undefined ? undefined : choice(args, "status", COMPETITOR_STATUS);
      return withDb((db) => {
        const rows = competitors.listCompetitors(db, now()).filter((row) => status === undefined || row.status === status);
        return { total: rows.length, competitors: rows.slice(0, COMPETITOR_CAP) };
      });
    } },
    { name: "scout_competitor_queue", readOnly: true, description: "Lists research runs in the given states, newest first, including each run's request. The queue fills itself. The request includes a procedural analysis that is already computed. The default is queued.", inputSchema: object({ states: { type: "array", items: { type: "string", enum: [...QUEUE_STATES] }, description: "queued, claimed, or both. The default is queued." } }), run: (args) => {
      const states = queueStates(args);
      return withDb((db) => ({ runs: competitors.listCompetitorRuns(db, states, now()) }));
    } },
    { name: "scout_competitor_gate", readOnly: false, description: "Reads or changes when research is queued automatically. With no set or clear, it returns the built-in defaults, the file-wide gate, and each competitor's own override. With set, it changes those fields (minCommits, minSourceFilesChanged, quietHours, maxQueued, onNewTag, ignoreDocsOnly, ignoreDependencyBumpOnly, enabled); with clear, it drops fields so they fall back. Pass id to change one competitor's override instead of the file-wide gate. It edits only the competitors registry file, and the hub applies it at its next check.", inputSchema: object({ id: { type: "string", maxLength: 80, description: "A competitor id. Left out, the file-wide gate changes." }, set: { type: "object", description: "Fields and their new values." }, clear: { type: "array", items: { type: "string" }, description: "Fields to drop." } }), run: (args) => {
      const id = text(args, "id", 80);
      const set = args.set;
      if (set !== undefined && (!set || typeof set !== "object" || Array.isArray(set))) throw new Error("set must be an object");
      const clear = args.clear;
      if (clear !== undefined && (!Array.isArray(clear) || clear.some((item) => typeof item !== "string"))) throw new Error("clear must be a list of field names");
      const before = readFileSync(paths.competitors, "utf8");
      if (set === undefined && clear === undefined) return readGateSettings(before);
      return writeRegistry(applyGateChange(before, { ...(id !== undefined ? { id } : {}), ...(set ? { set: set as Record<string, unknown> } : {}), ...(clear ? { clear: clear as string[] } : {}) }), readGateSettings);
    } },
    { name: "scout_competitor_watch", readOnly: false, description: "Sets or removes the version source for a competitor that has no public repository. watch is an object with kind json (a version at a dotted versionPath in a JSON document), page (a version found in a page's text, with an optional versionPattern that has one capture group), or hash (no version; the page's text is compared for change), and an https url on a public host. Pass null to remove the source. It edits only the competitors registry file, and the hub reads it at its next check.", inputSchema: object({ id: { type: "string", maxLength: 80 }, watch: { description: "The watch object, or null to remove it." } }, ["id"]), run: (args) => {
      const id = requiredText(args, "id", 80);
      if (!("watch" in args)) throw new Error("watch is required, or null to remove it");
      return writeRegistry(applyWatchChange(readFileSync(paths.competitors, "utf8"), id, args.watch), () => ({ ok: true }));
    } },
    { name: "scout_competitor_claim", readOnly: false, description: "Claims a queued research run for the named person. It changes the run's state and does not touch files, repositories, or machines.", inputSchema: object({ runId: { type: "integer", minimum: 1 }, by: { type: "string", maxLength: 80, description: "Who is taking the run. At most 80 characters." } }, ["runId", "by"]), run: (args) => {
      const runId = runIdOf(args);
      const by = requiredText(args, "by", 80);
      return withDb((db) => competitors.claimCompetitorRun(db, runId, by, now()));
    } },
    { name: "scout_competitor_complete", readOnly: false, description: "Marks a claimed research run done, records where the findings went, and sets the analyzed version when one is given. It changes the run's state and does not touch files, repositories, or machines.", inputSchema: object({ runId: { type: "integer", minimum: 1 }, resultPath: { type: "string", maxLength: 500 }, summary: { type: "string", maxLength: 2000 }, analyzedVersion: { type: "string", maxLength: 80 } }, ["runId", "resultPath", "summary"]), run: (args) => {
      const runId = runIdOf(args);
      const resultPath = requiredText(args, "resultPath", 500);
      const summary = requiredText(args, "summary", 2000);
      const analyzedVersion = text(args, "analyzedVersion", 80);
      const input: { resultPath: string; summary: string; analyzedVersion?: string } = { resultPath, summary };
      if (analyzedVersion !== undefined) input.analyzedVersion = analyzedVersion;
      return withDb((db) => competitors.completeCompetitorRun(db, runId, input, now()));
    } },
    { name: "scout_competitor_fail", readOnly: false, description: "Marks a research run failed and stores the reason. It changes the run's state and does not touch files, repositories, or machines.", inputSchema: object({ runId: { type: "integer", minimum: 1 }, error: { type: "string", maxLength: 500 } }, ["runId", "error"]), run: (args) => {
      const runId = runIdOf(args);
      const error = requiredText(args, "error", 500);
      return withDb((db) => competitors.failCompetitorRun(db, runId, error, now()));
    } },
  ];
}
