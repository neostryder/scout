import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Db } from "./db.ts";
import type { Project } from "./project-files.ts";

// Provenance flags are read-time facts about where a program came from. None of them judges the program: each carries
// the evidence it rests on, and nothing here starts, stops, or removes anything.

export type FlagKind = "odd-location" | "no-publisher" | "unsigned" | "mine";
export interface Flag { kind: FlagKind; label: string; evidence: string }

/** Who counts as "me": GitHub owners and commit author emails, from `.scout-data/mine.json`. */
export interface MineProfile { owners: string[]; emails: string[] }
export interface ProjectGit {
  machineId: string;
  root: string;
  remoteUrl: string | null;
  remoteHost: string | null;
  remoteOwner: string | null;
  remoteRepo: string | null;
  authorEmail: string | null;
  lastCommitAt: string | null;
  readAt: string;
}
export interface ProvenanceContext {
  profile: MineProfile;
  projects: (ProjectGit & { mine: string | null })[];
  /** Ports that an approved or proposed launch recipe claims, keyed `machine:port`, valued by the project root. */
  recipePorts: Map<string, string>;
}

const EMPTY_PROFILE: MineProfile = { owners: [], emails: [] };
export const emptyProvenance = (): ProvenanceContext => ({ profile: EMPTY_PROFILE, projects: [], recipePorts: new Map() });

const norm = (path: string): string => path.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

const FLAG_LABELS: Record<FlagKind, string> = { "odd-location": "Odd location", "no-publisher": "No publisher", unsigned: "Not signed", mine: "Mine" };
const flag = (kind: FlagKind, evidence: string): Flag => ({ kind, label: FLAG_LABELS[kind], evidence });

/** The part of a path that makes it an unusual place to run a program from, or null. */
export function oddLocation(path: string | null | undefined): string | null {
  if (!path) return null;
  const value = norm(path);
  if (/^\/(?:private\/)?var\/(?:tmp|folders)\//.test(value) || /^\/(?:private\/)?tmp\//.test(value) || value.startsWith("/dev/shm/")) return "a temporary folder";
  const folder = /(?:^|\/)(temp|tmp|downloads?|desktop)(?:\/|$)/.exec(value);
  if (folder) return `the ${folder[1]} folder`;
  if (/(?:^|\/)users\/public(?:\/|$)/.test(value)) return "the shared Public folder";
  if (value.includes("/$recycle.bin")) return "the Recycle Bin";
  return null;
}

/** Why a stored project counts as the user's own, or null. */
export function mineReason(git: Pick<ProjectGit, "remoteOwner" | "remoteHost" | "remoteRepo" | "authorEmail">, profile: MineProfile): string | null {
  const owners = profile.owners.map((owner) => owner.toLowerCase());
  if (git.remoteOwner !== null && owners.includes(git.remoteOwner.toLowerCase())) return `its git remote is ${git.remoteHost ?? "a host"}/${git.remoteOwner}/${git.remoteRepo ?? ""}`;
  const emails = profile.emails.map((email) => email.toLowerCase());
  if (git.authorEmail !== null && emails.includes(git.authorEmail.toLowerCase())) return "its last commit has one of your author emails";
  return null;
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

function mineByPath(machineId: string, path: string | null | undefined, context: ProvenanceContext): Flag | null {
  if (!path) return null;
  const value = norm(path);
  const project = context.projects.filter((row) => row.mine !== null && row.machineId === machineId && under(value, norm(row.root))).sort((a, b) => b.root.length - a.root.length)[0];
  return project ? flag("mine", `Inside ${basename(project.root)}, a project of yours: ${project.mine}.`) : null;
}

export interface InstallFlagInput {
  machineId: string;
  ecosystem: string;
  location: string | null;
  publisher: string | null;
  homepage: string | null;
  details?: Record<string, unknown> | null;
}

// Get-AppxPackage reports SignatureKind as a number: 0 None, 1 Developer, 2 Enterprise, 3 Store, 4 System.
const SIGNATURE: Record<string, string> = { "0": "none", "1": "developer", "2": "enterprise", "3": "store", "4": "system" };

export function installFlags(input: InstallFlagInput, context: ProvenanceContext): Flag[] {
  const flags: Flag[] = [];
  // A macOS receipt records the prefix the package was built under (often /private/tmp), not where anything runs.
  const odd = input.ecosystem === "pkgutil" ? null : oddLocation(input.location);
  if (odd) flags.push(flag("odd-location", `Installed in ${odd}.`));
  const details = input.details ?? {};
  if (input.ecosystem === "arp" && input.publisher === null && details.systemComponent !== true) flags.push(flag("no-publisher", "The Windows uninstall entry names no publisher."));
  if (input.ecosystem === "appx") {
    const raw = details.signatureKind;
    const kind = typeof raw === "number" || typeof raw === "string" ? SIGNATURE[String(raw)] ?? String(raw).toLowerCase() : null;
    // Developer-signed packages are how most third-party apps ship outside the Store, so only a missing signature is flagged.
    if (kind === "none") flags.push(flag("unsigned", "The package carries no signature."));
  }
  const byPath = mineByPath(input.machineId, input.location, context);
  if (byPath) flags.push(byPath);
  else if (input.homepage) {
    const home = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\//i.exec(input.homepage);
    const owner = home?.[1]?.toLowerCase();
    if (owner && context.profile.owners.some((candidate) => candidate.toLowerCase() === owner)) flags.push(flag("mine", `Its homepage is under github.com/${home![1]}.`));
  }
  return flags;
}

/** Flags for a running program: a service's executable, or a listener's process. */
export function programFlags(machineId: string, path: string | null | undefined, port: number | null, context: ProvenanceContext): Flag[] {
  const flags: Flag[] = [];
  const odd = oddLocation(path);
  if (odd) flags.push(flag("odd-location", `Runs from ${odd}.`));
  const byPath = mineByPath(machineId, path, context);
  if (byPath) flags.push(byPath);
  else if (port !== null) {
    const root = context.recipePorts.get(`${machineId}:${port}`);
    const project = root === undefined ? undefined : context.projects.find((row) => row.mine !== null && row.machineId === machineId && norm(row.root) === norm(root));
    if (project) flags.push(flag("mine", `Port ${port} belongs to a launch recipe of ${basename(project.root)}, a project of yours: ${project.mine}.`));
  }
  return flags;
}

// ---- the profile file ----

export interface MineFile { profile: MineProfile; fileError: string | null }

export function mineFileReader(path: string): () => MineFile {
  let stamp: string | null = null;
  let cached: MineFile = { profile: EMPTY_PROFILE, fileError: null };
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      observed = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === observed) return cached;
      stamp = observed;
      const data = JSON.parse(readFileSync(path, "utf8")) as Partial<MineProfile> | null;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid");
      const list = (value: unknown): string[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200)) throw new Error("invalid");
        return value as string[];
      };
      cached = { profile: { owners: list(data.owners), emails: list(data.emails) }, fileError: null };
    } catch (error) {
      stamp = observed;
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      cached = { profile: EMPTY_PROFILE, fileError: missing ? null : "The mine file is malformed, so no project is marked as yours." };
    }
    return cached;
  };
}

