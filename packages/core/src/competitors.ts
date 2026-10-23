import { existsSync } from "node:fs";
import type { Db } from "./db.ts";
import { compareVersions } from "./version.ts";

export const COMPETITOR_FLAGS = ["forge", "vault", "tome", "scroll", "quill", "atlas", "herald", "rules", "secret", "orchestrator", "worlds"] as const;

const FLAG_SET = new Set<string>(COMPETITOR_FLAGS);
const STALE_MS = 14 * 24 * 60 * 60 * 1000;
const ACTIVE = "('pulling','queued','claimed')";

export type CompetitorStatus = "new" | "current" | "unknown";
export type RunState = "pulling" | "queued" | "claimed" | "done" | "failed";

export interface CompetitorRun {
  id: number;
  competitorId: string;
  state: RunState;
  fromVersion: string | null;
  toVersion: string | null;
  requestedAt: string;
  updatedAt: string;
  claimedBy: string | null;
  resultPath: string | null;
  summary: string | null;
  error: string | null;
  stale: boolean;
  request: Record<string, unknown> | null;
  trigger: "auto" | "manual" | null;
}

/** Where a competitor with no public repository publishes its version. `json` reads a version out of a JSON document, `page` reads it out of a page's text, `hash` has no version and watches for the page to change. */
export interface CompetitorWatch {
  kind: "json" | "page" | "hash";
  url: string;
  /** Dotted path into the JSON document, with numbers for array positions, for example `versions.0.version`. */
  versionPath?: string;
  /** Regular expression with one capture group for the version, for `page`. */
  versionPattern?: string;
}

export interface CompetitorRow {
  id: string;
  name: string;
  org: string | null;
  remoteUrl: string | null;
  packageUrl: string | null;
  flags: string[];
  mirrorPresent: boolean;
  dossierReviewed: string | null;
  baseline: { version: string | null; commit: string | null; at: string | null; source: string | null };
  latest: { version: string | null; prerelease: string | null; commit: string | null; checkedAt: string | null; error: string | null };
  status: CompetitorStatus;
  newBasis: "version" | "commits" | null;
  sync: { at: string | null; head: string | null; error: string | null };
  pending: { commits: number; sourceFilesChanged: number; reason: string } | null;
  watch: { kind: CompetitorWatch["kind"]; url: string; versionPath?: string; versionPattern?: string } | null;
  run: Pick<CompetitorRun, "id" | "state" | "toVersion" | "updatedAt" | "claimedBy" | "error" | "stale" | "trigger"> | null;
}

export interface CompetitorBaseline {
  version: string | null;
  commit: string | null;
  at: string | null;
  source: string | null;
}

export interface CompetitorIdentity {
  id: string;
  name: string;
  org: string | null;
  remoteUrl: string | null;
  mirrorPath: string | null;
  packageUrl: string | null;
  dossierDir: string | null;
  dossierReviewed: string | null;
  flags: string[];
  baseline: CompetitorBaseline | null;
  gate?: Partial<ResearchGateConfig>;
  /** The mirror follows an upstream that rewrites its published history; the sync keeps the old tip on a backup branch and moves to the new one. */
  followUpstream?: boolean;
  /** A version source for an entry with no repository. */
  watch?: CompetitorWatch | null;
}

export interface CompetitorsFile {
  dossierRoot: string;
  mirrorRoot: string;
  gate?: Partial<ResearchGateConfig>;
  entries: CompetitorIdentity[];
}

/** Defaults for the procedural research gate. An entry's `gate` replaces single fields. `queuedRuns` is counted at decision time and is not stored in the file. */
export const DEFAULT_RESEARCH_GATE = {
  minCommits: 5,
  minSourceFilesChanged: 3,
  onNewTag: true,
  quietHours: 24,
  ignoreDocsOnly: true,
  ignoreDependencyBumpOnly: true,
  maxQueued: 5,
  enabled: true,
} as const;

export interface ResearchGateConfig {
  minCommits: number;
  minSourceFilesChanged: number;
  onNewTag: boolean;
  quietHours: number;
  ignoreDocsOnly: boolean;
  ignoreDependencyBumpOnly: boolean;
  maxQueued: number;
  enabled: boolean;
  queuedRuns?: number;
}

export interface ResearchDelta {
  commits: number;
  sourceFilesChanged: number;
  newStableTag: boolean;
  docsOnly: boolean;
  dependencyBumpOnly: boolean;
  lastCommitAt: string | null;
  /** A watched page with no version number changed. It waits for a person instead of queuing. */
  pageChanged?: boolean;
}

export interface ResearchGateDecision {
  decision: "queue" | "wait" | "skip";
  reason: string;
  pending: { commits: number; sourceFilesChanged: number };
}

export interface StatusInput {
  baselineVersion: string | null;
  baselineCommit: string | null;
  latestVersion: string | null;
  latestCommit: string | null;
  checkedAt: string | null;
  error: string | null;
}

