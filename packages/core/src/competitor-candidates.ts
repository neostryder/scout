import type { Db } from "./db.ts";

export type CandidateStatus = "new" | "tracked" | "dismissed";

/** What the discovery run reads about one project before any model sees it. */
export interface CandidateSource {
  /** Stable per source, such as "github:owner/repo". */
  key: string;
  source: "github";
  name: string;
  org: string | null;
  url: string;
  repoUrl: string | null;
  description: string;
  topics: string[];
  stars: number;
  pushedAt: string | null;
}

export interface CandidateJudgement {
  /** MiniMax: one sentence on what the project is and which of our products it touches. */
  summary: string;
  overlaps: string[];
  /** Jev's probabilities, 0 to 1. */
  competitor: number;
  worthTracking: number;
  /** The bars this project was held to, so the page can say why it was or was not offered. */
  needs?: { competitor: number; worthTracking: number };
}

export interface Candidate extends CandidateSource {
  id: string;
  status: CandidateStatus;
  score: number;
  /** True when the run read the project and held it back; it can still be tracked from the passed-over list. */
  passedOver: boolean;
  judgement: CandidateJudgement | null;
  foundAt: string;
  decidedAt: string | null;
}

interface Row {
  id: string; source_key: string; source: string; name: string; org: string | null; url: string; repo_url: string | null;
  description: string; topics_json: string; stars: number; pushed_at: string | null; score: number; judge_json: string | null;
  status: string; found_at: string; decided_at: string | null; passed_over: number;
}

const toCandidate = (row: Row): Candidate => ({
  id: row.id, key: row.source_key, source: "github", name: row.name, org: row.org, url: row.url, repoUrl: row.repo_url,
  description: row.description, topics: JSON.parse(row.topics_json) as string[], stars: row.stars, pushedAt: row.pushed_at,
  status: row.status as CandidateStatus, score: row.score, passedOver: row.passed_over === 1, judgement: row.judge_json ? JSON.parse(row.judge_json) as CandidateJudgement : null,
  foundAt: row.found_at, decidedAt: row.decided_at,
});

export const candidateId = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/** Keys a run has already decided on or stored, so it does not judge the same project twice. Dismissed ones are never offered again. */
export function knownCandidateKeys(db: Db): Set<string> {
  return new Set((db.prepare("SELECT source_key FROM competitor_candidates").all() as { source_key: string }[]).map((row) => row.source_key));
}

/** Stores one judged project as a new candidate. A project already stored keeps its status and is not overwritten. */
export function saveCandidate(db: Db, source: CandidateSource, judgement: CandidateJudgement, score: number, now: string): Candidate | null {
  const id = candidateId(source.key);
  const result = db.prepare(`INSERT OR IGNORE INTO competitor_candidates
    (id, source_key, source, name, org, url, repo_url, description, topics_json, stars, pushed_at, score, judge_json, status, found_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`)
    .run(id, source.key, source.source, source.name, source.org, source.url, source.repoUrl, source.description.slice(0, 1000), JSON.stringify(source.topics.slice(0, 20)), source.stars, source.pushedAt, score, JSON.stringify(judgement), now);
  return Number(result.changes) > 0 ? getCandidate(db, id) : null;
}

/** Remembers a project that was read and held back, with the reasoning, so the next run skips it and the owner can see why and still track it. */
export function rememberPassedOver(db: Db, source: CandidateSource, judgement: CandidateJudgement, score: number, now: string): void {
  db.prepare(`INSERT OR IGNORE INTO competitor_candidates
    (id, source_key, source, name, org, url, repo_url, description, topics_json, stars, pushed_at, score, judge_json, status, found_at, decided_at, passed_over)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dismissed', ?, ?, 1)`)
    .run(candidateId(source.key), source.key, source.source, source.name, source.org, source.url, source.repoUrl, source.description.slice(0, 1000), JSON.stringify(source.topics.slice(0, 20)), source.stars, source.pushedAt, score, JSON.stringify(judgement), now, now);
}

/** Projects the run read and held back, strongest first. */
export function listPassedOver(db: Db, limit = 200): Candidate[] {
  return (db.prepare("SELECT * FROM competitor_candidates WHERE passed_over = 1 AND status = 'dismissed' ORDER BY score DESC, found_at DESC LIMIT ?").all(limit) as unknown as Row[]).map(toCandidate);
}

/** One project the owner decided on by hand, for teaching the judge what the owner counts as a competitor. */
export interface OwnerDecision { verdict: "tracked" | "dismissed"; summary: string; topics: string[] }

/** The owner's own Track and Dismiss choices. Projects the run held back by itself are not decisions, and a held-back project the owner rescued with "Track anyway" is one. */
export function listOwnerDecisions(db: Db): OwnerDecision[] {
  const rows = db.prepare("SELECT * FROM competitor_candidates WHERE judge_json IS NOT NULL AND (status = 'tracked' OR (status = 'dismissed' AND passed_over = 0)) ORDER BY decided_at DESC").all() as unknown as Row[];
  return rows.flatMap((row): OwnerDecision[] => {
    const candidate = toCandidate(row);
    const summary = candidate.judgement?.summary.trim() ?? "";
    return summary ? [{ verdict: candidate.status === "tracked" ? "tracked" : "dismissed", summary, topics: candidate.topics }] : [];
  });
}

export function getCandidate(db: Db, id: string): Candidate | null {
  const row = db.prepare("SELECT * FROM competitor_candidates WHERE id = ?").get(id) as Row | undefined;
  return row ? toCandidate(row) : null;
}

export function listCandidates(db: Db, status: CandidateStatus = "new"): Candidate[] {
  return (db.prepare("SELECT * FROM competitor_candidates WHERE status = ? AND judge_json IS NOT NULL ORDER BY score DESC, found_at DESC").all(status) as unknown as Row[]).map(toCandidate);
}

export function setCandidateStatus(db: Db, id: string, status: Exclude<CandidateStatus, "new">, now: string): Candidate {
  const row = getCandidate(db, id);
  if (!row) throw new Error("no such candidate");
  db.prepare("UPDATE competitor_candidates SET status = ?, decided_at = ? WHERE id = ?").run(status, now, id);
  return { ...row, status, decidedAt: now };
}

/** Returns the registry file text with one competitor added. The id must be unused. */
export function applyAddChange(text: string, entry: { id: string; name: string; org: string | null; remoteUrl: string | null; packageUrl: string | null; baseline?: { version: string | null; commit: string | null; at: string; source: string } | null; addedAt?: string; batch?: string | null }): string {
  const file = JSON.parse(text) as { entries?: Record<string, unknown>[] };
  if (!file || !Array.isArray(file.entries)) throw new Error("competitors file must be an object with entries");
  if (file.entries.some((item) => item["id"] === entry.id)) throw new Error("this competitor is already tracked");
  if (entry.remoteUrl !== null) {
    if (!URL.canParse(entry.remoteUrl) || new URL(entry.remoteUrl).protocol !== "https:") throw new Error("remoteUrl must be https");
  }
  file.entries.push({
    id: entry.id, name: entry.name, org: entry.org, remoteUrl: entry.remoteUrl, mirrorPath: null, packageUrl: entry.packageUrl,
    dossierDir: null, dossierReviewed: null, flags: [], ...(entry.baseline ? { baseline: entry.baseline } : {}),
    ...(entry.addedAt ? { addedAt: entry.addedAt } : {}), ...(entry.batch ? { batch: entry.batch } : {}),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}
