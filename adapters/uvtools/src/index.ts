import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list the uv tools installed for the current user. Each tool is a header `<name> v<version>`
// followed by one `- <executable>` line per executable it installs. A header with no version cannot name an
// install, so it is skipped and makes the result partial. The probe is optional because uv may not be installed.

const LIST_ARGV = ["uv", "tool", "list"];

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

interface ToolInProgress {
  install: InstallRecord;
  executables: string[];
}

export const adapter: Adapter = {
  sourceKind: "uvtool",
  os: ["macos", "windows"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: LIST_ARGV, optional: true }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "uvtool", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 && probe.stdout.trim() === "") {
      return {
        sourceKind: "uvtool",
        location,
        status: "skipped",
        installs: [],
        message: `uv did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    let current: ToolInProgress | null = null;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      if (line.startsWith("- ")) {
        if (current === null) {
          skipped++;
          continue;
        }
        current.executables.push(line.slice(2).trim());
        continue;
      }
      const marker = line.lastIndexOf(" v");
      const name = marker < 0 ? "" : line.slice(0, marker).trim();
      const version = marker < 0 ? "" : line.slice(marker + 2).trim();
      if (name === "" || version === "") {
        skipped++;
        current = null;
        continue;
      }
      const executables: string[] = [];
      const install: InstallRecord = {
        ecosystem: "uv-tool",
        key: name,
        name,
        kind: "package",
        version,
        location: "",
        details: { executables },
      };
      installs.push(install);
      current = { install, executables };
    }
    if (skipped > 0) {
      return { sourceKind: "uvtool", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "uvtool", location, status: "ok", installs };
  },
};
