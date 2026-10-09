import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list the pipx virtual environments as JSON. Each venv names its main package, its version and the
// paths of the apps it installed; the directory of the first app path is where the environment lives. The probe
// is optional because pipx may not be installed.

const LIST_ARGV = ["pipx", "list", "--json"];

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** A path without its final separator, so an app path becomes the directory holding it. "" when there is none. */
function directoryOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The first `__Path__` of an app_paths array, or "" when there is none. */
function firstAppPath(appPaths: unknown): string {
  if (!Array.isArray(appPaths) || appPaths.length === 0) return "";
  const first = appPaths[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return "";
  const path = (first as { __Path__?: unknown }).__Path__;
  return typeof path === "string" ? path : "";
}

export const adapter: Adapter = {
  sourceKind: "pipx",
  os: ["macos", "windows"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: LIST_ARGV, optional: true }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "pipx", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 && probe.stdout.trim() === "") {
      return {
        sourceKind: "pipx",
        location,
        status: "skipped",
        installs: [],
        message: `pipx did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    if (probe.stdout.trim() === "") {
      return { sourceKind: "pipx", location, status: "ok", installs: [] };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(probe.stdout);
    } catch {
      return { sourceKind: "pipx", location, status: "failed", installs: [], message: "pipx output is not valid JSON" };
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return { sourceKind: "pipx", location, status: "failed", installs: [], message: "pipx output is not an object" };
    }
    const venvs = (doc as { venvs?: unknown }).venvs;
    if (venvs !== undefined && (venvs === null || typeof venvs !== "object" || Array.isArray(venvs))) {
      return { sourceKind: "pipx", location, status: "failed", installs: [], message: "pipx venvs is not an object" };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const [name, entry] of Object.entries((venvs ?? {}) as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        skipped++;
        continue;
      }
      const metadata = (entry as { metadata?: unknown }).metadata;
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        skipped++;
        continue;
      }
      const main = (metadata as { main_package?: unknown }).main_package;
      if (main === null || typeof main !== "object" || Array.isArray(main)) {
        skipped++;
        continue;
      }
      const version = (main as { package_version?: unknown }).package_version;
      if (typeof version !== "string") {
        skipped++;
        continue;
      }
      const pkg = (main as { package?: unknown }).package;
      const pythonVersion = (metadata as { python_version?: unknown }).python_version;
      const appPath = firstAppPath((main as { app_paths?: unknown }).app_paths);
      installs.push({
        ecosystem: "pipx",
        key: name,
        name,
        kind: "package",
        version,
        location: appPath === "" ? "" : directoryOf(appPath),
        details: {
          package: typeof pkg === "string" ? pkg : null,
          pythonVersion: typeof pythonVersion === "string" ? pythonVersion : null,
        },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "pipx", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "pipx", location, status: "ok", installs };
  },
};