interface StoredCompetitor {
  followUpstream: number;
  watchJson: string | null;
  id: string;
  name: string;
  org: string | null;
  remoteUrl: string | null;
  mirrorPath: string | null;
  packageUrl: string | null;
  dossierDir: string | null;
  dossierReviewed: string | null;
  flagsJson: string;
  baselineVersion: string | null;
  baselineCommit: string | null;
  baselineAt: string | null;
  baselineSource: string | null;
  latestVersion: string | null;
  latestPrerelease: string | null;
  latestCommit: string | null;
  latestCheckedAt: string | null;
  latestError: string | null;
  notifiedVersion: string | null;
  syncedAt: string | null;
  syncError: string | null;
  syncHead: string | null;
  pendingJson: string | null;
}

interface StoredRun {
  id: number;
  competitorId: string;
  state: RunState;
  fromVersion: string | null;
  fromCommit: string | null;
  toVersion: string | null;
  toCommit: string | null;
  requestedAt: string;
  updatedAt: string;
  claimedBy: string | null;
  resultPath: string | null;
  summary: string | null;
  error: string | null;
  requestJson: string | null;
  trigger: string | null;
}

const COMPETITOR_COLUMNS = `id, name, org, remote_url AS remoteUrl, mirror_path AS mirrorPath, package_url AS packageUrl,
  dossier_dir AS dossierDir, dossier_reviewed AS dossierReviewed, flags_json AS flagsJson, follow_upstream AS followUpstream, watch_json AS watchJson,
  baseline_version AS baselineVersion, baseline_commit AS baselineCommit, baseline_at AS baselineAt, baseline_source AS baselineSource,
  latest_version AS latestVersion, latest_prerelease AS latestPrerelease, latest_commit AS latestCommit,
  latest_checked_at AS latestCheckedAt, latest_error AS latestError, notified_version AS notifiedVersion,
  synced_at AS syncedAt, sync_error AS syncError, sync_head AS syncHead, pending_json AS pendingJson`;

const RUN_COLUMNS = `id, competitor_id AS competitorId, state, from_version AS fromVersion, from_commit AS fromCommit,
  to_version AS toVersion, to_commit AS toCommit, requested_at AS requestedAt, updated_at AS updatedAt,
  claimed_by AS claimedBy, result_path AS resultPath, summary, error, request_json AS requestJson, trigger`;

function iso(now?: string): string {
  return now ?? new Date().toISOString();
}

/** A credential in a remote must not leave the process in a notice, an error, or a list payload. */
export function redactUrlSecrets(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@\s/]+@/g, "$1");
}

export function knownFlags(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const flag = value.trim().toLowerCase();
    if (FLAG_SET.has(flag) && !out.includes(flag)) out.push(flag);
  }
  return out;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function flagsFromJson(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? knownFlags(value.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

function requestFromJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pendingFromJson(text: string | null): CompetitorRow["pending"] {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row["commits"] !== "number" || typeof row["sourceFilesChanged"] !== "number" || typeof row["reason"] !== "string") return null;
    return { commits: row["commits"], sourceFilesChanged: row["sourceFilesChanged"], reason: row["reason"] };
  } catch {
    return null;
  }
}

export function watchFromJson(text: string | null): CompetitorWatch | null {
  if (!text) return null;
  try { return checkWatch(JSON.parse(text) as unknown).watch; } catch { return null; }
}

function watchSummary(text: string | null): CompetitorRow["watch"] {
  const watch = watchFromJson(text);
  if (!watch) return null;
  return { kind: watch.kind, url: watch.url, ...(watch.versionPath !== undefined ? { versionPath: watch.versionPath } : {}), ...(watch.versionPattern !== undefined ? { versionPattern: watch.versionPattern } : {}) };
}

const WATCH_KINDS = ["json", "page", "hash"] as const;
const WATCH_KEYS = new Set(["kind", "url", "versionPath", "versionPattern"]);
const BLOCKED_HOST = /^(localhost|.*\.(local|localhost|internal|lan|home|test))$/i;

/** A watch source is fetched by the hub, so it must be a public https page. An address literal or a local name is refused. */
export function watchHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || BLOCKED_HOST.test(host) || host.includes(":") || /^\d+(\.\d+){0,3}$/.test(host)) return false;
  return host.includes(".");
}

/** Validates one watch source. The result carries the cleaned value or the first problem found. */
export function checkWatch(value: unknown): { ok: true; watch: CompetitorWatch } | { ok: false; error: string; watch: null } {
  const fail = (error: string): { ok: false; error: string; watch: null } => ({ ok: false, error, watch: null });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("watch must be an object");
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!WATCH_KEYS.has(key)) return fail(`unknown watch field ${key}`);
  const kind = row["kind"];
  if (typeof kind !== "string" || !(WATCH_KINDS as readonly string[]).includes(kind)) return fail("watch kind must be json, page, or hash");
  const url = textOrNull(row["url"]);
  if (!url || url.length > 500 || !URL.canParse(url)) return fail("watch url must be a web address");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return fail("watch url must be https and carry no credentials");
  if (!watchHostAllowed(parsed.hostname)) return fail("watch url must name a public host");
  const versionPath = textOrNull(row["versionPath"]);
  const versionPattern = textOrNull(row["versionPattern"]);
  if (versionPath !== null && (versionPath.length > 200 || !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(versionPath))) return fail("versionPath must be a dotted path");
  if (versionPattern !== null) {
    if (versionPattern.length > 200) return fail("versionPattern is too long");
    try {
      if (new RegExp(`${versionPattern}|`).exec("")?.length !== 2) return fail("versionPattern needs one capture group");
    } catch { return fail("versionPattern is not a valid expression"); }
  }
  if (kind === "json" && versionPath === null) return fail("a json watch needs a versionPath");
  const watch: CompetitorWatch = { kind: kind as CompetitorWatch["kind"], url: parsed.toString() };
  if (kind === "json" && versionPath !== null) watch.versionPath = versionPath;
  if (kind === "page" && versionPattern !== null) watch.versionPattern = versionPattern;
  return { ok: true, watch };
}