// ---- git facts ----

/** A remote URL reduced to host, owner and repository. Credentials and query text are dropped and never stored. */
export function parseRemote(raw: string): { url: string; host: string; owner: string; repo: string } | null {
  const text = raw.trim();
  // A Windows drive path looks like host:path to the scp form, so it is refused first.
  if (/^[a-z]:[\\/]/i.test(text)) return null;
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/\/)([^\s]+)$/.exec(text);
  let host: string | undefined;
  let path: string | undefined;
  if (scp) { host = scp[1]; path = scp[2]; }
  else {
    try {
      const url = new URL(text);
      if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return null;
      host = url.hostname;
      path = url.pathname;
    } catch { return null; }
  }
  if (!host || !path) return null;
  const parts = path.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "").split("/");
  if (parts.length < 2 || parts.some((part) => part === "")) return null;
  const owner = parts.slice(0, -1).join("/");
  const repo = parts[parts.length - 1]!;
  return { url: `https://${host.toLowerCase()}/${owner}/${repo}`, host: host.toLowerCase(), owner, repo };
}

export type GitRunner = (root: string, args: string[]) => Promise<string | null>;

export const runGit: GitRunner = (root, args) => new Promise((resolve) => {
  execFile("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], { windowsHide: true, timeout: 8000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
});

export async function readProjectGit(project: Project, git: GitRunner = runGit, at = new Date().toISOString()): Promise<ProjectGit> {
  const remote = parseRemote((await git(project.root, ["config", "--get", "remote.origin.url"]) ?? "").split(/\r?\n/)[0] ?? "");
  const log = ((await git(project.root, ["log", "-1", "--format=%ae%n%aI"]) ?? "").split(/\r?\n/));
  const email = log[0]?.trim() || null;
  const when = log[1]?.trim() || null;
  return { machineId: project.machineId, root: project.root, remoteUrl: remote?.url ?? null, remoteHost: remote?.host ?? null, remoteOwner: remote?.owner ?? null, remoteRepo: remote?.repo ?? null, authorEmail: email, lastCommitAt: when, readAt: at };
}

/** Re-reads the git facts of every project and drops the rows of projects that are no longer found. */
export async function refreshProjectGit(db: Db, projects: readonly Project[], git: GitRunner = runGit, at = new Date().toISOString()): Promise<{ read: number; withRemote: number }> {
  const rows: ProjectGit[] = [];
  for (const project of projects) rows.push(await readProjectGit(project, git, at));
  const upsert = db.prepare(`INSERT INTO project_git (machine_id, root, remote_url, remote_host, remote_owner, remote_repo, author_email, last_commit_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (machine_id, root) DO UPDATE SET remote_url = excluded.remote_url, remote_host = excluded.remote_host, remote_owner = excluded.remote_owner,
      remote_repo = excluded.remote_repo, author_email = excluded.author_email, last_commit_at = excluded.last_commit_at, read_at = excluded.read_at`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) upsert.run(row.machineId, row.root, row.remoteUrl, row.remoteHost, row.remoteOwner, row.remoteRepo, row.authorEmail, row.lastCommitAt, row.readAt);
    const keep = new Set(rows.map((row) => `${row.machineId}\u0000${row.root}`));
    for (const stored of db.prepare("SELECT machine_id AS machineId, root FROM project_git").all() as { machineId: string; root: string }[]) {
      if (!keep.has(`${stored.machineId}\u0000${stored.root}`) && projects.some((project) => project.machineId === stored.machineId)) db.prepare("DELETE FROM project_git WHERE machine_id = ? AND root = ?").run(stored.machineId, stored.root);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { read: rows.length, withRemote: rows.filter((row) => row.remoteUrl !== null).length };
}

export function provenanceContext(db: Db, profile: MineProfile = EMPTY_PROFILE): ProvenanceContext {
  const rows = db.prepare(`SELECT machine_id AS machineId, root, remote_url AS remoteUrl, remote_host AS remoteHost, remote_owner AS remoteOwner, remote_repo AS remoteRepo,
    author_email AS authorEmail, last_commit_at AS lastCommitAt, read_at AS readAt FROM project_git ORDER BY machine_id, root`).all() as unknown as ProjectGit[];
  const projects = rows.map((row) => ({ ...row, mine: mineReason(row, profile) }));
  const recipePorts = new Map<string, string>();
  for (const row of db.prepare("SELECT machine_id AS machineId, port, root FROM launch_recipes WHERE port IS NOT NULL AND gone_at IS NULL AND state IN ('approved', 'proposed')").all() as { machineId: string; port: number; root: string }[]) recipePorts.set(`${row.machineId}:${row.port}`, row.root);
  return { profile, projects, recipePorts };
}

/** What the Provenance view and the CLI show: the profile in use, every project's git facts, and how many flags of each kind exist. */
export function provenanceResponse(db: Db, file: MineFile, at = new Date().toISOString()) {
  const context = provenanceContext(db, file.profile);
  return {
    profile: { owners: file.profile.owners, emails: file.profile.emails, file: ".scout-data/mine.json", fileError: file.fileError },
    projects: context.projects.map((row) => ({ machineId: row.machineId, project: basename(row.root), root: row.root, remote: row.remoteUrl, lastCommitAt: row.lastCommitAt, authorEmail: row.authorEmail, mine: row.mine, readAt: row.readAt })),
    generatedAt: at,
  };
}

export interface FlaggedInstall { installId: number; machineId: string; name: string; ecosystem: string; location: string; flags: Flag[] }

/** Every live install that carries at least one flag, optionally narrowed to one machine or one kind of flag. */
export function flaggedInstalls(db: Db, context: ProvenanceContext, options: { machine?: string; kind?: FlagKind } = {}): FlaggedInstall[] {
  const rows = db.prepare(`SELECT i.id AS installId, i.machine_id AS machineId, p.ecosystem, p.name, i.location, p.publisher, p.homepage, i.details_json AS details
    FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.removed_at IS NULL AND (? IS NULL OR i.machine_id = ?) ORDER BY i.machine_id, p.name COLLATE NOCASE, i.id`)
    .all(options.machine ?? null, options.machine ?? null) as { installId: number; machineId: string; ecosystem: string; name: string; location: string; publisher: string | null; homepage: string | null; details: string }[];
  const found: FlaggedInstall[] = [];
  for (const { details, ...row } of rows) {
    let parsed: Record<string, unknown> | null = null;
    try { const value: unknown = JSON.parse(details); if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* A malformed details column simply yields no detail-based flag. */ }
    const flags = installFlags({ ...row, details: parsed }, context).filter((item) => options.kind === undefined || item.kind === options.kind);
    if (flags.length) found.push({ installId: row.installId, machineId: row.machineId, name: row.name, ecosystem: row.ecosystem, location: row.location, flags });
  }
  return found;
}
