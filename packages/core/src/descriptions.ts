import type { Db } from "./db.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DESCRIPTION_SOURCES = ["hand", "project", "install", "public", "os"] as const;
export type DescriptionSource = typeof DESCRIPTION_SOURCES[number];

export interface Description {
  text: string;
  source: DescriptionSource;
  generated: boolean;
  confidence: number | null;
  at: string | null;
  subject: string;
  hasHandEdit: boolean;
  evidence: string[];
}

export interface DescriptionRow {
  machineId: string;
  kind?: string;
  name?: string;
  displayName?: string | null;
  program?: string | null;
  processName?: string | null;
  processPath?: string | null;
  pid?: number | null;
  port?: number;
  ports?: { port: number }[];
}

export interface ProjectHint {
  machine: string;
  match: string;
  root: string;
}

export function loadProjectHints(path = fileURLToPath(new URL("../../../.scout-data/project-hints.json", import.meta.url))): ProjectHint[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !("hints" in value) || !Array.isArray(value.hints)) return [];
    return value.hints.filter((hint): hint is ProjectHint => hint !== null && typeof hint === "object" && typeof hint.machine === "string" && typeof hint.match === "string" && typeof hint.root === "string");
  } catch { return []; }
}

interface Stored {
  subject: string;
  text: string;
  source: "hand" | "project" | "public";
  generated: number;
  confidence: number | null;
  evidence: string;
  at: string;
}

interface Installed {
  machineId: string;
  location: string;
  text: string | null;
  source: string | null;
  confidence: number | null;
  at: string | null;
}

