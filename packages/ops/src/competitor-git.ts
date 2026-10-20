import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { compareVersions, competitorPaths, competitorRunRecord, failCompetitorRun, maxVersion, queueCompetitorRun, recordMirrorSync, redactUrlSecrets, type Db, type ResearchDelta } from "@scout/core";
import { analyzeChange, categoryForPath, MANIFEST_FILES, type ChangeAnalysis, type ChangeInput } from "./competitor-analysis.ts";

export interface GitResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type GitRunner = (args: string[], options?: { cwd?: string; timeoutMs?: number; maxBytes?: number }) => Promise<GitResult>;
export interface RemoteCheck { version: string | null; prerelease: string | null; commit: string | null; error: string | null }

const HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);
const PRE = /^(alpha|a|beta|b|pre|preview|rc|c|dev|snapshot|nightly|canary|insiders|next)$/i;
const SHA = /^[0-9a-f]{7,64}$/i;
const NOTES_FILE = /^(changelog|changes|release|history)/i;
const PRICE_WORDS = new Set(["pricing", "prices", "price", "plans", "plan", "licensing", "licences", "licenses", "licence", "license"]);
const OUTSIDE = "mirror path is outside the mirror root";
const NOT_FF = "the mirror has local commits; fetched only";
// An inherited GIT_DIR would make fetch and merge write outside the mirror's own .git.
const DROPPED_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"];

export function spawnGit(args: string[], options: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of DROPPED_ENV) delete env[key];
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: options.cwd, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const take = (current: string, chunk: Buffer): string => current.length >= maxBytes ? current : (current + chunk.toString("utf8")).slice(0, maxBytes);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = take(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = take(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref();
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.once("error", (error) => { stderr = stderr || error.message; finish(null); });
    child.once("close", (code) => finish(code));
  });
}

export function supportedRemote(remote: string): boolean {
  const cleaned = remote.trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/\s]+@/i, "$1");
  if (/^https:\/\//i.test(cleaned) || /^ssh:\/\//i.test(cleaned)) {
    try { return HOSTS.has(new URL(cleaned).hostname.toLowerCase()); } catch { return false; }
  }
  const scp = /^[^@\s]+@([^:\s]+):([^:\s]+)$/.exec(cleaned);
  return Boolean(scp?.[1]?.includes(".") && HOSTS.has(scp[1].toLowerCase()));
}

// A moving alias such as "latest" or "14-latest" names a channel, not a release.
const ALIAS_TAG = /(^|[^a-z])(latest|stable|current|head|main|master)([^a-z]|$)/i;

export function versionFromTag(tag: string): string | null {
  const stripped = tag.trim().replace(/^v(?=\d)/i, "");
  if (!/^\d/.test(stripped) || ALIAS_TAG.test(stripped) || compareVersions(stripped, "0") === null) return null;
  return stripped;
}

export function tagIsPrerelease(version: string): boolean {
  return (version.match(/[A-Za-z]+/g) ?? []).some((word) => PRE.test(word));
}

export function selectLatestTags(tags: string[]): { version: string | null; prerelease: string | null } {
  const versions = tags.map(versionFromTag).filter((item): item is string => item !== null);
  const stable = versions.filter((version) => !tagIsPrerelease(version));
  const bestStable = maxVersion(stable);
  const bestAny = maxVersion(versions);
  const prerelease = bestAny && tagIsPrerelease(bestAny) && (!bestStable || compareVersions(bestAny, bestStable) === 1) ? bestAny : null;
  return { version: bestStable, prerelease };
}

export function parseTagNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^[0-9a-f]{7,}\s+refs\/tags\/(\S+)$/i.exec(line.trim());
    const name = match?.[1];
    if (name && !name.endsWith("^{}")) names.push(name);
  }
  return names;
}