function triggerOf(value: string | null): CompetitorRun["trigger"] {
  return value === "auto" || value === "manual" ? value : null;
}

const GATE_NUMBERS = ["minCommits", "minSourceFilesChanged", "quietHours", "maxQueued"] as const;
const GATE_FLAGS = ["onNewTag", "ignoreDocsOnly", "ignoreDependencyBumpOnly", "enabled"] as const;

function gateOverrides(value: unknown): Partial<ResearchGateConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const out: Partial<ResearchGateConfig> = {};
  for (const key of GATE_NUMBERS) {
    const number = row[key];
    if (typeof number === "number" && Number.isInteger(number) && number >= 0) out[key] = number;
  }
  for (const key of GATE_FLAGS) {
    if (typeof row[key] === "boolean") out[key] = row[key];
  }
  return out;
}

/** File defaults, then the entry's own fields, then the live count of queued and claimed runs. */
export function resolveResearchGate(fileGate: Partial<ResearchGateConfig> | undefined, entryGate: Partial<ResearchGateConfig> | undefined, queuedRuns: number): ResearchGateConfig {
  return { ...DEFAULT_RESEARCH_GATE, ...gateOverrides(fileGate), ...gateOverrides(entryGate), queuedRuns };
}

/** Pure. A new stable tag skips the size, docs, dependency, and quiet-hour checks. It still waits when the queue is full. A competitor with no baseline never queues: a baseline is a commit, or for a watched competitor a version. */
export function evaluateResearchGate(row: { baseline: { commit: string | null; version?: string | null }; watch?: unknown }, delta: ResearchDelta, config: ResearchGateConfig, now: string): ResearchGateDecision {
  const pending = { commits: delta.commits, sourceFilesChanged: delta.sourceFilesChanged };
  const queuedRuns = config.queuedRuns ?? 0;
  if (!config.enabled) return { decision: "skip", reason: "gate is off", pending };
  // A watched competitor has no commits to anchor on, so a version alone is a baseline.
  const based = Boolean(row.baseline.commit) || (Boolean(row.watch) && Boolean(row.baseline.version));
  if (!based) return { decision: "skip", reason: "no baseline", pending };
  const tag = config.onNewTag && delta.newStableTag;
  if (tag) {
    if (queuedRuns >= config.maxQueued) return { decision: "wait", reason: "the research queue is full", pending };
    return { decision: "queue", reason: "new stable tag", pending };
  }
  if (delta.pageChanged) return { decision: "wait", reason: "the watched page changed and shows no new version", pending };
  if (config.ignoreDocsOnly && delta.docsOnly) return { decision: "skip", reason: "docs only", pending };
  if (config.ignoreDependencyBumpOnly && delta.dependencyBumpOnly) return { decision: "skip", reason: "dependency bump only", pending };
  if (delta.commits === 0 && delta.sourceFilesChanged === 0) return { decision: "skip", reason: "nothing new", pending };
  const enough = delta.commits >= config.minCommits || delta.sourceFilesChanged >= config.minSourceFilesChanged;
  if (!enough) return { decision: "wait", reason: `${delta.commits} commits, below the threshold of ${config.minCommits}`, pending };
  if (config.quietHours > 0) {
    const last = delta.lastCommitAt ? Date.parse(delta.lastCommitAt) : Number.NaN;
    const age = Date.parse(now) - last;
    if (!Number.isFinite(age) || age < config.quietHours * 3_600_000) {
      return { decision: "wait", reason: `the last commit is under ${config.quietHours} hours old`, pending };
    }
  }
  if (queuedRuns >= config.maxQueued) return { decision: "wait", reason: "the research queue is full", pending };
  if (delta.commits >= config.minCommits) return { decision: "queue", reason: `${delta.commits} commits`, pending };
  return { decision: "queue", reason: `${delta.sourceFilesChanged} source files changed`, pending };
}

export function deriveCompetitorStatus(input: StatusInput): { status: CompetitorStatus; newBasis: "version" | "commits" | null } {
  const hasBaseline = input.baselineVersion !== null || input.baselineCommit !== null;
  const kept = input.latestVersion !== null || input.latestCommit !== null;
  const succeeded = input.checkedAt !== null && (input.error === null || kept);
  if (!hasBaseline || !succeeded) return { status: "unknown", newBasis: null };
  const compared = input.baselineVersion !== null && input.latestVersion !== null ? compareVersions(input.latestVersion, input.baselineVersion) : null;
  if (compared === 1) return { status: "new", newBasis: "version" };
  if (compared === null && input.latestCommit !== null && input.baselineCommit !== null && input.latestCommit !== input.baselineCommit) {
    return { status: "new", newBasis: "commits" };
  }
  return { status: "current", newBasis: null };
}

