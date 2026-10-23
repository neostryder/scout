import { readFileSync } from "node:fs";
import { compareVersions, claimNext, failInterruptedJobs, jobById, listJobs, recordStep, runArgv, setJobAttention, setJobPhase, setJobState, stopBatch, stopJob, updatesView, updateTarget, type Db, type Exec, type ExecHooks, type ExecResult, type Job, type Transport } from "@scout/core";
import { planDownloadCommands, planUpdate, type PlanMachine, type UpdatePlan } from "./plan.ts";
import { findHubMachine, setHubMachine, downloadFileName, downloadHttps, type ConfirmedDownload, type DownloadPlan } from "@scout/core";
import { dependencyRefusal, softConfirmation, updateBreaks, type SoftConfirmation, type UpdateBreaks } from "./guard.ts";
import { progressReader, unstaged } from "./progress.ts";
import { AttentionTracker, windowsObserver, type Observer } from "./observe.ts";

export interface MachineConfig extends PlanMachine {
  id: string;
  arch?: "x64" | "arm64";
  paused?: boolean;
  /** Git clone folders. Absent means the home defaults plus each project root. */
  cloneRoots?: string[];
  /** Folders added to the clone roots, whether they are the defaults or an explicit cloneRoots list. */
  extraCloneRoots?: string[];
}
export interface ResolvedDownload { preview: DownloadPlan; download: ConfirmedDownload | null; transport: Transport | null }
export interface RunnerDeps {
  exec?: Exec; machines: MachineConfig[]; updateTimeoutMs?: number; checkTimeoutMs?: number;
  /** Reads the desktop while an update runs. Unset means the Windows reader when the real exec runs on this Windows machine, `false` means none. */
  observe?: Observer | false;
  /** How often the desktop is read, in milliseconds. */
  observeIntervalMs?: number;
  /** How long an administrator prompt may sit unanswered before the update is stopped. */
  promptTimeoutMs?: number;
  resolveDownload?: (installId: number, fresh?: boolean, signal?: AbortSignal) => Promise<ResolvedDownload | null>;
}
export interface Preview { installId: number; machineId: string; name: string; ecosystem: string; from: string | null; to: string | null; command: string; disruptive: boolean; needsAdmin: boolean; running: boolean; warnings: string[]; allowed: boolean; refusal: string | null; breaks: UpdateBreaks; softConfirmation: SoftConfirmation | null }

export function loadMachines(path: string): MachineConfig[] {
  return loadAllMachines(path).filter((machine) => machine.paused !== true || machine.transport.type === "local");
}

export function pausedMachineIds(path: string): string[] {
  return loadAllMachines(path).filter((machine) => machine.paused === true && machine.transport.type !== "local").map((machine) => machine.id);
}