export function parseHeadSha(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([0-9a-f]{7,})\s+HEAD$/i.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

function clip(result: GitResult, fallback: string): string {
  if (result.timedOut) return "timed out";
  // A failed fetch prints a progress listing first; the lines that explain the failure come after it.
  const failures = result.stderr.split(/\r?\n/).filter((line) => /^(fatal|error):|^ ! /.test(line));
  const text = redactUrlSecrets(failures.length ? failures.join(" ") : result.stderr || result.stdout || fallback).replace(/\s+/g, " ").trim();
  return text.slice(0, 300) || fallback;
}

export async function readRemoteRefs(remote: string, run: GitRunner = spawnGit): Promise<RemoteCheck> {
  const tags = await run(["ls-remote", "--tags", "--refs", remote], { timeoutMs: 30_000 });
  if (tags.timedOut || tags.code !== 0) return { version: null, prerelease: null, commit: null, error: clip(tags, "git ls-remote failed") };
  const head = await run(["ls-remote", remote, "HEAD"], { timeoutMs: 30_000 });
  if (head.timedOut || head.code !== 0) return { version: null, prerelease: null, commit: null, error: clip(head, "git ls-remote failed") };
  const picked = selectLatestTags(parseTagNames(tags.stdout));
  return { version: picked.version, prerelease: picked.prerelease, commit: parseHeadSha(head.stdout), error: null };
}

export async function checkRemote(remote: string, run: GitRunner = spawnGit): Promise<RemoteCheck> {
  if (!supportedRemote(remote)) return { version: null, prerelease: null, commit: null, error: "unsupported remote" };
  return readRemoteRefs(remote, run);
}

function resolveMirror(mirrorRoot: string, mirrorPath: string): { ok: true; cwd: string } | { ok: false; error: string } {
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(mirrorRoot);
    targetReal = realpathSync(mirrorPath);
  } catch {
    return { ok: false, error: OUTSIDE };
  }
  const rel = relative(rootReal, targetReal);
  if (!rel || rel === "." || rel.startsWith("..") || rel.split(/[/\\]/).length !== 1) return { ok: false, error: OUTSIDE };
  try {
    if (!statSync(targetReal).isDirectory()) return { ok: false, error: OUTSIDE };
  } catch {
    return { ok: false, error: OUTSIDE };
  }
  return { ok: true, cwd: targetReal };
}

async function git(run: GitRunner, args: string[], cwd: string, timeoutMs = 30_000, maxBytes = 1_048_576): Promise<GitResult> {
  return run(args, { cwd, timeoutMs, maxBytes });
}

function gitPath(cwd: string, printed: string): string {
  const trimmed = printed.trim();
  return isAbsolute(trimmed) ? trimmed : join(cwd, trimmed);
}

export async function pullMirror(mirrorPath: string, mirrorRoot: string, run: GitRunner = spawnGit, timeoutMs?: number): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const folder = resolveMirror(mirrorRoot, mirrorPath);
  if (!folder.ok) return folder;
  const cwd = folder.cwd;
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const limited = (args: string[], cap: number, maxBytes = 1_048_576): Promise<GitResult> => {
    const budget = deadline === null ? cap : Math.min(cap, deadline - Date.now());
    if (budget <= 0) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true });
    return git(run, args, cwd, budget, maxBytes);
  };
  const work = await limited(["rev-parse", "--is-inside-work-tree"], 30_000);
  if (work.code !== 0 || work.stdout.trim() !== "true") return { ok: false, error: "mirror is not a git work tree" };
  const remotes = await limited(["remote"], 30_000);
  if (remotes.code !== 0 || !remotes.stdout.split(/\r?\n/).some((line) => line.trim() === "origin")) return { ok: false, error: "mirror has no origin" };
  const status = await limited(["status", "--porcelain"], 30_000);
  if (status.code !== 0) return { ok: false, error: clip(status, "git status failed") };
  if (status.stdout.trim() !== "") return { ok: false, error: "mirror has uncommitted changes" };
  const merge = await limited(["rev-parse", "-q", "--verify", "MERGE_HEAD"], 30_000);
  if (merge.code === 0 && merge.stdout.trim()) return { ok: false, error: "mirror is in the middle of a merge or rebase" };
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const located = await limited(["rev-parse", "--git-path", name], 30_000);
    if (located.code === 0 && existsSync(gitPath(cwd, located.stdout))) return { ok: false, error: "mirror is in the middle of a merge or rebase" };
  }
  const fetched = await limited(["fetch", "--force", "--tags", "origin"], 120_000);
  if (fetched.timedOut || fetched.code !== 0) return { ok: false, error: clip(fetched, "git fetch failed") };
  const branch = (await limited(["rev-parse", "--abbrev-ref", "HEAD"], 30_000)).stdout.trim();
  const upstream = await limited(["rev-parse", "--abbrev-ref", "@{upstream}"], 30_000);
  let ref: string | null = null;
  if (upstream.code === 0 && upstream.stdout.trim()) ref = "@{upstream}";
  else {
    const originHead = await limited(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 30_000);
    const name = originHead.stdout.trim();
    const branchName = name.startsWith("origin/") ? name.slice("origin/".length) : name;
    if (originHead.code === 0 && branchName !== "" && branchName === branch) ref = name;
  }
  if (ref) {
    const behind = await limited(["rev-list", "--count", `HEAD..${ref}`], 30_000);
    const count = Number(behind.stdout.trim());
    if (behind.timedOut || behind.code !== 0 || !Number.isInteger(count)) return { ok: false, error: clip(behind, "git rev-list failed") };
    if (count > 0) {
      const merged = await limited(["merge", "--ff-only", ref], 60_000);
      if (merged.timedOut || merged.code !== 0) return { ok: false, error: NOT_FF };
    }
  }
  return { ok: true, cwd };
}

