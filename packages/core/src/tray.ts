import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./db.ts";
import { controlRow, rowControl, type ControlAction, type ControlTarget } from "./control.ts";
import { loadDescriptionResolver } from "./descriptions.ts";
import { launchLabel, listListeners, type Listener } from "./listeners.ts";
import { latestMeters, trayMeters, type TrayMeters } from "./meters.ts";
import { listOutages, listenerWatchKey, serviceOwnsListener, serviceWatchKey, serviceWatchable, watchContext } from "./outages.ts";
import type { ProtectedContext } from "./protected.ts";
import { recipesResponse } from "./recipes.ts";
import { listServices, type Service } from "./services.ts";
import type { StackState } from "./stacks.ts";

// The tray panel lists what is meant to stay up on each machine, plus stacks and approved launch recipes, minus anything the rules hide. Hiding a row here never changes what the outage watch checks.

export interface TrayNameRule { machine?: string; match: string }
export interface TrayRules {
  hide: { kinds: string[]; classes: string[]; machines: string[]; vendors: string[]; names: TrayNameRule[] };
  pins: { machine: string; key: string }[];
}
export const EMPTY_TRAY_RULES: TrayRules = { hide: { kinds: [], classes: [], machines: [], vendors: [], names: [] }, pins: [] };

const KINDS = ["windows-service", "launchd", "scheduled-task", "listener", "container", "recipe", "stack"];
const CLASSES = ["essential", "optional", "third-party"];
const VENDORS = ["apple", "microsoft", "other"];
const strings = (value: unknown, name: string, allowed?: readonly string[]): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) throw new Error(`${name} must be a list of text values.`);
  const bad = allowed ? value.find((v) => !allowed.includes(v)) : undefined;
  if (bad !== undefined) throw new Error(`${name} has an unknown value "${bad}".`);
  return value as string[];
};

/** Validates a rules document and returns it with every missing list filled in. Throws a readable message for anything malformed. */
export function parseTrayRules(data: unknown): TrayRules {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The tray rules must be an object.");
  const { hide = {}, pins = [] } = data as { hide?: unknown; pins?: unknown };
  if (!hide || typeof hide !== "object" || Array.isArray(hide)) throw new Error("hide must be an object.");
  const h = hide as Record<string, unknown>;
  const names = h.names === undefined ? [] : h.names;
  if (!Array.isArray(names) || !names.every((n) => n && typeof n === "object" && typeof (n as TrayNameRule).match === "string" && (n as TrayNameRule).match.length > 0 && (n as TrayNameRule).match.length <= 200 && ((n as TrayNameRule).machine === undefined || typeof (n as TrayNameRule).machine === "string"))) throw new Error("hide.names must be a list of {machine?, match} entries.");
  if (!Array.isArray(pins) || !pins.every((p) => p && typeof p === "object" && typeof (p as { machine: unknown }).machine === "string" && typeof (p as { key: unknown }).key === "string")) throw new Error("pins must be a list of {machine, key} entries.");
  return {
    hide: { kinds: strings(h.kinds, "hide.kinds", KINDS), classes: strings(h.classes, "hide.classes", CLASSES), machines: strings(h.machines, "hide.machines"), vendors: strings(h.vendors, "hide.vendors", VENDORS), names: (names as TrayNameRule[]).map((n) => n.machine === undefined ? { match: n.match } : { machine: n.machine, match: n.match }) },
    pins: (pins as { machine: string; key: string }[]).map((p) => ({ machine: p.machine, key: p.key })),
  };
}

export interface TrayFile { rules: TrayRules; fileError: string | null }

/** Reads the rules file with a stamp cache. A missing file means no rules; a damaged one is ignored and reported. */
export function trayFileReader(path: string): () => TrayFile {
  let stamp: string | null = null;
  let cached: TrayFile = { rules: EMPTY_TRAY_RULES, fileError: null };
  return () => {
    try {
      const stat = statSync(path);
      const next = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === next) return cached;
      stamp = next;
      cached = { rules: parseTrayRules(JSON.parse(readFileSync(path, "utf8"))), fileError: null };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      stamp = null;
      cached = { rules: EMPTY_TRAY_RULES, fileError: missing ? null : `The tray rules file is damaged and is ignored: ${(err as Error).message}` };
    }
    return cached;
  };
}

