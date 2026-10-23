import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import type { ConfirmedDownload } from "./download-source.ts";

export type JobState = "queued" | "preflight" | "running" | "done" | "failed" | "stopped";
export const JOB_PHASES = ["download", "verify", "install", "finish"] as const;
export type JobPhase = typeof JOB_PHASES[number];
export const JOB_ATTENTION = ["uac", "window"] as const;
export type JobAttentionKind = typeof JOB_ATTENTION[number];
/** What a running job is waiting on a person for: the Windows administrator prompt, or a window the installer opened. */
export interface JobAttention { kind: JobAttentionKind; detail: string | null; since: string }
export interface JobStep { seq: number; name: string; state: string; output: string | null; at: string }
export interface Job {
  id: number; batchId: string; installId: number; machineId: string; name: string; ecosystem: string;
  action: string; from: string | null; to: string | null; state: JobState; requestedAt: string;
  startedAt: string | null; finishedAt: string | null; message: string | null; steps: JobStep[];
  phase: JobPhase | null; phaseAt: string | null; attention: JobAttention | null;
  download?: ConfirmedDownload; finalPath?: string;
}

const SELECT = `SELECT j.id, j.batch_id AS batchId, j.install_id AS installId, j.machine_id AS machineId,
 p.name, p.ecosystem, j.action, j.from_version AS "from", j.target AS "to", j.state,
 j.requested_at AS requestedAt, j.started_at AS startedAt, j.finished_at AS finishedAt, j.message,
 j.phase, j.phase_at AS phaseAt, j.attention AS attentionKind, j.attention_detail AS attentionDetail, j.attention_at AS attentionAt
 FROM jobs j JOIN installs i ON i.id = j.install_id JOIN packages p ON p.id = i.package_id`;

type JobRow = Omit<Job, "steps" | "attention"> & { attentionKind: JobAttentionKind | null; attentionDetail: string | null; attentionAt: string | null };
function withoutAttention(row: JobRow): Omit<Job, "steps"> {
  const { attentionKind, attentionDetail, attentionAt, ...rest } = row;
  return { ...rest, attention: attentionKind && attentionAt ? { kind: attentionKind, detail: attentionDetail, since: attentionAt } : null };
}

export function jobById(db: Db, id: number): Job | null {
  const found = db.prepare(`${SELECT} WHERE j.id = ?`).get(id) as JobRow | undefined;
  if (!found) return null;
  const row = withoutAttention(found);
  const steps = db.prepare("SELECT seq, name, state, output, at FROM job_steps WHERE job_id = ? ORDER BY seq").all(id) as unknown as JobStep[];
  if (row.action === "download") {
    try {
      const download = JSON.parse(row.to ?? "") as ConfirmedDownload;
      const final = steps.findLast((step) => step.name === "verify" && step.state === "done")?.output;
      return { ...row, to: download.version, download, steps, ...(final ? { finalPath: final.split("\n")[0] } : {}) };
    } catch { return { ...row, steps }; }
  }
  return { ...row, steps };
}

