import { recordListeners, recordServices, runProbe, type Db, type ListenerAdapter, type ListenerResult, type Probe, type ProbeOutput, type ServiceAdapter, type ServiceResult, type Transport } from "@scout/core";
import { dockerPortsAdapter, linuxListenersAdapter, macListenersAdapter, windowsListenersAdapter } from "@scout/adapter-listeners";
import { linuxSystemdAdapter, macLaunchdStateAdapter, windowsServicesAdapter, windowsTasksAdapter } from "@scout/adapter-services";
import { alertsFileReader, evaluateAlerts, loadTunnelHosts, type AlertChange, type AlertOptions } from "@scout/core";

export const LISTENER_ADAPTERS: ListenerAdapter[] = [windowsListenersAdapter, macListenersAdapter, linuxListenersAdapter, dockerPortsAdapter];

export const SERVICE_ADAPTERS: ServiceAdapter[] = [windowsServicesAdapter, windowsTasksAdapter, macLaunchdStateAdapter, linuxSystemdAdapter];

// Get-ScheduledTaskInfo walks every task and takes about two minutes on a Windows machine with many tasks.
const TASK_ORIGIN = "win-tasks";
const TASK_TIMEOUT_MS = 600_000;
const TASK_LABEL = "Scheduled tasks";

export interface LiveMachine {
  id: string;
  os: "windows" | "macos" | "linux";
  transport: Transport;
}

export type ProbeRunner = (transport: Transport, probe: Probe, timeoutMs?: number) => Promise<ProbeOutput>;

export interface LiveProbeUpdate {
  probe: string;
  label: string;
  phase: "start" | "done" | "failed";
  message: string | null;
}

export interface LiveReadResult {
  changed: boolean;
  tables: ("services" | "listeners")[];
  status: "ok" | "partial" | "failed";
  error: string | null;
}

export interface CollectOptions {
  alerts?: AlertOptions & { evaluate?: typeof evaluateAlerts; onChanges?: (changes: AlertChange[]) => void };
  log?: (line: string) => void;
  run?: ProbeRunner;
  now?: () => string;
  /** Set for a live read. A scan omits it and keeps the transport's own limit. */
  cheapTimeoutMs?: number;
  onProbe?: (update: LiveProbeUpdate) => void;
}

interface StoreOptions {
  log?: (line: string) => void;
  run: ProbeRunner;
  now: string;
  cheapTimeoutMs?: number;
  slow?: boolean;
  onProbe?: (update: LiveProbeUpdate) => void;
}

function probeOutput(run: ProbeRunner, transport: Transport, probe: Probe, timeoutMs: number | undefined): Promise<ProbeOutput> {
  return timeoutMs === undefined ? run(transport, probe) : run(transport, probe, timeoutMs);
}

function listenerLine(result: ListenerResult): string {
  return `  listeners ${result.origin.padEnd(12)}${result.status.padEnd(8)}${String(result.facts.length).padStart(5)} facts${result.message ? `  (${result.message})` : ""}`;
}

function serviceLine(result: ServiceResult): string {
  return `  services ${result.origin.padEnd(14)}${result.status.padEnd(8)}${String(result.facts.length).padStart(5)} facts${result.message ? `  (${result.message})` : ""}`;
}