/** Writes validated rules by replacing the file in one step. */
export function writeTrayRules(path: string, rules: unknown): TrayRules {
  const checked = parseTrayRules(rules);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(checked, null, 2)}\n`);
  renameSync(temp, path);
  return checked;
}

export type TrayState = "up" | "changed" | "down" | "stopped" | "unknown";
export interface TrayAction { action: ControlAction; available: boolean; reason: string | null }
export interface TrayRow {
  key: string;
  target: ControlTarget;
  /** The catalog row id for a service, listener or recipe; null for a stack, which is named. */
  id: number | null;
  name: string;
  label: string;
  machineId: string;
  kind: string;
  /** essential, optional or third-party; null when the row is not classified (stacks and recipes). */
  class: string | null;
  /** apple, microsoft or other; null when unclassified. */
  vendor: string | null;
  state: TrayState;
  port: number | null;
  detail: string;
  protected: boolean;
  protectedReason: string | null;
  actions: TrayAction[];
  needsAdmin: boolean;
  mine: boolean;
  pinned: boolean;
  /** Recent probe latencies in ms, oldest first, with null for a failed probe; null when no probe covers the row's port. */
  spark: (number | null)[] | null;
}
export interface TrayMachine {
  id: string;
  name: string;
  os: string;
  reachable: boolean;
  lastSeen: string | null;
  worst: TrayState;
  counts: Record<TrayState, number>;
  /** Rows the hide rules left out of this machine. */
  hidden: number;
  rows: TrayRow[];
  /** The newest meter reading, summarized; null until the hub has read the machine. */
  meters: TrayMeters | null;
}
/** What the panel needs of a stack: the hub passes its stack response. */
export interface TrayStack { name: string; label: string; state: StackState; members: { running: boolean | null }[] }
export interface TrayOptions {
  now?: string;
  context?: ProtectedContext;
  stacks?: TrayStack[];
  /** Whether a row belongs to the user's own projects (the provenance profile lives in the hub). */
  mine?: (row: { machineId: string; path: string | null; ports: number[] }) => boolean;
  /** Live reachability from the hub, which can be fresher than the catalog's machine state; return null to fall back to the catalog. */
  reachable?: (machineId: string) => boolean | null;
}

const ORDER: Record<TrayState, number> = { down: 0, changed: 1, up: 2, stopped: 3, unknown: 4 };
const globRe = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");

function hidden(rules: TrayRules, row: { machineId: string; kind: string; cls: string | null; vendor: string | null; names: string[] }): boolean {
  const h = rules.hide;
  if (h.machines.includes(row.machineId) || h.kinds.includes(row.kind)) return true;
  if (row.cls !== null && h.classes.includes(row.cls)) return true;
  if (row.vendor !== null && h.vendors.includes(row.vendor)) return true;
  return h.names.some((rule) => (rule.machine === undefined || rule.machine === row.machineId) && row.names.some((name) => globRe(rule.match).test(name)));
}

function sparkFor(db: Db, machineId: string, ports: number[]): (number | null)[] | null {
  for (const port of ports) {
    const samples = db.prepare("SELECT latency_ms AS ms, ok FROM health_samples WHERE target_key = ? ORDER BY at DESC, id DESC LIMIT 30").all(`listener:${machineId}:${port}`) as { ms: number | null; ok: number }[];
    if (samples.length > 1) return samples.reverse().map((s) => s.ok === 1 ? s.ms : null);
  }
  return null;
}

const stateOf = (running: boolean, shouldRun: boolean, health: string | undefined): TrayState => {
  if (!running) return shouldRun ? "down" : "stopped";
  if (health === "failing" || health === "down") return "down";
  return health === "slow" ? "changed" : "up";
};

export function trayResponse(db: Db, rules: TrayRules, options: TrayOptions = {}): { machines: TrayMachine[]; state: TrayState; openOutages: number; hidden: number; version: string; generatedAt: string } {
  const now = options.now ?? new Date().toISOString();
  const context = options.context ?? {};
  const descriptions = loadDescriptionResolver(db, { hints: [] });
  const machines = db.prepare("SELECT id, name, os, state, last_seen AS lastSeen FROM machines WHERE kind = 'host' ORDER BY name").all() as { id: string; name: string; os: string; state: string; lastSeen: string | null }[];
  const meters = new Map(latestMeters(db).map((sample) => [sample.machineId, trayMeters(sample, now)]));
  const pinned = new Set(rules.pins.map((pin) => `${pin.machine}|${pin.key}`));
  const recipes = recipesResponse(db).recipes.filter((r) => r.state === "approved" && !r.gone);
  const out: TrayMachine[] = machines.map((machine) => {
    const reachable = options.reachable?.(machine.id) ?? (machine.state !== "unreachable" && machine.state !== "stopped");
    const services = listServices(db, { machine: machine.id }, descriptions).filter((s) => s.goneAt === null);
    const listeners = listListeners(db, { machine: machine.id, state: "present" }, descriptions);
    const watch = watchContext(db, services);
    // Like the outage watch, a stopped service counts as down only when it has been seen running; one that never ran is just stopped.
    const proven = new Set((db.prepare("SELECT key FROM watch_state WHERE machine_id = ? AND kind = 'service' AND (last_state = 'up' OR failures > 0)").all(machine.id) as { key: string }[]).map((row) => row.key));
    const rows: TrayRow[] = [];
    let hiddenRows = 0;
    const finish = (row: Omit<TrayRow, "pinned" | "state"> & { state: TrayState }, shown: boolean, keep: boolean): void => {
      const isPinned = pinned.has(`${machine.id}|${row.key}`);
      if (!shown && !isPinned) return;
      if (!keep && !isPinned) { hiddenRows++; return; }
      rows.push({ ...row, state: reachable ? row.state : "unknown", pinned: isPinned });
    };
    const serviceRow = (s: Service, shouldRun: boolean): void => {
      const ports = s.ports.map((p) => p.port);
      const control = rowControl(controlRow(s, services), context);
      const health = s.ports.find((p) => p.health)?.health?.state;
      const running = s.state === "running";
      finish({
        key: serviceWatchKey(s), target: "service", id: s.id, name: s.name, label: s.displayName ?? s.name, machineId: machine.id, kind: s.kind, class: s.classification.class, vendor: s.classification.vendor,
        state: stateOf(running, shouldRun && proven.has(serviceWatchKey(s)), health), port: ports[0] ?? null,
        detail: running ? (ports.length ? `:${ports.join(", :")}` : s.kind === "launchd" ? "launchd job" : "service") : `${s.state}${s.lastResult ? `, last result ${s.lastResult}` : ""}`,
        protected: control.protected.protected, protectedReason: control.protected.reason, actions: control.actions, needsAdmin: control.needsAdmin,
        mine: options.mine?.({ machineId: machine.id, path: s.program, ports }) ?? false, spark: sparkFor(db, machine.id, ports),
      }, true, !hidden(rules, { machineId: machine.id, kind: s.kind, cls: s.classification.class, vendor: s.classification.vendor, names: [s.name, s.displayName ?? ""] }));
    };
    for (const s of services) if (serviceWatchable(db, s, watch)) serviceRow(s, true);
    // A pin brings back a service the default set leaves out.
    for (const s of services) if (!serviceWatchable(db, s, watch) && pinned.has(`${machine.id}|${serviceWatchKey(s)}`)) serviceRow(s, false);
    const owned = (l: Listener): boolean => services.some((s) => serviceOwnsListener(s, l));
    const listenerRow = (l: Listener, shouldRun: boolean): void => {
      const control = rowControl(controlRow(l, services), context);
      const container = l.containerName !== null;
      const name = l.processName ?? l.containerName ?? `port ${l.port}`;
      const shown = container ? name : launchLabel(l.processName, l.scriptPath, l.owner) ?? name;
      finish({
        key: listenerWatchKey(l), target: "listener", id: l.id, name, label: container ? `${l.containerName}` : shown, machineId: machine.id, kind: container ? "container" : "listener", class: l.classification.class, vendor: l.classification.vendor,
        state: stateOf(true, shouldRun, l.health?.state), port: l.port, detail: `:${l.port}`,
        protected: control.protected.protected, protectedReason: control.protected.reason, actions: control.actions, needsAdmin: control.needsAdmin,
        mine: options.mine?.({ machineId: machine.id, path: l.processPath, ports: [l.port] }) ?? false, spark: sparkFor(db, machine.id, [l.port]),
      }, true, !hidden(rules, { machineId: machine.id, kind: container ? "container" : "listener", cls: l.classification.class, vendor: l.classification.vendor, names: [name, l.containerName ?? ""] }));
    };
    for (const l of listeners) if (!owned(l)) {
      if (serviceWatchable(db, l, watch)) listenerRow(l, true);
      else if (pinned.has(`${machine.id}|${listenerWatchKey(l)}`)) listenerRow(l, false);
    }
    for (const r of recipes.filter((recipe) => recipe.machineId === machine.id)) {
      const label = `${r.project} ${r.name}`;
      const running = r.running === true;
      finish({
        key: `recipe:${machine.id}:${r.project}:${r.name}`, target: "recipe", id: r.id, name: r.name, label, machineId: machine.id, kind: "recipe", class: null, vendor: null,
        state: running ? "up" : "stopped", port: r.port, detail: r.port === null ? r.command : `:${r.port}`, protected: false, protectedReason: null,
        actions: [{ action: "start", available: !running, reason: running ? "Already running" : null }, { action: "stop", available: running, reason: running ? null : "Not running" }, { action: "restart", available: running, reason: running ? null : "Not running" }],
        needsAdmin: false, mine: options.mine?.({ machineId: machine.id, path: r.cwd, ports: r.port === null ? [] : [r.port] }) ?? false, spark: r.port === null ? null : sparkFor(db, machine.id, [r.port]),
      }, true, !hidden(rules, { machineId: machine.id, kind: "recipe", cls: null, vendor: null, names: [r.name, label] }));
    }
    rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || ORDER[a.state] - ORDER[b.state] || a.label.localeCompare(b.label));
    const counts: Record<TrayState, number> = { up: 0, changed: 0, down: 0, stopped: 0, unknown: 0 };
    for (const row of rows) counts[row.state]++;
    const worst: TrayState = counts.down ? "down" : counts.changed ? "changed" : reachable ? "up" : "unknown";
    return { id: machine.id, name: machine.name, os: machine.os, reachable, lastSeen: machine.lastSeen, worst, counts, hidden: hiddenRows, rows, meters: meters.get(machine.id) ?? null };
  }).filter((machine) => !rules.hide.machines.includes(machine.id));

  const allStacks = options.stacks ?? [];
  const stackRows = allStacks.filter((stack) => !hidden(rules, { machineId: "stacks", kind: "stack", cls: null, vendor: null, names: [stack.name, stack.label] }));
  const stackHidden = allStacks.length - stackRows.length;
  if (stackRows.length) {
    const rows: TrayRow[] = stackRows.map((stack) => {
      const running = stack.state === "running";
      const started = stack.state === "running" || stack.state === "partial";
      return {
        key: `stack:${stack.name}`, target: "stack", id: null, name: stack.name, label: stack.label, machineId: "stacks", kind: "stack", class: null, vendor: null,
        state: running ? "up" : stack.state === "partial" ? "changed" : stack.state === "blocked" ? "unknown" : "stopped", port: null,
        detail: `${stack.members.filter((m) => m.running === true).length} of ${stack.members.length} running`, protected: false, protectedReason: null,
        actions: [{ action: "start", available: stack.state !== "blocked" && !running, reason: stack.state === "blocked" ? "A member is unavailable" : running ? "Already running" : null }, { action: "stop", available: started, reason: started ? null : "Not running" }, { action: "restart", available: started, reason: started ? null : "Not running" }],
        needsAdmin: false, mine: false, pinned: false, spark: null,
      };
    });
    const counts: Record<TrayState, number> = { up: 0, changed: 0, down: 0, stopped: 0, unknown: 0 };
    for (const row of rows) counts[row.state]++;
    out.push({ id: "stacks", name: "Stacks", os: "", reachable: true, lastSeen: null, worst: counts.changed ? "changed" : "up", counts, hidden: stackHidden, rows, meters: null });
  }

  const openOutages = listOutages(db, { state: "open", now }).length;
  const state: TrayState = openOutages > 0 || out.some((m) => m.worst === "down") ? "down" : out.some((m) => m.worst === "changed") ? "changed" : "up";
  const body = { machines: out, state, openOutages, hidden: out.reduce((sum, machine) => sum + (machine.id === "stacks" ? 0 : machine.hidden), 0) + stackHidden };
  const version = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, version, generatedAt: now };
}