export function listJobs(db: Db, limit = 50): Job[] {
  const ids = db.prepare("SELECT id FROM jobs ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 1000)) as { id: number }[];
  return ids.map((r) => jobById(db, r.id)).filter((j): j is Job => j !== null);
}

export interface InstallJob { id: number; state: JobState; batchId: string }

/** The newest unfinished job per install, or one finished within ten minutes, in one query for a whole list. */
export function recentJobsByInstall(db: Db, now = new Date()): Map<number, InstallJob> {
  const rows = db.prepare("SELECT install_id AS installId, id, state, batch_id AS batchId FROM jobs WHERE state IN ('queued','preflight','running') OR finished_at >= ? ORDER BY id")
    .all(new Date(now.getTime() - 600_000).toISOString()) as unknown as { installId: number; id: number; state: JobState; batchId: string }[];
  return new Map(rows.map((r) => [r.installId, { id: r.id, state: r.state, batchId: r.batchId }]));
}

export function jobForInstall(db: Db, installId: number, now = new Date()): { id: number; state: JobState; batchId: string } | null {
  return db.prepare("SELECT id, state, batch_id AS batchId FROM jobs WHERE install_id = ? AND (state IN ('queued','preflight','running') OR finished_at >= ?) ORDER BY id DESC LIMIT 1")
    .get(installId, new Date(now.getTime() - 600_000).toISOString()) as { id: number; state: JobState; batchId: string } | undefined ?? null;
}

export function enqueueBatch(db: Db, installs: { installId: number; machineId: string; from: string; to: string; download?: ConfirmedDownload }[]): { batchId: string; jobs: Job[] } {
  const batchId = randomUUID();
  const now = new Date().toISOString();
  const jobs: Job[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const i of installs) {
      const existing = db.prepare("SELECT id FROM jobs WHERE install_id = ? AND state IN ('queued','preflight','running')").get(i.installId);
      if (existing) throw new Error("an update for this install is already queued");
      const result = db.prepare("INSERT INTO jobs (batch_id, machine_id, install_id, action, target, state, requested_at, from_version) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
        .run(batchId, i.machineId, i.installId, i.download ? "download" : "update", i.download ? JSON.stringify(i.download) : i.to, now, i.from);
      const job = jobById(db, Number(result.lastInsertRowid));
      if (job) jobs.push(job);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { batchId, jobs };
}

export function claimNext(db: Db, machineId: string): Job | null {
  if (db.prepare("SELECT 1 FROM jobs WHERE machine_id = ? AND state IN ('preflight','running') LIMIT 1").get(machineId)) return null;
  const row = db.prepare("SELECT id FROM jobs WHERE machine_id = ? AND state = 'queued' ORDER BY id LIMIT 1").get(machineId) as { id: number } | undefined;
  if (!row) return null;
  db.prepare("UPDATE jobs SET state = 'preflight', started_at = ? WHERE id = ? AND state = 'queued'").run(new Date().toISOString(), row.id);
  return jobById(db, row.id);
}

export function recordStep(db: Db, id: number, name: string, state: string, output: string | null): void {
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM job_steps WHERE job_id = ?").get(id) as { n: number }).n;
  db.prepare("INSERT INTO job_steps (job_id, seq, name, state, output, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, seq, name, state, output, new Date().toISOString());
}

export function setJobState(db: Db, id: number, state: JobState, message: string | null = null): void {
  const finished = ["done", "failed", "stopped"].includes(state) ? new Date().toISOString() : null;
  // A finished job waits on no one.
  if (finished) db.prepare("UPDATE jobs SET attention = NULL, attention_detail = NULL, attention_at = NULL WHERE id = ?").run(id);
  db.prepare("UPDATE jobs SET state = ?, message = ?, finished_at = ? WHERE id = ?").run(state, message, finished, id);
}

/** Records the stage a running update has reached; a repeat of the same stage keeps its first time. */
export function setJobPhase(db: Db, id: number, phase: JobPhase, at = new Date().toISOString()): void {
  db.prepare("UPDATE jobs SET phase = ?, phase_at = ? WHERE id = ? AND state IN ('preflight','running') AND phase IS NOT ?").run(phase, at, id, phase);
}

/** Sets or, with null, clears what the job is waiting on a person for; the same kind keeps its first time. */
export function setJobAttention(db: Db, id: number, attention: { kind: JobAttentionKind; detail?: string | null } | null, at = new Date().toISOString()): void {
  if (attention === null) {
    db.prepare("UPDATE jobs SET attention = NULL, attention_detail = NULL, attention_at = NULL WHERE id = ?").run(id);
    return;
  }
  const detail = attention.detail ?? null;
  const same = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND attention = ?").get(id, attention.kind);
  if (same) db.prepare("UPDATE jobs SET attention_detail = ? WHERE id = ? AND state IN ('preflight','running')").run(detail, id);
  else db.prepare("UPDATE jobs SET attention = ?, attention_detail = ?, attention_at = ? WHERE id = ? AND state IN ('preflight','running')").run(attention.kind, detail, at, id);
}

export function stopJob(db: Db, id: number): boolean {
  const job = jobById(db, id);
  if (!job || ["done", "failed", "stopped"].includes(job.state)) return false;
  setJobState(db, id, "stopped", "stopped by user");
  return true;
}

export function stopBatch(db: Db, batchId: string): void {
  db.prepare("UPDATE jobs SET state = 'stopped', message = 'stopped: an earlier update in this batch failed', finished_at = ? WHERE batch_id = ? AND state = 'queued'")
    .run(new Date().toISOString(), batchId);
}

export function failInterruptedJobs(db: Db): void {
  const batches = db.prepare("SELECT DISTINCT batch_id AS batchId FROM jobs WHERE state IN ('preflight','running')").all() as { batchId: string }[];
  db.prepare("UPDATE jobs SET state = 'failed', message = 'interrupted by a restart', finished_at = ? WHERE state IN ('preflight','running')")
    .run(new Date().toISOString());
  for (const batch of batches) stopBatch(db, batch.batchId);
}