/** A page snapshot is stored as `page:` and a short digest in the commit slots. */
export const PAGE_TOKEN = /^page:[0-9a-f]{8,64}$/;

export function competitorNotice(name: string, latest: string, baseline: string): string {
  if (PAGE_TOKEN.test(latest)) return redactUrlSecrets(`${name}: the watched page changed since the last analysis`);
  return redactUrlSecrets(`${name}: new version ${latest} since the last analysis (${baseline})`);
}

function stale(state: RunState, updatedAt: string, now: string): boolean {
  if (state !== "queued" && state !== "claimed") return false;
  const age = Date.parse(now) - Date.parse(updatedAt);
  return Number.isFinite(age) && age > STALE_MS;
}

function mapRun(row: StoredRun, now: string): CompetitorRun {
  return {
    id: row.id,
    competitorId: row.competitorId,
    state: row.state,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    requestedAt: row.requestedAt,
    updatedAt: row.updatedAt,
    claimedBy: row.claimedBy,
    resultPath: row.resultPath,
    summary: row.summary,
    error: row.error,
    stale: stale(row.state, row.updatedAt, now),
    request: requestFromJson(row.requestJson),
    trigger: triggerOf(row.trigger),
  };
}

function runById(db: Db, id: number, now: string): CompetitorRun {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(id) as StoredRun | undefined;
  if (!row) throw new Error("no such run");
  return mapRun(row, now);
}

function mirrorPresent(path: string | null): boolean {
  if (!path) return false;
  try { return existsSync(path); } catch { return false; }
}

function mapRow(row: StoredCompetitor, run: StoredRun | undefined, now: string): CompetitorRow {
  const derived = deriveCompetitorStatus({
    baselineVersion: row.baselineVersion,
    baselineCommit: row.baselineCommit,
    latestVersion: row.latestVersion,
    latestCommit: row.latestCommit,
    checkedAt: row.latestCheckedAt,
    error: row.latestError,
  });
  const mapped = run ? mapRun(run, now) : null;
  return {
    id: row.id,
    name: row.name,
    org: row.org,
    remoteUrl: row.remoteUrl === null ? null : redactUrlSecrets(row.remoteUrl),
    packageUrl: row.packageUrl,
    flags: flagsFromJson(row.flagsJson),
    mirrorPresent: mirrorPresent(row.mirrorPath),
    dossierReviewed: row.dossierReviewed,
    baseline: { version: row.baselineVersion, commit: row.baselineCommit, at: row.baselineAt, source: row.baselineSource },
    latest: { version: row.latestVersion, prerelease: row.latestPrerelease, commit: row.latestCommit, checkedAt: row.latestCheckedAt, error: row.latestError },
    status: derived.status,
    newBasis: derived.newBasis,
    sync: { at: row.syncedAt, head: row.syncHead, error: row.syncError },
    pending: pendingFromJson(row.pendingJson),
    watch: watchSummary(row.watchJson),
    run: mapped ? { id: mapped.id, state: mapped.state, toVersion: mapped.toVersion, updatedAt: mapped.updatedAt, claimedBy: mapped.claimedBy, error: mapped.error, stale: mapped.stale, trigger: mapped.trigger } : null,
  };
}

function immediate<T>(db: Db, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function baselineOf(value: unknown): CompetitorBaseline | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return { version: textOrNull(row["version"]), commit: textOrNull(row["commit"]), at: textOrNull(row["at"]), source: textOrNull(row["source"]) };
}

export function parseCompetitorsFile(text: string): CompetitorsFile {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("competitors file must be an object");
  const file = value as Record<string, unknown>;
  if (typeof file["dossierRoot"] !== "string" || typeof file["mirrorRoot"] !== "string" || !Array.isArray(file["entries"])) {
    throw new Error("competitors file needs dossierRoot, mirrorRoot, and entries");
  }
  const entries: CompetitorIdentity[] = [];
  for (const item of file["entries"]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("competitor entry must be an object");
    const row = item as Record<string, unknown>;
    const id = textOrNull(row["id"]);
    const name = textOrNull(row["name"]);
    if (!id || !name) throw new Error("competitor entry needs an id and a name");
    const flags = Array.isArray(row["flags"]) ? knownFlags(row["flags"].filter((flag): flag is string => typeof flag === "string")) : [];
    entries.push({
      id,
      name,
      org: textOrNull(row["org"]),
      remoteUrl: textOrNull(row["remoteUrl"]),
      mirrorPath: textOrNull(row["mirrorPath"]),
      packageUrl: textOrNull(row["packageUrl"]),
      dossierDir: textOrNull(row["dossierDir"]),
      dossierReviewed: textOrNull(row["dossierReviewed"]),
      flags,
      baseline: baselineOf(row["baseline"]),
      gate: gateOverrides(row["gate"]),
      followUpstream: row["followUpstream"] === true,
      watch: row["watch"] === undefined || row["watch"] === null ? null : checkWatch(row["watch"]).watch,
    });
  }
  return { dossierRoot: file["dossierRoot"], mirrorRoot: file["mirrorRoot"], gate: gateOverrides(file["gate"]), entries };
}