/** True when the machine has any stored row, present or gone. Classifying every row only to count them stalled the hub for seconds on each read. */
function hasRows(db: Db, table: "listeners" | "services", machineId: string): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE machine_id = ? LIMIT 1`).get(machineId) !== undefined;
}

async function runListeners(db: Db, machine: LiveMachine, options: StoreOptions): Promise<ListenerResult[]> {
  const results: ListenerResult[] = [];
  for (const adapter of LISTENER_ADAPTERS) {
    if (!adapter.os.includes(machine.os)) continue;
    const outputs: Record<string, ProbeOutput> = {};
    for (const probe of adapter.probes({ machineId: machine.id, os: machine.os, roots: {} })) {
      outputs[probe.id] = await probeOutput(options.run, machine.transport, probe, options.cheapTimeoutMs);
    }
    const result = adapter.parse(outputs);
    options.log?.(listenerLine(result));
    results.push(result);
  }
  if (!hasRows(db, "listeners", machine.id)) {
    // One initial write keeps both reader families under the machine's first-scan event suppression.
    const readable = results.filter((result) => result.status === "ok" || result.status === "partial");
    recordListeners(db, machine.id, { origin: "listeners", status: "partial", facts: readable.flatMap((result) => result.facts) }, options.now);
  } else {
    for (const result of results) recordListeners(db, machine.id, result, options.now);
  }
  return results;
}

async function runServices(db: Db, machine: LiveMachine, options: StoreOptions): Promise<ServiceResult[]> {
  const results: ServiceResult[] = [];
  for (const adapter of SERVICE_ADAPTERS) {
    if (!adapter.os.includes(machine.os)) continue;
    if (adapter.origin === TASK_ORIGIN && !options.slow) continue;
    const task = adapter.origin === TASK_ORIGIN;
    const update = (phase: LiveProbeUpdate["phase"], message: string | null): void => {
      options.onProbe?.({ probe: TASK_ORIGIN, label: TASK_LABEL, phase, message });
    };
    if (task) update("start", null);
    const outputs: Record<string, ProbeOutput> = {};
    try {
      for (const probe of adapter.probes({ machineId: machine.id, os: machine.os, roots: {} })) {
        const timeout = task ? TASK_TIMEOUT_MS : options.cheapTimeoutMs;
        outputs[probe.id] = await probeOutput(options.run, machine.transport, probe, timeout);
      }
    } catch (err) {
      if (task) update("failed", err instanceof Error ? err.message : "scheduled task probe failed");
      throw err;
    }
    const result = adapter.parse(outputs);
    if (task) update(result.status === "failed" ? "failed" : "done", result.status === "failed" ? result.message ?? null : null);
    options.log?.(serviceLine(result));
    results.push(result);
  }
  if (!hasRows(db, "services", machine.id)) {
    // One initial write keeps every reader family under the machine's first-scan event suppression.
    const readable = results.filter((result) => result.status === "ok" || result.status === "partial");
    recordServices(db, machine.id, { origin: "services", status: "partial", facts: readable.flatMap((result) => result.facts) }, options.now);
  } else {
    for (const result of results) recordServices(db, machine.id, result, options.now);
  }
  return results;
}

function storedOptions(options: CollectOptions, slow: boolean): StoreOptions {
  return {
    ...(options.log ? { log: options.log } : {}),
    run: options.run ?? runProbe,
    now: options.now?.() ?? new Date().toISOString(),
    ...(options.cheapTimeoutMs !== undefined ? { cheapTimeoutMs: options.cheapTimeoutMs } : {}),
    ...(options.onProbe ? { onProbe: options.onProbe } : {}),
    slow,
  };
}

/** The scan's listener pass. The first read of a machine writes every family once and emits no events. */
export function collectListeners(db: Db, machine: LiveMachine, options: CollectOptions = {}): Promise<void> {
  return runListeners(db, machine, storedOptions(options, false)).then((results) => {
    if (results.some((result) => result.status === "ok" || result.status === "partial")) scanAlerts(db, machine.id, options);
  });
}

/** The scan's service pass, including the scheduled-task probe and its 10 minute limit. */
export function collectServices(db: Db, machine: LiveMachine, options: CollectOptions = {}): Promise<void> {
  return runServices(db, machine, storedOptions(options, true)).then((results) => {
    if (results.some((result) => result.status === "ok" || result.status === "partial")) scanAlerts(db, machine.id, options);
  });
}

const scanMutes = alertsFileReader(".scout-data/alerts.json");
const readSubscribers = new WeakMap<Db, Set<(machineId: string, at: string) => void>>();

export function subscribeServiceReads(db: Db, listener: (machineId: string, at: string) => void): () => void {
  let subscribers = readSubscribers.get(db);
  if (!subscribers) { subscribers = new Set(); readSubscribers.set(db, subscribers); }
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function notifyServiceRead(db: Db, machineId: string, at: string): boolean {
  const subscribers = readSubscribers.get(db);
  for (const subscriber of subscribers ?? []) {
    try { subscriber(machineId, at); } catch { /* A read subscriber must not interrupt catalog storage. */ }
  }
  return (subscribers?.size ?? 0) > 0;
}

function scanAlerts(db: Db, machineId: string, options: CollectOptions): void {
  const at = options.now?.() ?? new Date().toISOString();
  if (notifyServiceRead(db, machineId, at)) return;
  try {
    const changes = (options.alerts?.evaluate ?? evaluateAlerts)(db, at, { loadMutes: scanMutes, tunnelHosts: loadTunnelHosts(".scout-data/tunnel-hosts.json"), ...options.alerts, machineId });
    options.alerts?.onChanges?.(changes);
  } catch {
    (options.log ?? console.error)("Alert evaluation failed; the next scan will retry.");
  }
}

function fingerprint(db: Db, machineId: string): { services: string; listeners: string } {
  const services = db.prepare(
    `SELECT id, kind, domain, name, display_name, program, state, start_mode, enabled, pid, run_as, triggers, last_run, last_result, first_seen_at, gone_at
     FROM services WHERE machine_id = ? ORDER BY id`,
  ).all(machineId);
  const listeners = db.prepare(
    `SELECT id, port, protocol, address, bind, pid, process_name, process_path, script_path, container_name, container_image, first_seen_at, gone_at
     FROM listeners WHERE machine_id = ? ORDER BY id`,
  ).all(machineId);
  return { services: JSON.stringify(services), listeners: JSON.stringify(listeners) };
}

function combine(results: { status: string; message?: string }[]): { status: LiveReadResult["status"]; error: string | null } {
  const ran = results.filter((result) => result.status !== "skipped");
  if (ran.length === 0) return { status: "ok", error: null };
  const problems = ran.filter((result) => result.status === "failed" || result.status === "partial");
  const error = problems.map((result) => result.message).filter((message): message is string => Boolean(message)).join("; ") || null;
  if (ran.every((result) => result.status === "failed")) return { status: "failed", error: error ?? "probe failed" };
  if (problems.length > 0) return { status: "partial", error };
  return { status: "ok", error: null };
}

function diff(before: { services: string; listeners: string }, after: { services: string; listeners: string }): Pick<LiveReadResult, "changed" | "tables"> {
  const tables: LiveReadResult["tables"] = [];
  if (before.services !== after.services) tables.push("services");
  if (before.listeners !== after.listeners) tables.push("listeners");
  return { changed: tables.length > 0, tables };
}

/** Listeners and cheap service state. `slow` adds the scheduled-task probe. `changed` ignores `last_seen_at`. */
export async function readLive(db: Db, machine: LiveMachine, options: CollectOptions & { slow?: boolean } = {}): Promise<LiveReadResult> {
  const before = fingerprint(db, machine.id);
  const stored = storedOptions({ ...options, cheapTimeoutMs: options.cheapTimeoutMs ?? 30_000 }, options.slow === true);
  const results: { status: string; message?: string }[] = [];
  try {
    results.push(...await runListeners(db, machine, stored));
    results.push(...await runServices(db, machine, stored));
  } catch (err) {
    const result: LiveReadResult = { ...diff(before, fingerprint(db, machine.id)), status: "failed", error: err instanceof Error ? err.message : "live read failed" };
    if (result.changed) notifyServiceRead(db, machine.id, stored.now);
    return result;
  }
  const result = { ...diff(before, fingerprint(db, machine.id)), ...combine(results) };
  if (result.changed || result.status !== "failed") notifyServiceRead(db, machine.id, stored.now);
  return result;
}
