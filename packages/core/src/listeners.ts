import { hubMachineId } from "./hub.ts";
import type { Db } from "./db.ts";
import type { Probe, ProbeContext, ProbeOutputs, ScanStatus } from "./adapter.ts";
import { classifyListener, type Classification, type ServiceClass } from "./classify.ts";
import { loadDescriptionResolver, type Description, type DescriptionResolver } from "./descriptions.ts";
import { healthRow, type HealthRow } from "./health.ts";

export type ListenerBind = "loopback" | "all" | "lan";

export interface ListenerFact {
  port: number;
  protocol: "tcp";
  address: string;
  bind: ListenerBind;
  pid: number | null;
  processName: string | null;
  processPath: string | null;
  /** The script, module, or jar a runtime such as node or python was started with; never its other arguments. */
  scriptPath?: string | null;
  /** The process that started the owner, so a service can claim the listeners of the children it runs. */
  ppid?: number | null;
  /** What the platform says this is when the process name alone does not: a service's display name, or the service that started the process. */
  owner?: string | null;
  container: { name: string; image: string; containerPort: number } | null;
}

export interface ListenerResult {
  origin: string;
  status: ScanStatus;
  facts: ListenerFact[];
  message?: string;
}

export interface ListenerAdapter {
  origin: string;
  os: ReadonlyArray<"macos" | "windows" | "linux">;
  probes(ctx: ProbeContext): Probe[];
  parse(outputs: ProbeOutputs): ListenerResult;
}

export interface Listener {
  id: number;
  machineId: string;
  machineName: string;
  port: number;
  protocol: "tcp";
  address: string;
  bind: ListenerBind;
  pid: number | null;
  processName: string | null;
  processPath: string | null;
  scriptPath?: string | null;
  ppid?: number | null;
  owner?: string | null;
  /** The name to show: the process name, or what a runtime process is running. */
  label?: string | null;
  containerName: string | null;
  containerImage: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  goneAt: string | null;
  classification: Classification;
  description: Description | null;
  health: HealthRow | null;
}

const GENERIC_DIRS = new Set(["dist", "src", "build", "bin", "lib", "out", "cli", "server", "app", "scripts", ".bin", "esm", "cjs", "cmd", "dev"]);
const ROOT_DIRS = new Set(["repositories", "repos", "projects", "code", "dev", "users", "home", "programdata", "program files", "opt", "usr", "var"]);
const GENERIC_FILES = new Set(["main", "index", "server", "app", "cli", "start", "run", "serve"]);

/** A row name that says what a runtime is running: `node: ark-overseer/index.js` instead of `node`. */
export function launchLabel(processName: string | null, scriptPath: string | null | undefined, owner?: string | null): string | null {
  if (!scriptPath) return owner ? (processName && processName !== "Idle" && processName.toLowerCase() !== owner.toLowerCase() ? processName + ": " + owner : owner) : processName;
  const parts = scriptPath.replaceAll("\\", "/").split("/").filter((part) => part && part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part));
  const file = parts.pop();
  if (!file) return processName;
  const modules = parts.lastIndexOf("node_modules");
  let what: string;
  if (modules >= 0 && parts[modules + 1]) {
    const pkg = parts[modules + 1]!;
    what = pkg.startsWith("@") && parts[modules + 2] ? pkg + "/" + parts[modules + 2] : pkg;
  } else {
    while (parts.length > 1 && GENERIC_DIRS.has(parts.at(-1)!.toLowerCase())) parts.pop();
    while (parts.length > 1 && ROOT_DIRS.has(parts[0]!.toLowerCase())) parts.shift();
    const generic = GENERIC_FILES.has(file.replace(/\.[^.]+$/, "").toLowerCase());
    what = parts.length ? parts.slice(generic ? -2 : -1).join("/") + "/" + file : file;
  }
  return processName ? processName + ": " + what : what;
}