export function syncCompetitors(db: Db, entries: CompetitorIdentity[]): void {
  immediate(db, () => {
    const ids = new Set(entries.map((entry) => entry.id));
    const insert = db.prepare(`INSERT INTO competitors (
      id, name, org, remote_url, mirror_path, package_url, dossier_dir, dossier_reviewed, flags_json,
      baseline_version, baseline_commit, baseline_at, baseline_source, follow_upstream, watch_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE competitors SET name = ?, org = ?, remote_url = ?, mirror_path = ?, package_url = ?,
      dossier_dir = ?, dossier_reviewed = ?, flags_json = ?, follow_upstream = ?, watch_json = ? WHERE id = ?`);
    const fillBaseline = db.prepare(`UPDATE competitors SET baseline_version = ?, baseline_commit = ?, baseline_at = ?, baseline_source = ?
      WHERE id = ? AND baseline_version IS NULL AND baseline_commit IS NULL AND baseline_source IS NULL`);
    for (const entry of entries) {
      const flags = JSON.stringify(knownFlags(entry.flags));
      const watchJson = entry.watch ? JSON.stringify(entry.watch) : null;
      const existing = db.prepare("SELECT id FROM competitors WHERE id = ?").get(entry.id);
      const baseline = entry.baseline;
      if (!existing) {
        insert.run(entry.id, entry.name, entry.org, entry.remoteUrl, entry.mirrorPath, entry.packageUrl, entry.dossierDir, entry.dossierReviewed, flags, baseline?.version ?? null, baseline?.commit ?? null, baseline?.at ?? null, baseline?.source ?? null, entry.followUpstream ? 1 : 0, watchJson);
      } else {
        update.run(entry.name, entry.org, entry.remoteUrl, entry.mirrorPath, entry.packageUrl, entry.dossierDir, entry.dossierReviewed, flags, entry.followUpstream ? 1 : 0, watchJson, entry.id);
        if (baseline) fillBaseline.run(baseline.version, baseline.commit, baseline.at, baseline.source, entry.id);
      }
    }
    const stored = db.prepare("SELECT id FROM competitors").all() as { id: string }[];
    for (const row of stored) {
      if (ids.has(row.id)) continue;
      if (db.prepare(`SELECT 1 FROM competitor_runs WHERE competitor_id = ? AND state IN ${ACTIVE}`).get(row.id)) continue;
      db.prepare("DELETE FROM competitor_runs WHERE competitor_id = ?").run(row.id);
      db.prepare("DELETE FROM competitors WHERE id = ?").run(row.id);
    }
  });
}

export function listCompetitors(db: Db, now?: string): CompetitorRow[] {
  const at = iso(now);
  const rows = db.prepare(`SELECT ${COMPETITOR_COLUMNS} FROM competitors`).all() as unknown as StoredCompetitor[];
  const runs = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id IN (SELECT MAX(id) FROM competitor_runs GROUP BY competitor_id)`).all() as unknown as StoredRun[];
  const byCompetitor = new Map(runs.map((run) => [run.competitorId, run]));
  const rank: Record<CompetitorStatus, number> = { new: 0, current: 1, unknown: 2 };
  return rows.map((row) => mapRow(row, byCompetitor.get(row.id), at)).sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function listCompetitorRuns(db: Db, states: RunState[], now?: string): CompetitorRun[] {
  const at = iso(now);
  if (!states.length) return [];
  const marks = states.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE state IN (${marks}) ORDER BY requested_at DESC, id DESC`).all(...states) as unknown as StoredRun[];
  return rows.map((row) => mapRun(row, at));
}

export function claimCompetitorRun(db: Db, runId: number, by: string, now: string): CompetitorRun {
  return immediate(db, () => {
    const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(runId) as StoredRun | undefined;
    if (!row) throw new Error("no such run");
    if (row.state !== "queued") throw new Error("run is not queued");
    db.prepare("UPDATE competitor_runs SET state = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?").run(by, now, runId);
    return runById(db, runId, now);
  });
}

export function completeCompetitorRun(db: Db, runId: number, input: { resultPath: string; summary: string; analyzedVersion?: string }, now: string): CompetitorRun {
  return immediate(db, () => {
    const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(runId) as StoredRun | undefined;
    if (!row) throw new Error("no such run");
    if (row.state !== "claimed" && row.state !== "queued") throw new Error("run is not queued or claimed");
    const version = input.analyzedVersion ?? row.toVersion;
    db.prepare("UPDATE competitor_runs SET state = 'done', result_path = ?, summary = ?, updated_at = ? WHERE id = ?").run(input.resultPath, input.summary, now, runId);
    db.prepare("UPDATE competitors SET baseline_version = ?, baseline_commit = ?, baseline_at = ?, baseline_source = 'analysis' WHERE id = ?").run(version, row.toCommit, now, row.competitorId);
    return runById(db, runId, now);
  });
}

