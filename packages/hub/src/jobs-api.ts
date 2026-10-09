import { enqueueBatch, jobById, type Db } from "@scout/core";
import { previewUpdate, type Runner } from "@scout/ops";

export function planResponse(db: Db, runner: Runner, installId: number, alsoInstallIds: string | null = null): unknown | null {
  const alsoUpdating = alsoInstallIds?.split(",").filter((id) => /^\d+$/.test(id.trim())).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) ?? [];
  return previewUpdate(db, installId, runner.deps.machines, { alsoUpdating })?.preview ?? null;
}

export function createJobsResponse(db: Db, runner: Runner, body: unknown): { status: number; body: unknown } {
  const request = body as { installIds?: unknown; confirm?: unknown; confirmSoft?: unknown; allowDisruptive?: unknown; action?: unknown } | null;
  if (request?.action !== undefined && request.action !== "update") return { status: 400, body: { error: "action must be update or download" } };
  if (request?.confirm !== true) return { status: 400, body: { error: "confirm must be true" } };
  if (!Array.isArray(request.installIds) || request.installIds.length === 0 || request.installIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return { status: 400, body: { error: "installIds must be positive integers" } };
  }
  let valid: { installId: number; machineId: string; from: string; to: string }[] = [];
  const refused: { installId: number; reason: string }[] = [];
  const seen = new Set<number>();
  for (const installId of request.installIds as number[]) {
    const preview = previewUpdate(db, installId, runner.deps.machines, { alsoUpdating: request.installIds as number[] })?.preview;
    let reason = preview ? preview.refusal : "no such install or update";
    if (preview?.allowed && preview.disruptive && request.allowDisruptive !== true) reason = "disruptive update needs confirmation";
    if (preview?.allowed && preview.softConfirmation && request.confirmSoft !== true) reason = `needs confirmation: ${[...preview.softConfirmation.projects, ...preview.softConfirmation.dependents].join(", ")}`;
    if (preview?.allowed && seen.has(installId)) reason = "an update for this install is already queued";
    if (preview?.allowed && db.prepare("SELECT 1 FROM jobs WHERE install_id = ? AND state IN ('queued','preflight','running')").get(installId)) reason = "an update for this install is already queued";
    if (reason) refused.push({ installId, reason });
    else if (preview?.from && preview.to) valid.push({ installId, machineId: preview.machineId, from: preview.from, to: preview.to });
    seen.add(installId);
  }
  // A refused partner cannot excuse a break for an install that remains in the batch.
  let changed = true;
  while (changed) {
    changed = false;
    const alsoUpdating = valid.map((entry) => entry.installId);
    valid = valid.filter((entry) => {
      const preview = previewUpdate(db, entry.installId, runner.deps.machines, { alsoUpdating })?.preview;
      const needsConfirmation = preview?.allowed && preview.softConfirmation && request.confirmSoft !== true;
      if (preview?.allowed && !needsConfirmation) return true;
      refused.push({ installId: entry.installId, reason: needsConfirmation && preview.softConfirmation ? `needs confirmation: ${[...preview.softConfirmation.projects, ...preview.softConfirmation.dependents].join(", ")}` : preview?.refusal ?? "no such install or update" });
      changed = true;
      return false;
    });
  }
  if (valid.length === 0) return { status: refused.some((entry) => entry.reason.startsWith("needs confirmation:")) ? 409 : 400, body: { batchId: null, jobs: [], refused } };
  const batch = enqueueBatch(db, valid);
  runner.wake();
  return { status: 202, body: { batchId: batch.batchId, jobs: batch.jobs.map((job) => ({ id: job.id, installId: job.installId, machineId: job.machineId, name: job.name, from: job.from, to: job.to, state: job.state })), refused } };
}

export function jobResponse(db: Db, id: number): unknown | null { return jobById(db, id); }

export async function createDownloadJobsResponse(db: Db, runner: Runner, body: unknown): Promise<{ status: number; body: unknown }> {
  const request = body as { installIds?: unknown; confirm?: unknown; url?: unknown; sha256?: unknown; size?: unknown; fileName?: unknown } | null;
  if (request?.confirm !== true) return { status: 400, body: { error: "confirm must be true" } };
  if (!Array.isArray(request.installIds) || request.installIds.length !== 1 || !Number.isSafeInteger(request.installIds[0]) || Number(request.installIds[0]) <= 0) return { status: 400, body: { error: "download needs one positive installId" } };
  const installId = Number(request.installIds[0]);
  const plan = await runner.deps.resolveDownload?.(installId);
  if (!plan?.preview.allowed || !plan.download || plan.download.url !== request.url || plan.download.sha256 !== request.sha256 || plan.download.size !== request.size || plan.download.fileName !== request.fileName) return { status: 400, body: { error: plan?.preview.refusal ?? "download plan changed" } };
  if (db.prepare("SELECT 1 FROM jobs WHERE install_id = ? AND state IN ('queued','preflight','running')").get(installId)) return { status: 400, body: { error: "a job for this install is already queued" } };
  const batch = enqueueBatch(db, [{ installId, machineId: plan.preview.machineId, from: plan.download.installed ?? "", to: plan.download.version, download: plan.download }]);
  runner.wake();
  return { status: 202, body: batch };
}