export async function syncCompetitorMirror(db: Db, id: string, options: { mirrorRoot: string; now: string; git?: GitRunner; timeoutMs?: number }): Promise<{ ok: true; cwd: string; head: string } | { ok: false; error: string }> {
  const run = options.git ?? spawnGit;
  const paths = competitorPaths(db, id);
  if (!paths) return { ok: false, error: "unknown competitor" };
  if (!paths.mirrorPath) {
    recordMirrorSync(db, id, { error: "competitor has no mirror" });
    return { ok: false, error: "competitor has no mirror" };
  }
  const pulled = await pullMirror(paths.mirrorPath, options.mirrorRoot, run, options.timeoutMs);
  if (!pulled.ok) {
    recordMirrorSync(db, id, { error: pulled.error });
    return pulled;
  }
  const head = await git(run, ["rev-parse", "HEAD"], pulled.cwd);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !SHA.test(sha)) {
    const error = clip(head, "git rev-parse failed");
    recordMirrorSync(db, id, { error });
    return { ok: false, error };
  }
  recordMirrorSync(db, id, { at: options.now, head: sha });
  return { ok: true, cwd: pulled.cwd, head: sha };
}

function baseName(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function parseNumstat(stdout: string): { path: string; added: number; deleted: number }[] {
  const files: { path: string; added: number; deleted: number }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const added = parts[0];
    const deleted = parts[1];
    if (added === undefined || deleted === undefined || added === "-" || deleted === "-") continue;
    const addedN = Number(added);
    const deletedN = Number(deleted);
    if (!Number.isInteger(addedN) || !Number.isInteger(deletedN)) continue;
    files.push({ path: parts.slice(2).join("\t").replaceAll("\\", "/"), added: addedN, deleted: deletedN });
    if (files.length >= 300) break;
  }
  return files;
}

function parseLog(stdout: string): { sha: string; date: string; subject: string }[] {
  const commits: { sha: string; date: string; subject: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const sha = parts[0] ?? "";
    if (!SHA.test(sha)) continue;
    commits.push({ sha, date: parts[1] ?? "", subject: parts.slice(2).join("\t") });
    if (commits.length >= 200) break;
  }
  return commits;
}

function describedVersion(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!line || line.startsWith("fatal:")) return null;
  return line.replace(/^v(?=\d)/i, "");
}

function pricingName(filePath: string): boolean {
  return baseName(filePath).toLowerCase().split(/[^a-z0-9]+/).some((word) => PRICE_WORDS.has(word));
}