export function failCompetitorRun(db: Db, runId: number, error: string, now: string): CompetitorRun {
  return immediate(db, () => {
    const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(runId) as StoredRun | undefined;
    if (!row) throw new Error("no such run");
    if (row.state !== "pulling" && row.state !== "queued" && row.state !== "claimed") throw new Error("run is not active");
    db.prepare("UPDATE competitor_runs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now, runId);
    return runById(db, runId, now);
  });
}

export function startPullingRun(db: Db, competitorId: string, now: string): CompetitorRun {
  return immediate(db, () => {
    const row = db.prepare("SELECT mirror_path AS mirrorPath, watch_json AS watchJson, baseline_version AS baselineVersion, baseline_commit AS baselineCommit FROM competitors WHERE id = ?").get(competitorId) as { mirrorPath: string | null; watchJson: string | null; baselineVersion: string | null; baselineCommit: string | null } | undefined;
    if (!row) throw new Error("unknown competitor");
    if (!row.mirrorPath && !row.watchJson) throw new Error("competitor has no mirror");
    if (db.prepare(`SELECT 1 FROM competitor_runs WHERE competitor_id = ? AND state IN ${ACTIVE}`).get(competitorId)) throw new Error("a run is already active");
    const inserted = db.prepare("INSERT INTO competitor_runs (competitor_id, state, from_version, from_commit, requested_at, updated_at, trigger) VALUES (?, 'pulling', ?, ?, ?, ?, 'manual')").run(competitorId, row.baselineVersion, row.baselineCommit, now, now);
    db.prepare("UPDATE competitors SET pending_json = NULL WHERE id = ?").run(competitorId);
    return runById(db, Number(inserted.lastInsertRowid), now);
  });
}

export function queueCompetitorRun(db: Db, runId: number, input: { toVersion: string | null; toCommit: string | null; request: Record<string, unknown> }, now: string): CompetitorRun {
  return immediate(db, () => {
    const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(runId) as StoredRun | undefined;
    if (!row) throw new Error("no such run");
    if (row.state !== "pulling") throw new Error("run is not pulling");
    db.prepare("UPDATE competitor_runs SET state = 'queued', to_version = ?, to_commit = ?, request_json = ?, updated_at = ? WHERE id = ?").run(input.toVersion, input.toCommit, JSON.stringify(input.request), now, runId);
    db.prepare("UPDATE competitors SET pending_json = NULL WHERE id = ?").run(row.competitorId);
    return runById(db, runId, now);
  });
}

export function countOpenResearch(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM competitor_runs WHERE state IN ('queued','claimed')").get() as { n: number };
  return Number(row.n) || 0;
}

export function setCompetitorPending(db: Db, id: string, pending: { commits: number; sourceFilesChanged: number; reason: string } | null): void {
  db.prepare("UPDATE competitors SET pending_json = ? WHERE id = ?").run(pending ? JSON.stringify(pending) : null, id);
}

/** A refusal records the error only. A success replaces the error with the mirror HEAD. */
export function recordMirrorSync(db: Db, id: string, outcome: { at: string; head: string } | { error: string }): void {
  if ("error" in outcome) {
    db.prepare("UPDATE competitors SET sync_error = ? WHERE id = ?").run(redactUrlSecrets(outcome.error).replace(/\s+/g, " ").trim().slice(0, 300), id);
    return;
  }
  db.prepare("UPDATE competitors SET synced_at = ?, sync_head = ?, sync_error = NULL WHERE id = ?").run(outcome.at, outcome.head, id);
}

export function enqueueAutoRun(db: Db, competitorId: string, input: { toVersion: string | null; toCommit: string | null; request: Record<string, unknown> }, now: string): CompetitorRun {
  return immediate(db, () => {
    const row = db.prepare("SELECT baseline_version AS baselineVersion, baseline_commit AS baselineCommit FROM competitors WHERE id = ?").get(competitorId) as { baselineVersion: string | null; baselineCommit: string | null } | undefined;
    if (!row) throw new Error("unknown competitor");
    if (db.prepare(`SELECT 1 FROM competitor_runs WHERE competitor_id = ? AND state IN ${ACTIVE}`).get(competitorId)) throw new Error("a run is already active");
    const inserted = db.prepare("INSERT INTO competitor_runs (competitor_id, state, from_version, from_commit, to_version, to_commit, requested_at, updated_at, request_json, trigger) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, 'auto')").run(competitorId, row.baselineVersion, row.baselineCommit, input.toVersion, input.toCommit, now, now, JSON.stringify(input.request));
    db.prepare("UPDATE competitors SET pending_json = NULL WHERE id = ?").run(competitorId);
    return runById(db, Number(inserted.lastInsertRowid), now);
  });
}

export function applyCompetitorCheck(db: Db, id: string, result: { version: string | null; prerelease: string | null; commit: string | null; error: string | null }, now: string): { notice: string | null; notified: string | null } {
  return immediate(db, () => {
    const existing = db.prepare(`SELECT ${COMPETITOR_COLUMNS} FROM competitors WHERE id = ?`).get(id) as StoredCompetitor | undefined;
    if (!existing) throw new Error("unknown competitor");
    if (result.error !== null) {
      db.prepare("UPDATE competitors SET latest_error = ?, latest_checked_at = ? WHERE id = ?").run(result.error, now, id);
      return { notice: null, notified: null };
    }
    db.prepare("UPDATE competitors SET latest_version = ?, latest_prerelease = ?, latest_commit = ?, latest_checked_at = ?, latest_error = NULL WHERE id = ?").run(result.version, result.prerelease, result.commit, now, id);
    const derived = deriveCompetitorStatus({
      baselineVersion: existing.baselineVersion,
      baselineCommit: existing.baselineCommit,
      latestVersion: result.version,
      latestCommit: result.commit,
      checkedAt: now,
      error: null,
    });
    const latest = derived.newBasis === "commits" ? result.commit : result.version;
    const baseline = derived.newBasis === "commits" ? (existing.baselineCommit ?? "none") : (existing.baselineVersion ?? "none");
    if (derived.status !== "new" || !latest || latest === existing.notifiedVersion) return { notice: null, notified: null };
    return { notice: competitorNotice(existing.name, latest, baseline), notified: latest };
  });
}

export function markCompetitorNotified(db: Db, id: string, version: string): void {
  db.prepare("UPDATE competitors SET notified_version = ? WHERE id = ?").run(version, id);
}

/** A watched competitor with no baseline takes its first observation as the baseline, so only later changes read as new. */
export function seedWatchBaseline(db: Db, id: string, observed: { version: string | null; commit: string | null }, now: string): boolean {
  const row = db.prepare("SELECT watch_json AS watchJson, baseline_version AS baselineVersion, baseline_commit AS baselineCommit FROM competitors WHERE id = ?").get(id) as { watchJson: string | null; baselineVersion: string | null; baselineCommit: string | null } | undefined;
  if (!row?.watchJson || row.baselineVersion !== null || row.baselineCommit !== null) return false;
  if (observed.version === null && observed.commit === null) return false;
  db.prepare("UPDATE competitors SET baseline_version = ?, baseline_commit = ?, baseline_at = ?, baseline_source = 'watch' WHERE id = ?").run(observed.version, observed.commit, now, id);
  return true;
}

export interface GateSettings {
  defaults: typeof DEFAULT_RESEARCH_GATE;
  global: Partial<ResearchGateConfig>;
  entries: { id: string; name: string; gate: Partial<ResearchGateConfig> }[];
}

/** What the registry file sets for the gate, beside the built-in defaults. Only entries with an override of their own are listed. */
export function readGateSettings(text: string): GateSettings {
  const file = parseCompetitorsFile(text);
  return {
    defaults: DEFAULT_RESEARCH_GATE,
    global: file.gate ?? {},
    entries: file.entries.filter((entry) => entry.gate && Object.keys(entry.gate).length > 0).map((entry) => ({ id: entry.id, name: entry.name, gate: entry.gate ?? {} })),
  };
}

export interface GateChange {
  /** The competitor whose override changes. Left out, the file-wide gate changes. */
  id?: string;
  set?: Record<string, unknown>;
  /** Fields to drop, so the value falls back to the file-wide gate or the default. */
  clear?: string[];
}

function parseRegistry(text: string): { file: Record<string, unknown>; entries: Record<string, unknown>[] } {
  const file = JSON.parse(text) as unknown;
  if (!file || typeof file !== "object" || Array.isArray(file) || !Array.isArray((file as Record<string, unknown>)["entries"])) throw new Error("competitors file must be an object with entries");
  return { file: file as Record<string, unknown>, entries: (file as { entries: Record<string, unknown>[] })["entries"] };
}

const GATE_KEYS: readonly string[] = [...GATE_NUMBERS, ...GATE_FLAGS];
const GATE_LIMIT = 100_000;

function checkedGateValues(set: Record<string, unknown>): Partial<ResearchGateConfig> {
  const out: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(set)) {
    if (!GATE_KEYS.includes(key)) throw new Error(`unknown gate field ${key}`);
    if ((GATE_FLAGS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
      out[key] = value;
      continue;
    }
    const min = key === "maxQueued" ? 1 : 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > GATE_LIMIT) throw new Error(`${key} must be a whole number from ${min} to ${GATE_LIMIT}`);
    out[key] = value;
  }
  return out as Partial<ResearchGateConfig>;
}