export function loadAllMachines(path: string): MachineConfig[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${path} not found: copy machines.example.json to machines.json and list your machines`);
    throw error;
  }
  const machines = (JSON.parse(text) as { machines: MachineConfig[] }).machines;
  for (const machine of machines) assertCloneRoots(machine);
  return machines;
}

const DEFAULT_CLONE_ROOTS = ["Repositories", "repos", "src", "code", "git", "Projects", "projects", "dev"];

// An empty list is a choice to scan nothing, so a present key must not fall through to the defaults.
export function cloneRootsFor(machine: { cloneRoots?: string[]; extraCloneRoots?: string[]; projectRoots?: string[] }): string[] {
  const roots = machine.cloneRoots !== undefined ? machine.cloneRoots.slice() : DEFAULT_CLONE_ROOTS.map((name) => `~/${name}`);
  const seen = new Set(roots);
  const add = (base: string): void => {
    if (base.length === 0 || seen.has(base)) return;
    seen.add(base);
    roots.push(base);
  };
  if (machine.cloneRoots === undefined) {
    for (const entry of machine.projectRoots ?? []) add(entry.endsWith("/*") ? entry.slice(0, -2) : entry);
  }
  for (const entry of machine.extraCloneRoots ?? []) add(entry);
  return roots;
}

export function assertCloneRoots(machine: { cloneRoots?: unknown; extraCloneRoots?: unknown }): void {
  for (const key of ["cloneRoots", "extraCloneRoots"] as const) {
    const roots = machine[key];
    if (roots === undefined) continue;
    if (!Array.isArray(roots) || roots.some((entry) => typeof entry !== "string")) throw new Error(`${key} must be an array of strings`);
  }
}

/** Reads machines.json and makes its local machine the hub, so every module agrees on which machine runs Scout. */
export function configureHubMachine(path: string): MachineConfig[] {
  const machines = loadMachines(path);
  const hub = findHubMachine(machines);
  if (hub) setHubMachine(hub.id, (hub as { name?: string }).name);
  return machines;
}

function installRecord(db: Db, id: number): { machineId: string; key: string; kind: string; details: Record<string, unknown> } | null {
  const row = db.prepare("SELECT i.machine_id AS machineId, p.key, i.kind, i.details_json AS details FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.id = ? AND i.removed_at IS NULL")
    .get(id) as { machineId: string; key: string; kind: string; details: string } | undefined;
  return row ? { ...row, details: JSON.parse(row.details) as Record<string, unknown> } : null;
}

export function previewUpdate(db: Db, installId: number, machines: MachineConfig[], options: { alsoUpdating?: number[] } = {}): { preview: Preview; plan: UpdatePlan; transport: Transport | null } | null {
  const row = updatesView(db).find((r) => r.installId === installId);
  const install = installRecord(db, installId);
  if (!row || !install) return null;
  const machine = machines.find((m) => m.id === row.machineId) ?? null;
  const running = !!db.prepare("SELECT 1 FROM usage_signals WHERE install_id = ? AND kind = 'running' AND value = '1' AND available = 1 ORDER BY observed_at DESC LIMIT 1").get(installId);
  const plan = planUpdate({ ecosystem: row.ecosystem, key: row.key, kind: install.kind, details: install.details }, row.available ?? "", machine, running);
  const breaks = updateBreaks(db, installId, updateTarget(row), row.machineId, options.alsoUpdating);
  const refusal = breaks.hard.length ? dependencyRefusal(`${row.name} ${row.installed ?? ""}`.trim(), breaks.hard.map((entry) => entry.dependent.name), breaks.hard.map((entry) => entry.reason)) : !row.updatable ? row.blockedBy ?? "no installable update is available" : plan.refusal;
  const preview: Preview = { installId, machineId: row.machineId, name: row.name, ecosystem: row.ecosystem, from: row.installed, to: row.available,
    command: plan.command, disruptive: plan.disruptive, needsAdmin: plan.needsAdmin, running, warnings: breaks.soft.map((entry) => entry.reason), allowed: refusal === null, refusal, breaks, softConfirmation: softConfirmation(breaks) };
  return { preview, plan, transport: machine?.transport ?? null };
}

export function cleanOutput(text: string): string {
  const kept = text.split(/\r?\n/).filter((line) => !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)).join("\n");
  return kept.length <= 8192 ? kept : `${kept.slice(0, 2048)}\n[output trimmed]\n${kept.slice(-6000)}`;
}

/** Names under the "Would upgrade" headings of `brew upgrade --dry-run`, without the versions. */
export function wouldUpgrade(stdout: string): string[] {
  const names: string[] = [];
  let collecting = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("==>")) {
      collecting = /^==> Would upgrade/.test(line);
      continue;
    }
    const name = collecting ? line.trim().split(/\s+/)[0] : undefined;
    if (name && /^[a-z0-9@._+-]+$/i.test(name)) names.push(name);
  }
  return names;
}

/** Null when the upgrade touches only the target; otherwise the libraries it would change and the installed programs that use them. */
export async function dependencyRisk(exec: Exec, transport: Transport, key: string, timeoutMs: number, signal: AbortSignal, env?: Record<string, string>): Promise<{ message: string; report: string } | null> {
  const dry = await exec(transport, ["brew", "upgrade", "--dry-run", key], timeoutMs, signal, env);
  if (dry.exitCode !== 0) return { message: "could not check what the upgrade would change", report: cleanOutput(dry.stdout + "\n" + dry.stderr) };
  const upgrading = new Set(wouldUpgrade(dry.stdout));
  const shared: string[] = [];
  for (const dep of upgrading) {
    if (dep === key) continue;
    const uses = await exec(transport, ["brew", "uses", "--installed", "--formula", dep], timeoutMs, signal, env);
    if (uses.exitCode !== 0) return { message: "could not check what uses the libraries the upgrade would change", report: cleanOutput(uses.stdout + "\n" + uses.stderr) };
    const users = uses.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9@._+-]+$/i.test(l) && l !== key && !upgrading.has(l));
    if (users.length > 0) shared.push(dependencyRefusal(dep, users));
  }
  if (shared.length === 0) return null;
  return { message: shared.join("; "), report: shared.join("\n") };
}

// Exit codes from winget's documented list, plus the Windows codes a declined administrator prompt surfaces as.
const DECLINED = new Set([1223, -2147023673, -1978334964]);
const IN_USE = new Set([-1978334975, -1978334973, -1978334959]);
const REBOOT = new Set([-1978334967, -1978334966, -1978334965]);

export interface FailureContext { promptSeen: boolean; windowSeen: boolean; timeoutMs: number }

export function failure(exitCode: number, output: string, context?: FailureContext): string {
  if (context?.promptSeen && (DECLINED.has(exitCode) || /operation (?:was )?cancel|cancelled by|declined/i.test(output))) return "the Windows administrator prompt was declined";
  if (DECLINED.has(exitCode)) return "the installation was cancelled";
  if (IN_USE.has(exitCode)) return "the app is running; close it and try again";
  if (exitCode === -1978334974) return "another installation is in progress; try again when it finishes";
  if (REBOOT.has(exitCode)) return "restart the computer to finish the update";
  if (exitCode === -1978335207 || /requires? (?:administrator|admin|sudo)|sudo:|a terminal is required|password is required/i.test(output)) return "needs admin; Scout cannot elevate yet";
  if (exitCode === -1978335189) return "no applicable update is available";
  if (exitCode === -1 && context) return `did not finish in ${Math.round(context.timeoutMs / 60_000)} minutes${context.windowSeen ? "; the installer opened a window and may have been waiting for you" : ""}`;
  return `command exited with code ${exitCode}`;
}

export interface WatchedRun { result: ExecResult; tracker: AttentionTracker; promptExpired: boolean }

/**
 * Runs the update command and, while it runs, records the stage its output reaches and what it is waiting on a person for.
 * An administrator prompt left unanswered past `promptTimeoutMs` stops the command, so one ignored prompt cannot hold the machine's queue.
 */
export async function runWatched(db: Db, job: Job, deps: RunnerDeps, exec: Exec, transport: Transport, argv: string[], ecosystem: string, timeoutMs: number, signal: AbortSignal, env?: Record<string, string>): Promise<WatchedRun> {
  const tracker = new AttentionTracker();
  const read = progressReader(ecosystem);
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  signal.addEventListener("abort", forward, { once: true });
  if (signal.aborted) forward();
  let rootPid: number | undefined;
  let promptSince: number | null = null;
  let promptExpired = false;
  const sync = (): void => setJobAttention(db, job.id, tracker.current());
  if (unstaged(ecosystem)) setJobPhase(db, job.id, "install");
  const hooks: ExecHooks = {
    onSpawn: (pid) => { rootPid = pid; },
    onOutput: (chunk) => {
      for (const event of read(chunk)) {
        if (event.phase) setJobPhase(db, job.id, event.phase);
        tracker.line(event);
      }
      sync();
    },
  };
  const observe = deps.observe === false ? undefined : deps.observe ?? (deps.exec === undefined && process.platform === "win32" && transport.type === "local" ? windowsObserver() : undefined);
  let looking = false;
  const timer = observe ? setInterval(() => {
    if (looking || rootPid === undefined || controller.signal.aborted) return;
    looking = true;
    void observe(rootPid, controller.signal).then((seen) => {
      tracker.look(seen);
      sync();
      if (!tracker.prompting) promptSince = null;
      else if (promptSince === null) promptSince = Date.now();
      else if (Date.now() - promptSince > (deps.promptTimeoutMs ?? 180_000)) { promptExpired = true; controller.abort(); }
    }, () => undefined).finally(() => { looking = false; });
  }, deps.observeIntervalMs ?? 4000) : undefined;
  try {
    const result = await exec(transport, argv, timeoutMs, controller.signal, env, hooks);
    return { result, tracker, promptExpired };
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", forward);
    setJobAttention(db, job.id, null);
  }
}

export async function runJob(db: Db, job: Job, deps: RunnerDeps, signal: AbortSignal): Promise<void> {
  if (job.action === "download") return runDownloadJob(db, job, deps, signal);
  const exec = deps.exec ?? runArgv;
  const batchOptions = (): { alsoUpdating: number[] } => ({ alsoUpdating: (db.prepare("SELECT install_id AS installId FROM jobs WHERE batch_id = ? AND machine_id = ? AND action = 'update' AND state IN ('queued','preflight','running','done') AND id != ?").all(job.batchId, job.machineId, job.id) as { installId: number }[]).map((row) => row.installId) });
  const preview = previewUpdate(db, job.installId, deps.machines, batchOptions());
  const fail = (message: string): void => { setJobState(db, job.id, signal.aborted ? "stopped" : "failed", signal.aborted ? "stopped by user" : message); };
  if (!preview || !preview.preview.allowed || !preview.transport || preview.preview.from !== job.from || preview.preview.to !== job.to) {
    const reason = preview?.preview.refusal ?? "install, answer, constraint, or machine changed";
    recordStep(db, job.id, "preflight", "failed", reason);
    fail(reason);
    return;
  }
  const { plan, transport } = preview;
  const checkTimeout = deps.checkTimeoutMs ?? 120_000;
  const updateTimeout = deps.updateTimeoutMs ?? 1_200_000;
  const isBrew = ["brew", "cask"].includes(preview.preview.ecosystem);
  const env = isBrew ? { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_SUDO: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ENV_HINTS: "1" } : undefined;
  try {
    const before = await exec(transport, plan.verify.argv, checkTimeout, signal, env);
    const installed = plan.verify.parse(before.stdout);
    if (signal.aborted) throw new Error("stopped by user");
    if (before.exitCode !== 0 || installed !== job.from) {
      recordStep(db, job.id, "preflight", "failed", cleanOutput(before.stdout + "\n" + before.stderr));
      fail("installed version changed since the plan");
      return;
    }
    const fresh = previewUpdate(db, job.installId, deps.machines, batchOptions());
    if (!fresh?.preview.allowed || fresh.preview.to !== job.to) {
      const reason = fresh?.preview.refusal ?? "answer or constraint changed";
      recordStep(db, job.id, "preflight", "failed", reason);
      fail(reason);
      return;
    }
    recordStep(db, job.id, "preflight", "done", cleanOutput(before.stdout + "\n" + before.stderr));
    setJobState(db, job.id, "running");
    if (isBrew) {
      // The local index goes stale; without a refresh `brew upgrade` finds nothing and exits 0.
      const refreshed = await exec(transport, ["brew", "update"], updateTimeout, signal, env);
      if (signal.aborted) throw new Error("stopped by user");
      if (refreshed.exitCode !== 0) {
        recordStep(db, job.id, "refresh", "failed", cleanOutput(refreshed.stdout + "\n" + refreshed.stderr));
        fail("could not refresh Homebrew");
        return;
      }
      recordStep(db, job.id, "refresh", "done", cleanOutput(refreshed.stdout + "\n" + refreshed.stderr));
      if (preview.preview.ecosystem === "brew") {
        // An upgrade also upgrades the formula's libraries, and a program that still links the old one stops starting.
        const risk = await dependencyRisk(exec, transport, plan.argv.at(-1) ?? "", updateTimeout, signal, env);
        if (signal.aborted) throw new Error("stopped by user");
        recordStep(db, job.id, "dependencies", risk ? "failed" : "done", risk?.report ?? "no shared libraries would change");
        if (risk) {
          fail(risk.message);
          return;
        }
      }
    }
    const guarded = previewUpdate(db, job.installId, deps.machines, batchOptions());
    if (!guarded?.preview.allowed || guarded.preview.to !== job.to) {
      const reason = guarded?.preview.refusal ?? "answer or constraint changed";
      recordStep(db, job.id, "preflight", "failed", reason);
      fail(reason);
      return;
    }
    const { result: updated, tracker, promptExpired } = await runWatched(db, job, deps, exec, transport, plan.argv, preview.preview.ecosystem, updateTimeout, signal, env);
    if (signal.aborted) throw new Error("stopped by user");
    if (promptExpired) {
      recordStep(db, job.id, "update", "failed", cleanOutput(updated.stdout + "\n" + updated.stderr));
      fail(`no one answered the Windows administrator prompt in ${Math.max(1, Math.round((deps.promptTimeoutMs ?? 180_000) / 60_000))} minutes, so Scout stopped the update`);
      return;
    }
    if (updated.exitCode !== 0) {
      recordStep(db, job.id, "update", "failed", cleanOutput(updated.stdout + "\n" + updated.stderr));
      fail(failure(updated.exitCode, updated.stderr + "\n" + updated.stdout, { promptSeen: tracker.uacSeen, windowSeen: tracker.windowSeen, timeoutMs: updateTimeout }));
      return;
    }
    recordStep(db, job.id, "update", "done", cleanOutput(updated.stdout + "\n" + updated.stderr));
    if (isBrew) {
      // Whole-machine cleanup is off, so drop only this package's old versions, as `brew upgrade` normally does.
      const cleaned = await exec(transport, ["brew", "cleanup", plan.argv.at(-1) ?? ""], updateTimeout, signal, env);
      if (signal.aborted) throw new Error("stopped by user");
      recordStep(db, job.id, "cleanup", cleaned.exitCode === 0 ? "done" : "failed", cleanOutput(cleaned.stdout + "\n" + cleaned.stderr));
    }
    const after = await exec(transport, plan.verify.argv, checkTimeout, signal, env);
    if (signal.aborted) throw new Error("stopped by user");
    const version = plan.verify.parse(after.stdout);
    if (after.exitCode !== 0 || !version || !job.to || compareVersions(version, job.to) !== 0 && compareVersions(version, job.to) !== 1) {
      recordStep(db, job.id, "verify", "failed", cleanOutput(after.stdout + "\n" + after.stderr));
      fail("installed version did not reach the target");
      return;
    }
    db.prepare("UPDATE installs SET version = ?, last_seen = ? WHERE id = ?").run(version, new Date().toISOString(), job.installId);
    recordStep(db, job.id, "verify", "done", cleanOutput(after.stdout + "\n" + after.stderr));
    setJobState(db, job.id, "done");
  } catch (err) {
    if (jobById(db, job.id)?.state !== "stopped") fail((err as Error).message);
  }
}

async function runDownloadJob(db: Db, job: Job, deps: RunnerDeps, signal: AbortSignal): Promise<void> {
  const exec = deps.exec ?? runArgv;
  let step = "resolve";
  let acquired = false;
  let commands: ReturnType<typeof planDownloadCommands> | null = null;
  let transport: Transport | null = null;
  try {
    const confirmed = job.download;
    const fresh = await deps.resolveDownload?.(job.installId, true, signal);
    if (signal.aborted) throw new Error("stopped by user");
    if (!confirmed || !fresh?.preview.allowed || !fresh.download || !fresh.transport || fresh.preview.machineId !== job.machineId || ["url", "fileName", "size", "sha256", "source", "platform", "arch", "version", "installed"].some((key) => fresh.download?.[key as keyof ConfirmedDownload] !== confirmed[key as keyof ConfirmedDownload])) throw new Error("file, size, checksum, install, constraint, or machine changed since the plan");
    if (downloadHttps(confirmed.url) !== confirmed.url || downloadFileName(confirmed.fileName) !== confirmed.fileName || confirmed.size !== null && confirmed.size > 2147483648) throw new Error("download file is invalid or exceeds 2 GiB");
    transport = fresh.transport;
    commands = planDownloadCommands(confirmed);
    recordStep(db, job.id, step, "done", confirmed.fileName);
    setJobState(db, job.id, "running");
    step = "download";
    const downloaded = await exec(transport, commands.download, deps.updateTimeoutMs ?? 1_200_000, signal);
    acquired = downloaded.stdout.split(/\r?\n/).includes("created");
    if (signal.aborted) throw new Error("stopped by user");
    if (downloaded.exitCode !== 0 || !acquired) throw new Error("download failed");
    recordStep(db, job.id, step, "done", confirmed.fileName);
    step = "verify";
    const verified = await exec(transport, commands.verify, deps.checkTimeoutMs ?? 120_000, signal);
    if (signal.aborted) throw new Error("stopped by user");
    if (verified.exitCode !== 0 || !verified.stdout.trim()) throw new Error("download verification failed");
    acquired = false;
    recordStep(db, job.id, step, "done", cleanOutput(verified.stdout.trim()) + (confirmed.sha256 === null ? "\nunverified" : "\nchecksum verified"));
    setJobState(db, job.id, "done");
  } catch (err) {
    recordStep(db, job.id, step, signal.aborted ? "stopped" : "failed", signal.aborted ? "stopped by user" : (err as Error).message);
    setJobState(db, job.id, signal.aborted ? "stopped" : "failed", signal.aborted ? "stopped by user" : (err as Error).message);
  } finally {
    if (acquired && commands && transport) {
      try {
        const cleaned = await exec(transport, commands.cleanup, deps.checkTimeoutMs ?? 120_000);
        if (cleaned.exitCode !== 0) recordStep(db, job.id, "cleanup", "failed", "could not remove partial download");
      } catch { recordStep(db, job.id, "cleanup", "failed", "could not remove partial download"); }
    }
  }
}

export class Runner {
  private readonly active = new Map<string, { id: number; controller: AbortController }>();
  readonly db: Db;
  readonly deps: RunnerDeps;
  constructor(db: Db, deps: RunnerDeps) {
    this.db = db;
    this.deps = deps;
    failInterruptedJobs(db);
    for (const m of deps.machines) void this.pump(m.id);
  }
  wake(): void { for (const m of this.deps.machines) void this.pump(m.id); }
  stop(id: number): boolean {
    const job = jobById(this.db, id);
    if (!job || !stopJob(this.db, id)) return false;
    if (this.active.get(job.machineId)?.id === id) this.active.get(job.machineId)?.controller.abort();
    this.wake();
    return true;
  }
  private async pump(machineId: string): Promise<void> {
    if (this.active.has(machineId)) return;
    if (!this.deps.machines.some((machine) => machine.id === machineId)) return;
    const job = claimNext(this.db, machineId);
    if (!job) return;
    const controller = new AbortController();
    this.active.set(machineId, { id: job.id, controller });
    try {
      await runJob(this.db, job, this.deps, controller.signal);
      if (jobById(this.db, job.id)?.state === "failed") stopBatch(this.db, job.batchId);
    } finally {
      this.active.delete(machineId);
      void this.pump(machineId);
    }
  }
  jobs(limit = 50): { jobs: Job[]; active: number } { return { jobs: listJobs(this.db, limit), active: this.active.size }; }
}
