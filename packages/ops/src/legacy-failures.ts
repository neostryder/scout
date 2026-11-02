import type { Db } from "@scout/core";
import { failure } from "./runner.ts";

/** The words an older runner left behind when the installed version no longer matched the plan. */
const LEGACY_MOVED = "installed version changed since the plan";
const MOVED_MESSAGE = "the installed version moved after the last scan; retry the update, which now continues from the version that is installed";
const EXIT_CODE = /^command exited with code (\d+)$/;

/**
 * Rewrites the failure messages that stored update jobs keep from the runner that wrote them.
 * The runner now names the winget exit codes and continues from the version that is installed, so the old words send people the wrong way.
 * Only the message changes: the state, the finish time and the steps stay as they were.
 */
export function rewriteLegacyFailures(db: Db): number {
  let rewritten = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT id, message FROM jobs WHERE state = 'failed' AND action = 'update'").all() as { id: number; message: string | null }[];
    for (const row of rows) {
      const message = row.message;
      if (!message) continue;
      const next = message === LEGACY_MOVED ? MOVED_MESSAGE : rewriteExitCode(db, row.id, message);
      if (!next) continue;
      db.prepare("UPDATE jobs SET message = ? WHERE id = ?").run(next, row.id);
      rewritten++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rewritten;
}

/** The message the runner would write now for the exit code the old message kept, or null when it has nothing better to say. */
function rewriteExitCode(db: Db, jobId: number, message: string): string | null {
  const match = EXIT_CODE.exec(message);
  if (!match) return null;
  const step = db.prepare("SELECT output FROM job_steps WHERE job_id = ? AND name = 'update' ORDER BY seq DESC LIMIT 1").get(jobId) as { output: string | null } | undefined;
  const explained = failure(Number(match[1]), step?.output ?? "");
  if (explained === message || explained.startsWith("command exited with code")) return null;
  return explained;
}
