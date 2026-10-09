import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list the globally installed npm packages and the global root they live under. Both probes are
// optional because npm may not be installed. The transport runs them locally or over ssh; the adapter only
// parses the recording.

const LS_ARGV = ["npm", "ls", "-g", "--json", "--depth=0"];
const ROOT_ARGV = ["npm", "root", "-g"];

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

interface NpmJson {
  dependencies?: unknown;
}

export const adapter: Adapter = {
  sourceKind: "npm",
  os: ["macos", "windows"],
  probes(ctx: ProbeContext, _location: string) {
    if (ctx.os === "windows") {
      return [
        { id: "ls", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", "npm ls -g --json --depth=0"], optional: true },
        { id: "root", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", "npm root -g"], optional: true },
      ];
    }
    return [
      { id: "ls", argv: LS_ARGV, optional: true },
      { id: "root", argv: ROOT_ARGV, optional: true },
    ];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const ls = outputs["ls"];
    if (!ls) return { sourceKind: "npm", location, status: "failed", installs: [], message: "probe output missing" };
    if (ls.exitCode !== 0 && ls.stdout.trim() === "") {
      return {
        sourceKind: "npm",
        location,
        status: "skipped",
        installs: [],
        message: `npm did not run (exit ${ls.exitCode}): ${firstLine(ls.stderr)}`,
      };
    }
    const rootProbe = outputs["root"];
    const root = rootProbe && rootProbe.exitCode === 0 ? rootProbe.stdout.trim() : location;

    let doc: NpmJson = {};
    if (ls.stdout.trim() !== "") {
      try {
        const parsed = JSON.parse(ls.stdout) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { sourceKind: "npm", location: root, status: "failed", installs: [], message: "npm output is not an object" };
        }
        doc = parsed as NpmJson;
      } catch {
        return { sourceKind: "npm", location: root, status: "failed", installs: [], message: "npm output is not valid JSON" };
      }
    }

    const deps = doc.dependencies;
    if (deps !== undefined && (deps === null || typeof deps !== "object" || Array.isArray(deps))) {
      return { sourceKind: "npm", location: root, status: "failed", installs: [], message: "npm dependencies is not an object" };
    }

    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const [name, dep] of Object.entries((deps ?? {}) as Record<string, unknown>)) {
      if (dep === null || typeof dep !== "object" || Array.isArray(dep)) {
        skipped++;
        continue;
      }
      const version = (dep as { version?: unknown }).version;
      if (typeof version !== "string") {
        skipped++;
        continue;
      }
      installs.push({
        ecosystem: "npm",
        key: name,
        name,
        kind: "package",
        version,
        location: root !== "" ? `${root}/${name}` : name,
      });
    }
    if (skipped > 0) {
      return { sourceKind: "npm", location: root, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "npm", location: root, status: "ok", installs };
  },
};