export async function buildResearchRequest(input: {
  cwd: string;
  competitor: { id: string; name: string; org: string | null; packageUrl: string | null; remoteUrl: string | null; flags: string[] };
  from: { version: string | null; commit: string | null };
  mirrorPath: string;
  dossierDir: string | null;
  fallbackVersion: string | null;
}, run: GitRunner = spawnGit): Promise<Record<string, unknown>> {
  const head = await git(run, ["rev-parse", "HEAD"], input.cwd);
  const toCommit = head.stdout.trim();
  if (head.code !== 0 || !SHA.test(toCommit)) throw new Error(clip(head, "git rev-parse failed"));
  const described = await git(run, ["describe", "--tags", "--abbrev=0"], input.cwd);
  const toVersion = described.code === 0 ? describedVersion(described.stdout) ?? input.fallbackVersion : input.fallbackVersion;
  const competitor = { ...input.competitor, remoteUrl: input.competitor.remoteUrl === null ? null : redactUrlSecrets(input.competitor.remoteUrl) };
  const base = { competitor, from: input.from, to: { version: toVersion, commit: toCommit }, mirrorPath: input.mirrorPath, dossierDir: input.dossierDir };
  const remoteHost = hostOf(input.competitor.remoteUrl);
  if (input.from.commit === null) {
    const analysis = await gatherAnalysis(run, input.cwd, null, toCommit, remoteHost);
    return { ...base, commitCount: 0, commits: [], changedFiles: [], notes: "no earlier baseline", pricingFiles: [], analysis };
  }
  if (!SHA.test(input.from.commit)) throw new Error("baseline commit is not a sha");
  const range = `${input.from.commit}..${toCommit}`;
  const counted = await git(run, ["rev-list", "--count", range], input.cwd);
  const logged = await git(run, ["log", "-n", "200", "--format=%H%x09%cI%x09%s", range], input.cwd);
  const diff = await git(run, ["diff", "--numstat", range], input.cwd, 30_000, 1_048_576);
  if (counted.code !== 0 || logged.code !== 0 || diff.code !== 0) throw new Error("git diff failed");
  const changedFiles = parseNumstat(diff.stdout);
  const notePaths = changedFiles.filter((file) => NOTES_FILE.test(baseName(file.path))).map((file) => file.path);
  let notes = "";
  if (notePaths.length) {
    const text = await git(run, ["diff", "--text", input.from.commit, toCommit, "--", ...notePaths], input.cwd, 30_000, 80_000);
    notes = text.stdout;
  }
  for (const name of ["package.json", "module.json"]) {
    const shown = await git(run, ["show", `${toCommit}:${name}`], input.cwd, 30_000, 80_000);
    if (shown.code !== 0) continue;
    const lines = shown.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /"version"\s*:/.test(line) || /^version\s*[:=]/i.test(line));
    if (lines.length) notes += `${notes ? "\n" : ""}${name}: ${lines.join(" ")}`;
  }
  const commitCount = Number(counted.stdout.trim());
  const analysis = await gatherAnalysis(run, input.cwd, input.from.commit, toCommit, remoteHost);
  return {
    ...base,
    commitCount: Number.isInteger(commitCount) ? commitCount : parseLog(logged.stdout).length,
    commits: parseLog(logged.stdout),
    changedFiles,
    notes: notes.slice(0, 20_000),
    pricingFiles: changedFiles.filter((file) => pricingName(file.path)).map((file) => file.path),
    analysis,
  };
}

export async function runCompetitorUpdate(db: Db, runId: number, options: { mirrorRoot: string; now: string; git?: GitRunner }): Promise<void> {
  const run = options.git ?? spawnGit;
  const now = options.now;
  const record = competitorRunRecord(db, runId, now);
  if (!record || record.state !== "pulling") return;
  const paths = competitorPaths(db, record.competitorId);
  if (!paths?.mirrorPath) {
    failCompetitorRun(db, runId, "competitor has no mirror", now);
    return;
  }
  try {
    const pulled = await syncCompetitorMirror(db, record.competitorId, { mirrorRoot: options.mirrorRoot, now, git: run, timeoutMs: 120_000 });
    if (!pulled.ok) {
      failCompetitorRun(db, runId, pulled.error, now);
      return;
    }
    const request = await buildResearchRequest({
      cwd: pulled.cwd,
      competitor: { id: record.competitorId, name: paths.name, org: paths.org, packageUrl: paths.packageUrl, remoteUrl: paths.remoteUrl, flags: paths.flags },
      from: { version: record.fromVersion, commit: record.fromCommit },
      mirrorPath: paths.mirrorPath,
      dossierDir: paths.dossierDir,
      fallbackVersion: paths.latestVersion,
    }, run);
    const to = request["to"] as { version: string | null; commit: string | null };
    queueCompetitorRun(db, runId, { toVersion: to.version, toCommit: to.commit, request }, now);
  } catch (error) {
    const message = redactUrlSecrets(error instanceof Error ? error.message : "update failed").slice(0, 300);
    try { failCompetitorRun(db, runId, message, now); } catch { /* the run already left the active states */ }
  }
}

