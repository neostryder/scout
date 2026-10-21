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
  dossier_dir AS dossierDir, dossier_reviewed AS dossierReviewed, flags_json AS flagsJson, follow_upstream AS followUpstream,
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

/** Pure. A new stable tag skips the size, docs, dependency, and quiet-hour checks. It still waits when the queue is full, and a competitor with no baseline commit never queues. */
export function evaluateResearchGate(row: { baseline: { commit: string | null } }, delta: ResearchDelta, config: ResearchGateConfig, now: string): ResearchGateDecision {
  const pending = { commits: delta.commits, sourceFilesChanged: delta.sourceFilesChanged };
  const queuedRuns = config.queuedRuns ?? 0;
  if (!config.enabled) return { decision: "skip", reason: "gate is off", pending };
  if (!row.baseline.commit) return { decision: "skip", reason: "no baseline", pending };
  const tag = config.onNewTag && delta.newStableTag;
  if (tag) {
    if (queuedRuns >= config.maxQueued) return { decision: "wait", reason: "the research queue is full", pending };
    return { decision: "queue", reason: "new stable tag", pending };
  }
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

export function competitorNotice(name: string, latest: string, baseline: string): string {
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
    });
  }
  return { dossierRoot: file["dossierRoot"], mirrorRoot: file["mirrorRoot"], gate: gateOverrides(file["gate"]), entries };
}

export function syncCompetitors(db: Db, entries: CompetitorIdentity[]): void {
  immediate(db, () => {
    const ids = new Set(entries.map((entry) => entry.id));
    const insert = db.prepare(`INSERT INTO competitors (
      id, name, org, remote_url, mirror_path, package_url, dossier_dir, dossier_reviewed, flags_json,
      baseline_version, baseline_commit, baseline_at, baseline_source, follow_upstream
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE competitors SET name = ?, org = ?, remote_url = ?, mirror_path = ?, package_url = ?,
      dossier_dir = ?, dossier_reviewed = ?, flags_json = ?, follow_upstream = ? WHERE id = ?`);
    const fillBaseline = db.prepare(`UPDATE competitors SET baseline_version = ?, baseline_commit = ?, baseline_at = ?, baseline_source = ?
      WHERE id = ? AND baseline_version IS NULL AND baseline_commit IS NULL AND baseline_source IS NULL`);
    for (const entry of entries) {
      const flags = JSON.stringify(knownFlags(entry.flags));
      const existing = db.prepare("SELECT id FROM competitors WHERE id = ?").get(entry.id);
      const baseline = entry.baseline;
      if (!existing) {
        insert.run(entry.id, entry.name, entry.org, entry.remoteUrl, entry.mirrorPath, entry.packageUrl, entry.dossierDir, entry.dossierReviewed, flags, baseline?.version ?? null, baseline?.commit ?? null, baseline?.at ?? null, baseline?.source ?? null, entry.followUpstream ? 1 : 0);
      } else {
        update.run(entry.name, entry.org, entry.remoteUrl, entry.mirrorPath, entry.packageUrl, entry.dossierDir, entry.dossierReviewed, flags, entry.followUpstream ? 1 : 0, entry.id);
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
    const row = db.prepare("SELECT mirror_path AS mirrorPath, baseline_version AS baselineVersion, baseline_commit AS baselineCommit FROM competitors WHERE id = ?").get(competitorId) as { mirrorPath: string | null; baselineVersion: string | null; baselineCommit: string | null } | undefined;
    if (!row) throw new Error("unknown competitor");
    if (!row.mirrorPath) throw new Error("competitor has no mirror");
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

/** Absolute paths stay in the catalog for the update. The runs payload reads them from the request, not from this row. */
export function competitorPaths(db: Db, id: string): { mirrorPath: string | null; dossierDir: string | null; remoteUrl: string | null; packageUrl: string | null; name: string; org: string | null; flags: string[]; latestVersion: string | null; baselineVersion: string | null; baselineCommit: string | null; followUpstream: boolean } | null {
  const row = db.prepare(`SELECT ${COMPETITOR_COLUMNS} FROM competitors WHERE id = ?`).get(id) as StoredCompetitor | undefined;
  if (!row) return null;
  return { mirrorPath: row.mirrorPath, dossierDir: row.dossierDir, remoteUrl: row.remoteUrl, packageUrl: row.packageUrl, name: row.name, org: row.org, flags: flagsFromJson(row.flagsJson), latestVersion: row.latestVersion, baselineVersion: row.baselineVersion, baselineCommit: row.baselineCommit, followUpstream: row.followUpstream === 1 };
}

export function competitorRunRecord(db: Db, id: number, now?: string): (CompetitorRun & { fromCommit: string | null; toCommit: string | null }) | null {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM competitor_runs WHERE id = ?`).get(id) as StoredRun | undefined;
  if (!row) return null;
  return { ...mapRun(row, iso(now)), fromCommit: row.fromCommit, toCommit: row.toCommit };
}
