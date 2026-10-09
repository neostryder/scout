import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list system and user launchd plists and print each as `<path>\t<json>`. The script text is
// byte-identical to tools/probes/macos/launchd.sh. plutil emits nothing when it cannot read a plist, so such a
// line is a single path followed by a tab and parses as malformed.

const LAUNCHD_SH = "for f in /Library/LaunchDaemons/*.plist /Library/LaunchAgents/*.plist \"$HOME\"/Library/LaunchAgents/*.plist; do\n  [ -f \"$f\" ] || continue\n  printf '%s\\t' \"$f\"; plutil -convert json -o - \"$f\" 2>/dev/null | tr -d '\\n'; echo\ndone\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

interface Plist {
  Label?: unknown;
  Program?: unknown;
  ProgramArguments?: unknown;
  RunAtLoad?: unknown;
  KeepAlive?: unknown;
  Disabled?: unknown;
}

/** Where the plist lives, and therefore which launchd domain owns the job. */
function domainOf(path: string): string | null {
  if (path.startsWith("/Library/LaunchDaemons")) return "daemon";
  if (path.startsWith("/Library/LaunchAgents")) return "agent";
  if (path.includes("/Library/LaunchAgents")) return "user-agent";
  return null;
}

/** Program, else the first ProgramArguments entry, else null. */
function programOf(plist: Plist): string | null {
  if (typeof plist.Program === "string" && plist.Program !== "") return plist.Program;
  if (Array.isArray(plist.ProgramArguments)) {
    const first = plist.ProgramArguments[0];
    if (typeof first === "string" && first !== "") return first;
  }
  return null;
}

export const adapter: Adapter = {
  sourceKind: "launchd",
  os: ["macos"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", LAUNCHD_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "launchd", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0) {
      return {
        sourceKind: "launchd",
        location,
        status: "skipped",
        installs: [],
        message: `launchd did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const tab = line.indexOf("\t");
      const path = tab < 0 ? line : line.slice(0, tab);
      const json = tab < 0 ? "" : line.slice(tab + 1);
      let plist: Plist;
      try {
        plist = JSON.parse(json) as Plist;
      } catch {
        skipped++;
        continue;
      }
      if (plist === null || typeof plist !== "object" || Array.isArray(plist)) {
        skipped++;
        continue;
      }
      const label = plist.Label;
      if (typeof label !== "string" || label === "") {
        skipped++;
        continue;
      }
      installs.push({
        ecosystem: "launchd",
        key: label,
        name: label,
        kind: "service",
        version: null,
        location: path,
        details: {
          domain: domainOf(path),
          program: programOf(plist),
          runAtLoad: plist.RunAtLoad === true,
          keepAlive: plist.KeepAlive === true || (typeof plist.KeepAlive === "object" && plist.KeepAlive !== null),
          disabled: plist.Disabled === true,
        },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "launchd", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "launchd", location, status: "ok", installs };
  },
};
