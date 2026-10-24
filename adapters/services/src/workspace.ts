import { redactUser, workspacePathIn, type ProbeOutputs, type WorkspaceAdapter, type WorkspaceInstallFact, type WorkspaceInstallKind, type WorkspaceInstallResult } from "@scout/core";
import { LINUX_WORKSPACE_SCRIPT, MAC_WORKSPACE_SCRIPT, WINDOWS_WORKSPACE_SCRIPT } from "./workspace-probes.ts";

const result = (origin: string, status: WorkspaceInstallResult["status"], facts: WorkspaceInstallFact[] = [], message?: string): WorkspaceInstallResult => ({ origin, status, facts, ...(message === undefined ? {} : { message }) });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const WINDOWS_KINDS = new Set<string>(["windows-service", "scheduled-task", "run-key", "startup-folder"]);
const MARKER = "---SCOUT-ITEM---";

function unavailable(outputs: ProbeOutputs, origin: string): WorkspaceInstallResult | null {
  const probe = outputs["workspace"];
  if (!probe) return result(origin, "failed", [], "probe output missing");
  if (probe.exitCode === 127 || probe.exitCode === 9009) return result(origin, "skipped", [], "workspace probe did not run");
  if (probe.exitCode !== 0 && !probe.stdout.trim()) return result(origin, "failed", [], "workspace probe did not run");
  return null;
}

function add(facts: Map<string, WorkspaceInstallFact>, fact: WorkspaceInstallFact): void {
  facts.set(JSON.stringify([fact.kind, fact.location, fact.name]), fact);
}

function locationOf(text: string): string {
  return redactUser(text.replaceAll("\\", "/"));
}

export const windowsWorkspaceAdapter: WorkspaceAdapter = {
  origin: "workspace-windows",
  os: ["windows"],
  probes() {
    return [{ id: "workspace", argv: ["pwsh", "-NoProfile", "-Command", WINDOWS_WORKSPACE_SCRIPT] }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "workspace-windows");
    if (missing) return missing;
    const probe = outputs["workspace"]!;
    let doc: unknown;
    try { doc = probe.stdout.trim() ? JSON.parse(probe.stdout) : []; }
    catch { return result("workspace-windows", "failed", [], "workspace output is not valid JSON"); }
    const rows = Array.isArray(doc) ? doc : [doc];
    const facts = new Map<string, WorkspaceInstallFact>();
    let malformed = false;
    for (const row of rows) {
      if (!object(row) || typeof row["Kind"] !== "string" || !WINDOWS_KINDS.has(row["Kind"]) || typeof row["Name"] !== "string" || row["Name"].trim() === "" || typeof row["Command"] !== "string") { malformed = true; continue; }
      const workspacePath = workspacePathIn(row["Command"]);
      if (!workspacePath) continue;
      add(facts, { kind: row["Kind"] as WorkspaceInstallKind, name: row["Name"].trim(), location: typeof row["Location"] === "string" ? locationOf(row["Location"]) : "", workspacePath });
    }
    const partial = malformed || probe.exitCode !== 0;
    return result("workspace-windows", partial ? facts.size ? "partial" : "failed" : "ok", [...facts.values()], partial ? "some workspace entries could not be read" : undefined);
  },
};

function unixAdapter(origin: string, os: "macos" | "linux", script: string, kinds: ReadonlySet<string>): WorkspaceAdapter {
  return {
    origin,
    os: [os],
    probes() {
      return [{ id: "workspace", argv: ["/bin/sh", "-c", script] }];
    },
    parse(outputs) {
      const missing = unavailable(outputs, origin);
      if (missing) return missing;
      const probe = outputs["workspace"]!;
      const facts = new Map<string, WorkspaceInstallFact>();
      let malformed = false;
      for (const block of probe.stdout.split(MARKER).slice(1)) {
        const newline = block.indexOf("\n");
        const head = (newline === -1 ? block : block.slice(0, newline)).split("\t");
        const kind = head[0]?.trim() ?? "";
        const file = head[1]?.trim() ?? "";
        if (!kinds.has(kind) || file === "") { malformed = true; continue; }
        const workspacePath = workspacePathIn(newline === -1 ? "" : block.slice(newline + 1));
        if (!workspacePath) continue;
        const location = locationOf(file);
        add(facts, { kind: kind as WorkspaceInstallKind, name: location.slice(location.lastIndexOf("/") + 1), location, workspacePath });
      }
      const partial = malformed || probe.exitCode !== 0;
      return result(origin, partial ? facts.size ? "partial" : "failed" : "ok", [...facts.values()], partial ? "some workspace entries could not be read" : undefined);
    },
  };
}

export const macWorkspaceAdapter = unixAdapter("workspace-macos", "macos", MAC_WORKSPACE_SCRIPT, new Set(["launchd"]));
export const linuxWorkspaceAdapter = unixAdapter("workspace-linux", "linux", LINUX_WORKSPACE_SCRIPT, new Set(["systemd", "autostart"]));
