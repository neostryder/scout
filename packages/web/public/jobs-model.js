// Pure helpers for update jobs: the stages a job moves through, the words for each, and what it is waiting on a person for.

const STAGES = {
  winget: ["download", "verify", "install", "finish"],
  msstore: ["download", "verify", "install", "finish"],
  brew: ["download", "install", "finish"],
  cask: ["download", "install", "finish"],
};
const STAGE_TEXT = {
  download: "Downloading the update",
  verify: "Checking the download",
  install: "Installing",
  finish: "Finishing up",
};

export const LIVE_STATES = ["queued", "preflight", "running"];
export const isLive = (job) => !!job && LIVE_STATES.includes(job.state);

export function stagesFor(ecosystem) { return STAGES[ecosystem] || ["install"]; }

export function elapsedText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** What a live job is waiting on a person for, in words, or null. */
export function attentionText(job) {
  const attention = job?.attention;
  if (!attention) return null;
  const where = job.machineId || "this computer";
  if (attention.kind === "uac") return `Windows is asking for permission on ${where}. Approve the prompt to continue.`;
  if (attention.kind === "window") return `The installer opened a window on ${where}${attention.detail ? `: ${attention.detail}` : ""}. It may be waiting for you.`;
  return null;
}

/**
 * Where a live job stands, or null for a finished one.
 * `stage` and `stages` give the segmented bar; `stages` is 1 for a command that reports no stages, which shows as a sweep.
 */
export function jobProgress(job, now = Date.now()) {
  if (!isLive(job)) return null;
  const started = job.startedAt ? Date.parse(job.startedAt) : NaN;
  const elapsed = Number.isFinite(started) ? elapsedText(now - started) : null;
  const attention = attentionText(job);
  if (job.state === "queued") return { label: "Waiting for its turn", stage: 0, stages: 0, elapsed: null, attention: null };
  if (job.state === "preflight") return { label: job.action === "download" ? "Checking the file" : "Checking the install", stage: 0, stages: 0, elapsed, attention };
  if (job.action === "download") return { label: "Downloading", stage: 1, stages: 1, elapsed, attention };
  const stages = stagesFor(job.ecosystem);
  const last = job.steps?.at(-1);
  // The update command has ended and the new version is being read back.
  if (last && last.name === "update" && last.state === "done") return { label: "Confirming the new version", stage: stages.length, stages: stages.length, elapsed, attention };
  const at = stages.indexOf(job.phase);
  if (at < 0) return { label: stages.length === 1 ? "Updating" : "Starting the update", stage: stages.length === 1 ? 1 : 0, stages: stages.length, elapsed, attention };
  return { label: STAGE_TEXT[job.phase], stage: at + 1, stages: stages.length, elapsed, attention };
}

/** The one line a table row or tab title shows for a job. */
export function jobSummary(job, now = Date.now()) {
  if (!job) return "";
  const progress = jobProgress(job, now);
  if (progress) return progress.attention ? (job.attention.kind === "uac" ? "waiting for the Windows prompt" : "installer window open") : progress.label.toLowerCase();
  if (job.state === "failed") return `failed: ${job.message || "update failed"}`;
  return job.state;
}