export async function researchForGate(db: Db, id: string, options: { mirrorRoot: string; now: string; git?: GitRunner }): Promise<{ request: Record<string, unknown>; delta: ResearchDelta; toVersion: string | null; toCommit: string | null } | { error: string }> {
  const run = options.git ?? spawnGit;
  const paths = competitorPaths(db, id);
  if (!paths?.mirrorPath) return { error: "competitor has no mirror" };
  const folder = resolveMirror(options.mirrorRoot, paths.mirrorPath);
  if (!folder.ok) return { error: folder.error };
  try {
    const request = await buildResearchRequest({
      cwd: folder.cwd,
      competitor: { id, name: paths.name, org: paths.org, packageUrl: paths.packageUrl, remoteUrl: paths.remoteUrl, flags: paths.flags },
      from: { version: paths.baselineVersion, commit: paths.baselineCommit },
      mirrorPath: paths.mirrorPath,
      dossierDir: paths.dossierDir,
      fallbackVersion: paths.latestVersion,
    }, run);
    const to = request["to"] as { version?: string | null; commit?: string | null } | undefined;
    const analysis = request["analysis"] as ChangeAnalysis | undefined;
    const commits = Array.isArray(request["commits"]) ? request["commits"] as { date?: string }[] : [];
    const newer = paths.baselineVersion && paths.latestVersion ? compareVersions(paths.latestVersion, paths.baselineVersion) === 1 : false;
    const delta: ResearchDelta = {
      commits: typeof request["commitCount"] === "number" ? request["commitCount"] : 0,
      sourceFilesChanged: analysis?.fileCategories.source ?? 0,
      newStableTag: Boolean(newer),
      docsOnly: analysis?.flags.docsOnly === true,
      dependencyBumpOnly: analysis?.flags.dependencyBumpOnly === true,
      lastCommitAt: typeof commits[0]?.date === "string" ? commits[0].date : null,
    };
    return { request, delta, toVersion: typeof to?.version === "string" ? to.version : null, toCommit: typeof to?.commit === "string" ? to.commit : null };
  } catch (error) {
    return { error: redactUrlSecrets(error instanceof Error ? error.message : "analysis failed").slice(0, 300) };
  }
}

async function gatherAnalysis(run: GitRunner, cwd: string, fromCommit: string | null, toCommit: string, remoteHost: string | null): Promise<ChangeAnalysis> {
  const shipsCode = await repoShipsCode(run, cwd);
  const manifests = await readManifests(run, cwd, fromCommit, toCommit);
  if (fromCommit === null) return analyzeChange({ baseline: "none", manifests, shipsCode, remoteHost });
  const range = `${fromCommit}..${toCommit}`;
  const logged = await git(run, ["log", "-n", "200", "--format=%H%x1f%cI%x1f%s%x1f%b%x1e", range], cwd, 30_000, 500_000);
  const numstat = await git(run, ["diff", "--numstat", range], cwd, 30_000, 1_048_576);
  const names = await git(run, ["diff", "--name-status", range], cwd, 30_000, 1_048_576);
  const diff = await git(run, ["diff", "--unified=3", fromCommit, toCommit], cwd, 30_000, 1_048_576);
  const oldFiles = await readOldFiles(run, cwd, fromCommit, names.stdout);
  const input: ChangeInput = {
    logText: logged.stdout,
    numstatText: numstat.stdout,
    nameStatusText: names.stdout,
    diffText: diff.stdout,
    manifests,
    oldFiles,
    remoteHost,
    shipsCode,
  };
  return analyzeChange(input);
}

async function repoShipsCode(run: GitRunner, cwd: string): Promise<boolean> {
  const listed = await git(run, ["ls-files"], cwd, 30_000, 1_048_576);
  if (listed.code !== 0) return false;
  return listed.stdout.split(/\r?\n/).some((line) => line.trim() !== "" && categoryForPath(line.trim()) === "source");
}

async function readManifests(run: GitRunner, cwd: string, fromCommit: string | null, toCommit: string): Promise<{ path: string; before: string | null; after: string | null }[]> {
  const files: { path: string; before: string | null; after: string | null }[] = [];
  for (const name of MANIFEST_FILES) {
    const before = fromCommit === null ? null : await showFile(run, cwd, fromCommit, name);
    const after = await showFile(run, cwd, toCommit, name);
    if (before === null && after === null) continue;
    files.push({ path: name, before, after });
  }
  return files;
}

async function showFile(run: GitRunner, cwd: string, rev: string, file: string): Promise<string | null> {
  const shown = await git(run, ["show", `${rev}:${file}`], cwd, 15_000, 200_000);
  return shown.code === 0 ? shown.stdout : null;
}

async function readOldFiles(run: GitRunner, cwd: string, fromCommit: string, nameStatus: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for (const line of nameStatus.split(/\r?\n/)) {
    if (!line.trim() || files.length >= 40) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    const path = status.startsWith("R") || status.startsWith("C") ? parts[2] : parts[1];
    const oldPath = status.startsWith("R") || status.startsWith("C") ? parts[1] : path;
    if (!path || !oldPath) continue;
    const text = await showFile(run, cwd, fromCommit, oldPath);
    if (text !== null) files.push({ path: path.replaceAll("\\", "/"), text });
  }
  return files;
}

function hostOf(remote: string | null): string | null {
  if (!remote) return null;
  const cleaned = redactUrlSecrets(remote).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
    try { return new URL(cleaned).hostname.toLowerCase(); } catch { return null; }
  }
  const scp = /^[^@\s]+@([^:\s]+):/.exec(cleaned);
  return scp?.[1]?.toLowerCase() ?? null;
}
