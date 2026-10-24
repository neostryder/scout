import type { Db } from "./db.ts";
import type { Probe, ProbeContext, ProbeOutputs, ScanStatus } from "./adapter.ts";

/** Where an entry starts a program on its own: a service, a task, a logon entry, or an init job. */
export type WorkspaceInstallKind = "windows-service" | "scheduled-task" | "run-key" | "startup-folder" | "launchd" | "systemd" | "autostart";

export interface WorkspaceInstallFact {
  kind: WorkspaceInstallKind;
  name: string;
  /** The registry key, folder, or file that holds the entry. The user's name is replaced with USER. */
  location: string;
  /** The first path in the entry's command that sits inside the Repositories tree. */
  workspacePath: string;
}

export interface WorkspaceInstallResult {
  origin: string;
  status: ScanStatus;
  facts: WorkspaceInstallFact[];
  message?: string;
}

export interface WorkspaceAdapter {
  origin: string;
  os: ReadonlyArray<"macos" | "windows" | "linux">;
  probes(ctx: ProbeContext): Probe[];
  parse(outputs: ProbeOutputs): WorkspaceInstallResult;
}

export interface WorkspaceInstall extends WorkspaceInstallFact {
  id: number;
  machineId: string;
  machineName: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

const START = String.raw`(?:[A-Za-z]:|~|\$\{?\w+\}?|%[^%/]+%)?`;
const WORKSPACE_PATH = new RegExp(`(${START}/(?:[^/]+/)*?(?:Repositories|_worktrees)(?:/.*)?)$`, "i");
const SPLIT = /[\s"'<>|;,=()]+/;
const MAX_PATH = 260;

/** Replaces the user's name in a home path, so a stored path never carries it. */
export function redactUser(path: string): string {
  return path.replace(/((?:[A-Za-z]:)?\/(?:Users|home)\/)[^/]+/i, "$1USER");
}

/** The first path in `text` that sits inside the Repositories or _worktrees folder, or null. Slashes are normalized and the user's name is replaced. */
export function workspacePathIn(text: string): string | null {
  for (const token of text.replaceAll("\\", "/").split(SPLIT)) {
    if (token === "") continue;
    const match = WORKSPACE_PATH.exec(token);
    if (!match?.[1]) continue;
    const path = match[1].replace(/^\/([A-Za-z]:\/)/, "$1").replace(/\/+$/, "");
    return redactUser(path).slice(0, MAX_PATH);
  }
  return null;
}

export function recordWorkspaceInstalls(db: Db, machineId: string, result: WorkspaceInstallResult, now: string): { present: number; gone: number } {
  const summary = { present: 0, gone: 0 };
  if (result.status === "failed" || result.status === "skipped") return summary;
  const facts = new Map<string, WorkspaceInstallFact>();
  for (const fact of result.facts) facts.set(JSON.stringify([fact.kind, fact.location, fact.name]), fact);
  db.exec("BEGIN IMMEDIATE");
  try {
    const put = db.prepare(
      `INSERT INTO workspace_installs (machine_id, kind, name, location, workspace_path, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, kind, location, name) DO UPDATE SET workspace_path = excluded.workspace_path, last_seen_at = excluded.last_seen_at, gone_at = NULL`,
    );
    for (const fact of facts.values()) {
      put.run(machineId, fact.kind, fact.name, fact.location, fact.workspacePath, now, now);
      summary.present += 1;
    }
    // A partial read proves what it found, not what is missing.
    if (result.status === "ok") {
      const seen = new Set(facts.keys());
      const stored = db.prepare("SELECT id, kind, name, location FROM workspace_installs WHERE machine_id = ? AND gone_at IS NULL").all(machineId) as { id: number; kind: string; name: string; location: string }[];
      const retire = db.prepare("UPDATE workspace_installs SET gone_at = ? WHERE id = ?");
      for (const row of stored) {
        if (!owns(result.origin, row.kind) || seen.has(JSON.stringify([row.kind, row.location, row.name]))) continue;
        retire.run(now, row.id);
        summary.gone += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return summary;
}

/** A reader proves absence only for the kinds it reads. */
function owns(origin: string, kind: string): boolean {
  if (origin === "workspace-windows") return ["windows-service", "scheduled-task", "run-key", "startup-folder"].includes(kind);
  if (origin === "workspace-macos") return kind === "launchd";
  if (origin === "workspace-linux") return kind === "systemd" || kind === "autostart";
  return false;
}

export function listWorkspaceInstalls(db: Db, options: { machine?: string } = {}): WorkspaceInstall[] {
  const rows = db.prepare(
    `SELECT w.id, w.machine_id AS machineId, m.name AS machineName, w.kind, w.name, w.location, w.workspace_path AS workspacePath, w.first_seen_at AS firstSeenAt, w.last_seen_at AS lastSeenAt
     FROM workspace_installs w JOIN machines m ON m.id = w.machine_id
     WHERE w.gone_at IS NULL AND (? IS NULL OR w.machine_id = ?)
     ORDER BY m.name, w.kind, w.name`,
  ).all(options.machine ?? null, options.machine ?? null) as unknown as WorkspaceInstall[];
  return rows;
}
