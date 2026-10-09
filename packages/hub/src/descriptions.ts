import { descriptionsOverview, listProjectDescriptions, projectErrorKind, runProjectDescriptions, runPublicDescriptions, type Db, type DescriptionProgress, type ModelRunner } from "@scout/core";
import type { ProjectDescriptionSource } from "./descriptions-project.ts";

export function idleDescriptionStatus(): DescriptionProgress {
  return { scope: "public", state: "idle", done: 0, total: 0, applied: 0, error: null, at: null };
}

export class DescriptionRun {
  private db: Db;
  private model: ModelRunner;
  private modelLabel: string | undefined;
  private progress = idleDescriptionStatus();
  private listeners = new Set<(event: DescriptionProgress) => void>();
  private project: ProjectDescriptionSource | undefined;
  private probeAt = -Infinity;
  private probeState: "ready" | "busy" | "off" = "ready";
  private probePending: Promise<void> | null = null;
  private now: () => number;
  private wait: ((ms: number) => Promise<void>) | undefined;
  private projectStarting = false;

  constructor(db: Db, options: { model: ModelRunner; modelLabel?: string; project?: ProjectDescriptionSource; now?: () => number; wait?: (ms: number) => Promise<void> }) {
    this.db = db;
    this.model = options.model;
    this.modelLabel = options.modelLabel;
    this.project = options.project;
    this.now = options.now ?? Date.now;
    this.wait = options.wait;
  }

  status(): DescriptionProgress {
    return { ...this.progress };
  }

  subscribe(listener: (event: DescriptionProgress) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(scope: "project"): Promise<{ started: true } | { started: false; reason: "running" | "busy" }>;
  start(scope: "public"): { started: true } | { started: false; reason: "running" };
  start(scope: "public" | "project"): { started: true } | { started: false; reason: "running" } | Promise<{ started: true } | { started: false; reason: "running" | "busy" }> {
    if (scope === "project") return this.startProject();
    if (scope !== "public") throw new Error("project descriptions are off");
    if (this.progress.state === "running" || this.projectStarting) return { started: false, reason: "running" };
    this.progress = { ...idleDescriptionStatus(), state: "running", at: new Date().toISOString() };
    void this.execute();
    return { started: true };
  }

  async overview() {
    const overview = descriptionsOverview(this.db);
    const source = this.project;
    const projects = source ? listProjectDescriptions(this.db, source.projects()) : [];
    const counts = { todo: projects.filter((project) => project.hashState !== "unchanged" || !project.text).length, roots: projects.length, lastRunAt: overview.project.lastRunAt };
    if (!source?.client) return { ...overview, project: { state: "off", ...counts, reason: source?.reason ?? "not configured" } };
    await this.cachedProbe();
    return { ...overview, project: { state: this.probeState, ...counts, reason: source.reason } };
  }

  private async cachedProbe(): Promise<void> {
    if (this.probePending) return this.probePending;
    if (this.now() - this.probeAt < 30_000) return;
    this.probeAt = this.now();
    this.probePending = (async () => {
      try { await this.project!.client!.probe(); this.probeState = "ready"; this.project!.reason = null; }
      catch (error) {
        const kind = projectErrorKind(error);
        this.probeState = kind === "busy" || kind === "deferred" ? "busy" : "off";
        this.project!.reason = this.probeState === "busy" ? null : "Cogitator is not running";
      }
    })();
    try { await this.probePending; } finally { this.probePending = null; }
  }

  private async startProject(): Promise<{ started: true } | { started: false; reason: "running" | "busy" }> {
    if (!this.project?.client) throw new Error("project descriptions are off");
    if (this.progress.state === "running" || this.projectStarting) return { started: false, reason: "running" };
    this.projectStarting = true;
    try {
      await this.cachedProbe();
      if (this.probeState === "off") throw new Error("project descriptions are off");
      if (this.probeState === "busy") return { started: false, reason: "busy" };
      this.progress = { ...idleDescriptionStatus(), scope: "project", state: "running", at: new Date().toISOString() };
      void this.execute("project");
      return { started: true };
    } finally { this.projectStarting = false; }
  }

  private emit(progress: DescriptionProgress): void {
    this.progress = { ...progress };
    for (const listener of this.listeners) {
      try { listener(this.status()); } catch { /* One page must not stop the run. */ }
    }
  }

  private async execute(scope: "public" | "project" = "public"): Promise<void> {
    try {
      if (scope === "project") await runProjectDescriptions(this.db, this.project!.projects(), this.project!.client!, { wait: this.wait, onProgress: (progress) => this.emit(progress) });
      else await runPublicDescriptions(this.db, this.model, { modelLabel: this.modelLabel, onProgress: (progress) => this.emit(progress) });
    } catch {
      this.emit({ ...this.progress, state: "failed", error: "description run failed", at: new Date().toISOString() });
    }
  }
}