function pathKey(path: string, windows: boolean): string {
  const slashes = path.replace(/\\/g, "/");
  const normalized = slashes === "/" ? slashes : slashes.replace(/\/+$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}

// An install location that holds many programs (a package manager records `/` for a system package) must not describe them all.
const BROAD_ROOTS = new Set(["/", "/usr", "/usr/local", "/usr/bin", "/usr/sbin", "/usr/libexec", "/opt", "/opt/homebrew", "/applications", "/library", "/system", "/users", "/home", "c:", "c:/program files", "c:/program files (x86)", "c:/windows", "c:/windows/system32", "c:/users", "c:/programdata"]);

export function broadLocation(key: string): boolean {
  return key === "" || BROAD_ROOTS.has(key.toLowerCase());
}

function contains(root: string, path: string): boolean {
  return root !== "" && (path === root || path.startsWith(root === "/" ? root : `${root}/`));
}

export function validateHandDescription(text: unknown): string | null {
  if (text === null || text === "") return null;
  if (typeof text !== "string") return "text must be a string or null";
  if (text.length < 8 || text.length > 400) return "text length outside 8 to 400";
  if (/[\x00-\x1F\x7F-\x9F\u2028\u2029]/.test(text)) return "text has a line break or control character";
  return null;
}

export function setHandDescription(db: Db, subject: string, text: string | null): void {
  const problem = validateHandDescription(text);
  if (problem) throw new Error(problem);
  if (text === null || text === "") {
    db.prepare("DELETE FROM descriptions WHERE subject = ? AND source = 'hand'").run(subject);
    return;
  }
  db.prepare(
    `INSERT INTO descriptions (subject, text, source, generated, confidence, evidence_json, model_label, at)
     VALUES (?, ?, 'hand', 0, NULL, '[]', NULL, ?)
     ON CONFLICT(subject, source) DO UPDATE SET text = excluded.text, at = excluded.at`,
  ).run(subject, text, new Date().toISOString());
}

export interface DescriptionResolver {
  subject(row: DescriptionRow): string;
  describe(row: DescriptionRow): Description | null;
  hasPublic(subject: string): boolean;
}

export function loadDescriptionResolver(db: Db, options: { hints?: readonly ProjectHint[] } = {}): DescriptionResolver {
  const hints = options.hints ?? loadProjectHints();
  const machines = db.prepare("SELECT id, os FROM machines").all() as { id: string; os: string }[];
  const windows = new Set(machines.filter((row) => row.os === "windows").map((row) => row.id));
  const services = db.prepare(
    `SELECT machine_id AS machineId, kind, name, display_name AS displayName, program, pid
     FROM services WHERE gone_at IS NULL ORDER BY id`,
  ).all() as unknown as DescriptionRow[];
  const byMachine = new Map<string, DescriptionRow[]>();
  for (const service of services) {
    const rows = byMachine.get(service.machineId) ?? [];
    rows.push(service);
    byMachine.set(service.machineId, rows);
  }
  const stored = new Map<string, Map<Stored["source"], Stored>>();
  const projects = new Map<string, { root: string; row: Stored }[]>();
  for (const row of db.prepare("SELECT subject, text, source, generated, confidence, evidence_json AS evidence, at FROM descriptions").all() as unknown as Stored[]) {
    const sources = stored.get(row.subject) ?? new Map<Stored["source"], Stored>();
    sources.set(row.source, row);
    stored.set(row.subject, sources);
    if (row.source === "project") {
      for (const { id: machine } of machines) {
        const prefix = `project:${machine}:`;
        if (!row.subject.startsWith(prefix)) continue;
        const rows = projects.get(machine) ?? [];
        const root = pathKey(row.subject.slice(prefix.length), windows.has(machine));
        if (broadLocation(root)) continue;
        rows.push({ root, row });
        projects.set(machine, rows);
      }
    }
  }
  const installs = new Map<string, Installed[]>();
  for (const row of db.prepare(
    `SELECT i.machine_id AS machineId, i.location, p.description AS text, p.description_source AS source,
       p.description_confidence AS confidence, p.description_at AS at
     FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.removed_at IS NULL ORDER BY i.id`,
  ).all() as unknown as Installed[]) {
    const location = pathKey(row.location, windows.has(row.machineId));
    if (broadLocation(location)) continue;
    const rows = installs.get(row.machineId) ?? [];
    rows.push({ ...row, location });
    installs.set(row.machineId, rows);
  }
  for (const rows of installs.values()) rows.sort((a, b) => b.location.length - a.location.length);
  for (const rows of projects.values()) rows.sort((a, b) => b.root.length - a.root.length);
  const joined = (row: DescriptionRow): DescriptionRow => {
    if (row.kind !== undefined) return row;
    const mine = byMachine.get(row.machineId) ?? [];
    const path = row.processPath === null || row.processPath === undefined ? null : pathKey(row.processPath, windows.has(row.machineId));
    return mine.find((service) => row.pid !== null && row.pid !== undefined && service.pid === row.pid) ??
      mine.find((service) => service.pid === null && path !== null && service.program != null && pathKey(service.program, windows.has(row.machineId)) === path) ?? row;
  };
  const subject = (row: DescriptionRow): string => {
    const service = joined(row);
    return service.kind !== undefined ? `service:${service.kind}:${service.name}` :
      `process:${row.machineId}:${(row.processPath ?? row.processName ?? "").replace(/\\/g, "/").toLowerCase()}`;
  };
  const describe = (row: DescriptionRow): Description | null => {
    const key = subject(row);
    const sources = stored.get(key);
    const base = { subject: key, hasHandEdit: sources?.has("hand") ?? false };
    const fromStored = (item: Stored): Description => {
      let evidence: string[] = [];
      if (item.source === "project") {
        try {
          const value: unknown = JSON.parse(item.evidence);
          if (Array.isArray(value) && value.every((quote) => typeof quote === "string")) evidence = value;
        } catch { /* A damaged quote list cannot supply evidence. */ }
      }
      return { ...base, text: item.text, source: item.source, generated: item.generated !== 0, confidence: item.confidence, at: item.at, evidence };
    };
    const hand = sources?.get("hand");
    if (hand) return fromStored(hand);
    const service = joined(row);
    const program = row.program ?? row.processPath ?? service.program;
    const path = program == null ? "" : pathKey(program, windows.has(row.machineId));
    const matches = [row.name, service.name, row.processName, row.port === undefined ? undefined : String(row.port), ...(row.ports ?? []).map((port) => String(port.port))].filter((value): value is string => value !== undefined && value !== null);
    const hint = hints.find((hint) => hint.machine === row.machineId && matches.some((match) => windows.has(row.machineId) ? match.toLowerCase() === hint.match.toLowerCase() : match === hint.match));
    const hinted = hint ? projects.get(row.machineId)?.find((item) => item.root === pathKey(hint.root, windows.has(row.machineId)))?.row : undefined;
    const project = sources?.get("project") ?? hinted ?? projects.get(row.machineId)?.find((item) => contains(item.root, path))?.row;
    if (project) return fromStored(project);
    const install = installs.get(row.machineId)?.find((item) => contains(item.location, path));
    if (install?.text && ["source", "sibling", "manual"].includes(install.source ?? "")) {
      return { ...base, text: install.text, source: "install", generated: false, confidence: null, at: install.at, evidence: [] };
    }
    const publicText = sources?.get("public");
    if (publicText) return fromStored(publicText);
    if (install?.text && install.source === "generated") {
      return { ...base, text: install.text, source: "public", generated: true, confidence: install.confidence, at: install.at, evidence: [] };
    }
    if (service.displayName?.trim() && service.displayName !== service.name) {
      return { ...base, text: service.displayName, source: "os", generated: false, confidence: null, at: null, evidence: [] };
    }
    return null;
  };
  return { subject, describe, hasPublic: (key) => stored.get(key)?.has("public") ?? false };
}

export function describeRow(db: Db, row: DescriptionRow): Description | null {
  return loadDescriptionResolver(db).describe(row);
}