const width: Record<ListenerBind, number> = { loopback: 0, lan: 1, all: 2 };
const identity = (row: { port: number; protocol: string; processName: string | null; containerName: string | null }): string => JSON.stringify([row.port, row.protocol, row.containerName ?? "", row.processName ?? ""]);

/** Windows sometimes reports the owner of a loopback listener as process 0 (\"Idle\"). That reads as an unknown owner, so the port keeps the last real owner Scout saw on it instead of becoming a second row. */
function withKnownOwner(fact: ListenerFact, previous: Listener[]): ListenerFact {
  if (fact.container || (fact.pid !== 0 && fact.processName !== "Idle")) return fact;
  const known = previous
    .filter((row) => row.port === fact.port && row.protocol === fact.protocol && row.containerName === null && row.pid !== 0 && row.processName !== null && row.processName !== "Idle")
    .sort((x, y) => y.lastSeenAt.localeCompare(x.lastSeenAt))[0];
  return known ? { ...fact, pid: known.pid, processName: known.processName, processPath: known.processPath, scriptPath: known.scriptPath ?? null, ppid: known.ppid ?? fact.ppid ?? null, owner: known.owner ?? fact.owner ?? null } : fact;
}

export function recordListeners(db: Db, machineId: string, result: ListenerResult, now: string): { listeners: number; gone: number } {
  const summary = { listeners: 0, gone: 0 };
  if (result.status === "failed" || result.status === "skipped") return summary;
  db.exec("BEGIN");
  try {
    const previous = listListeners(db, { machine: machineId });
    const baselineKey = `listeners_observed:${machineId}`;
    const firstScan = previous.length === 0 && !db.prepare("SELECT 1 FROM meta WHERE key = ?").get(baselineKey);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(baselineKey, now);
    const old = new Map(previous.map((row) => [identity(row), row]));
    const facts = new Map<string, ListenerFact>();
    for (const read of result.facts) {
      const fact = withKnownOwner(read, previous);
      const key = identity({ ...fact, containerName: fact.container?.name ?? null });
      const existing = facts.get(key);
      if (!existing || width[fact.bind] > width[existing.bind]) facts.set(key, fact);
    }
    const put = db.prepare(
      `INSERT INTO listeners (machine_id, port, protocol, address, bind, pid, process_name, process_path, script_path, ppid, owner, container_name, container_image, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET address = excluded.address, bind = excluded.bind, pid = excluded.pid,
         process_path = excluded.process_path, script_path = excluded.script_path, ppid = excluded.ppid, owner = excluded.owner, container_image = excluded.container_image, last_seen_at = excluded.last_seen_at, gone_at = NULL`,
    );
    const event = db.prepare("INSERT INTO events (at, machine_id, kind, detail_json) VALUES (?, ?, ?, ?)");
    const emit = (kind: string, port: number, process: string | null, oldBind: ListenerBind | null, newBind: ListenerBind | null, container: string | null) => {
      if (!firstScan) event.run(now, machineId, kind, JSON.stringify({ machine: machineId, port, process, oldBind, newBind, ...(container !== null && container !== process ? { container } : {}) }));
    };
    // A reader that learns the owner of a socket it could only list before changes the row's identity. That is the same listener gaining a name, not a new one appearing and an old one going away.
    const renamed = new Set<number>();
    for (const [key, fact] of facts) {
      let before = old.get(key);
      if (!before && fact.processName) {
        const unnamed = previous.find((row) => row.goneAt === null && !renamed.has(row.id) && row.port === fact.port && row.protocol === fact.protocol && row.containerName === (fact.container?.name ?? null) && (row.processName === null || row.processName === "") && !facts.has(identity(row)));
        if (unnamed) {
          db.prepare("UPDATE listeners SET process_name = ? WHERE id = ?").run(fact.processName, unnamed.id);
          renamed.add(unnamed.id);
          before = unnamed;
        }
      }
      put.run(machineId, fact.port, fact.protocol, fact.address, fact.bind, fact.pid, fact.processName, fact.processPath, fact.scriptPath ?? null, fact.ppid ?? null, fact.owner ?? null, fact.container?.name ?? null, fact.container?.image ?? null, now, now);
      summary.listeners++;
      if (!before) emit("listener_new", fact.port, fact.processName ?? fact.container?.name ?? null, null, fact.bind, fact.container?.name ?? null);
      else if (before.bind !== fact.bind) emit("listener_changed", fact.port, fact.processName ?? fact.container?.name ?? null, before.bind, fact.bind, fact.container?.name ?? null);
    }
    if (result.status === "ok") {
      for (const row of previous) {
        // Each reader proves absence only for its own family; Docker and lsof run separately.
        const owned = result.origin === "docker-ports" ? row.containerName !== null : result.origin === "listeners" || row.containerName === null;
        if (!owned || row.goneAt !== null || renamed.has(row.id) || facts.has(identity(row))) continue;
        db.prepare("UPDATE listeners SET gone_at = ? WHERE id = ?").run(now, row.id);
        summary.gone++;
        emit("listener_gone", row.port, row.processName ?? row.containerName, row.bind, null, row.containerName);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}

export interface ListenerFilter {
  machine?: string;
  bind?: ListenerBind;
  state?: "present" | "gone";
  q?: string;
  port?: number;
  class?: ServiceClass;
  official?: boolean;
  includeHidden?: boolean;
}

export function listListeners(db: Db, filter: ListenerFilter = {}, descriptions: DescriptionResolver = loadDescriptionResolver(db)): Listener[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.machine !== undefined) { clauses.push("l.machine_id = ?"); params.push(filter.machine); }
  if (filter.bind !== undefined) { clauses.push("l.bind = ?"); params.push(filter.bind); }
  if (filter.state !== undefined) clauses.push(`l.gone_at IS ${filter.state === "present" ? "NULL" : "NOT NULL"}`);
  if (filter.port !== undefined) { clauses.push("l.port = ?"); params.push(filter.port); }
  const rows = db.prepare(
    `SELECT l.id, l.machine_id AS machineId, m.name AS machineName, l.port, l.protocol, l.address, l.bind, l.pid,
       l.process_name AS processName, l.process_path AS processPath, l.script_path AS scriptPath, l.ppid AS ppid, l.owner AS owner, l.container_name AS containerName, l.container_image AS containerImage,
       l.first_seen_at AS firstSeenAt, l.last_seen_at AS lastSeenAt, l.gone_at AS goneAt
     FROM listeners l JOIN machines m ON m.id = l.machine_id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY m.name, l.port, l.id`,
  ).all(...params) as unknown as Omit<Listener, "classification" | "description" | "health">[];
  const serviceRows = db.prepare(
    `SELECT machine_id AS machineId, kind, domain, name, display_name AS displayName, program, state, start_mode AS startMode, enabled,
       pid, run_as AS runAs, triggers, last_run AS lastRun, last_result AS lastResult
     FROM services WHERE machine_id IN (SELECT id FROM machines WHERE (? IS NULL OR id = ?)) AND gone_at IS NULL`,
  ).all(filter.machine ?? null, filter.machine ?? null) as unknown as import("./services.ts").ServiceFact[];
  return rows.map((row) => {
    const classification = classifyListener(row as Listener, serviceRows);
    return { ...row, label: launchLabel(row.processName, row.scriptPath, row.owner), classification, description: descriptions.describe(row), health: row.machineId === hubMachineId() && row.goneAt === null && !classification.hidden ? healthRow(db, `listener:${hubMachineId()}:${row.port}`) : null };
  }).filter((row) =>
    (filter.q === undefined || [row.processName, row.processPath, row.scriptPath, row.owner, row.containerName, row.description?.text].some((text) => text?.toLowerCase().includes(filter.q!.toLowerCase()))) &&
    (filter.class === undefined || row.classification.class === filter.class) &&
    (filter.official === undefined || row.classification.official === filter.official) &&
    (filter.includeHidden !== false || !row.classification.hidden)
  );
}