/** Returns the registry file text with one gate changed. Everything else in the file is kept as written. */
export function applyGateChange(text: string, change: GateChange): string {
  const { file, entries } = parseRegistry(text);
  const values = checkedGateValues(change.set ?? {});
  for (const key of change.clear ?? []) if (!GATE_KEYS.includes(key)) throw new Error(`unknown gate field ${key}`);
  let holder: Record<string, unknown> = file;
  if (change.id !== undefined) {
    const entry = entries.find((item) => item["id"] === change.id);
    if (!entry) throw new Error("unknown competitor");
    holder = entry;
  }
  const current = holder["gate"] && typeof holder["gate"] === "object" && !Array.isArray(holder["gate"]) ? { ...(holder["gate"] as Record<string, unknown>) } : {};
  for (const key of change.clear ?? []) delete current[key];
  Object.assign(current, values);
  if (Object.keys(current).length === 0) delete holder["gate"];
  else holder["gate"] = current;
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Returns the registry file text with one competitor's watch source set, or removed when `watch` is null. */
export function applyWatchChange(text: string, id: string, watch: unknown): string {
  const { file, entries } = parseRegistry(text);
  const entry = entries.find((item) => item["id"] === id);
  if (!entry) throw new Error("unknown competitor");
  if (watch === null) delete entry["watch"];
  else {
    const checked = checkWatch(watch);
    if (!checked.ok) throw new Error(checked.error);
    entry["watch"] = checked.watch;
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Returns the registry file text without one competitor's entry. Its dossier folder and mirror checkout stay on disk. */
export function applyRemoveChange(text: string, id: string): string {
  const { file, entries } = parseRegistry(text);
  const at = entries.findIndex((item) => item["id"] === id);
  if (at < 0) throw new Error("unknown competitor");
  entries.splice(at, 1);
  return `${JSON.stringify(file, null, 2)}
`;
}

const REPO_KEYS: ReadonlySet<string> = new Set(["remoteUrl", "mirrorPath", "baseline"]);
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Returns the registry file text with one competitor's repository set, or cleared when `repo` is null. Setting one drops the competitor's watch source, since the mirror replaces it, and a given baseline starts the research gate from that commit. */
export function applyRepoChange(text: string, id: string, repo: unknown, now: string): string {
  const { file, entries } = parseRegistry(text);
  const entry = entries.find((item) => item["id"] === id);
  if (!entry) throw new Error("unknown competitor");
  if (repo === null) {
    entry["remoteUrl"] = null;
    entry["mirrorPath"] = null;
    return `${JSON.stringify(file, null, 2)}\n`;
  }
  if (!repo || typeof repo !== "object" || Array.isArray(repo)) throw new Error("repo must be an object, or null to remove it");
  const row = repo as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!REPO_KEYS.has(key)) throw new Error(`unknown repo field ${key}`);
  const raw = typeof row["remoteUrl"] === "string" ? row["remoteUrl"].trim() : "";
  if (!raw || raw.length > 500 || !URL.canParse(raw)) throw new Error("remoteUrl must be a web address");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("remoteUrl must be https and carry no credentials");
  if (!watchHostAllowed(url.hostname)) throw new Error("remoteUrl must name a public host");
  const root = typeof file["mirrorRoot"] === "string" ? file["mirrorRoot"].replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const mirror = typeof row["mirrorPath"] === "string" ? row["mirrorPath"].trim().replace(/\\/g, "/") : "";
  if (!root || !mirror.toLowerCase().startsWith(`${root.toLowerCase()}/`) || mirror.length === root.length + 1 || mirror.split("/").includes("..")) throw new Error("mirrorPath must be a folder inside the mirror root");
  let baseline: { version: string | null; commit: string } | null = null;
  if (row["baseline"] !== undefined) {
    const given = row["baseline"];
    if (!given || typeof given !== "object" || Array.isArray(given)) throw new Error("baseline must be an object");
    const fields = given as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (key !== "version" && key !== "commit") throw new Error(`unknown baseline field ${key}`);
    if (typeof fields["commit"] !== "string" || !FULL_SHA.test(fields["commit"])) throw new Error("baseline commit must be a full 40-character commit");
    const version = fields["version"];
    if (version !== undefined && version !== null && (typeof version !== "string" || version.length > 100)) throw new Error("baseline version must be text of at most 100 characters");
    baseline = { version: typeof version === "string" ? version : null, commit: fields["commit"] };
  }
  entry["remoteUrl"] = url.toString();
  entry["mirrorPath"] = mirror;
  delete entry["watch"];
  if (baseline) entry["baseline"] = { ...baseline, at: now.slice(0, 10), source: "mirror" };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Absolute paths stay in the catalog for the update. The runs payload reads them from the request, not from this row. */
export function competitorPaths(db: Db, id: string): { mirrorPath: string | null; dossierDir: string | null; remoteUrl: string | null; packageUrl: string | null; name: string; org: string | null; flags: string[]; latestVersion: string | null; baselineVersion: string | null; baselineCommit: string | null; followUpstream: boolean; watch: CompetitorWatch | null } | null {
  const row = db.prepare(`SELECT ${COMPETITOR_COLUMNS} FROM competitors WHERE id = ?`).get(id) as StoredCompetitor | undefined;
  if (!row) return null;
  return { mirrorPath: row.mirrorPath, dossierDir: row.dossierDir, remoteUrl: row.remoteUrl, packageUrl: row.packageUrl, name: row.name, org: row.org, flags: flagsFromJson(row.flagsJson), latestVersion: row.latestVersion, baselineVersion: row.baselineVersion, baselineCommit: row.baselineCommit, followUpstream: row.followUpstream === 1, watch: watchFromJson(row.watchJson) };
}

export function competitorRunRecord(db: Db, id: number, now?: string): (CompetitorRun & { fromCommit: string | null; toCommit: string | null }) | null {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(id) as StoredRun | undefined;
  if (!row) return null;
  return { ...mapRun(row, iso(now)), fromCommit: row.fromCommit, toCommit: row.toCommit };
}
