import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list the .app bundles in /Applications and the user's Applications folder and print one tab-separated
// row per bundle. The script text is byte-identical to tools/probes/macos/apps.sh. The probe id is `apps`; the
// recording under fixtures/_raw/mini-app calls it `app`.

const APPS_SH = "for a in /Applications/*.app /Applications/*/*.app \"$HOME\"/Applications/*.app; do\n  [ -d \"$a\" ] || continue\n  p=\"$a/Contents/Info.plist\"; [ -f \"$p\" ] || continue\n  g() { /usr/libexec/PlistBuddy -c \"Print :$1\" \"$p\" 2>/dev/null; }\n  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$a\" \"$(g CFBundleIdentifier)\" \"$(g CFBundleShortVersionString)\" \"$(g CFBundleVersion)\" \"$(g SUFeedURL)\"\ndone\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The folder name without the trailing `.app`. */
function appName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

export const adapter: Adapter = {
  sourceKind: "app",
  os: ["macos"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "apps", argv: ["/bin/sh", "-c", APPS_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["apps"];
    if (!probe) return { sourceKind: "app", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0) {
      return {
        sourceKind: "app",
        location,
        status: "skipped",
        installs: [],
        message: `apps did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const parts = line.split("\t");
      if (parts.length !== 5) {
        skipped++;
        continue;
      }
      const path = parts[0] ?? "";
      const id = parts[1] ?? "";
      const short = parts[2] ?? "";
      const build = parts[3] ?? "";
      const feed = parts[4] ?? "";
      installs.push({
        ecosystem: "bundle",
        key: id === "" ? path : id,
        name: appName(path),
        kind: "app",
        version: short !== "" ? short : build !== "" ? build : null,
        location: path,
        details: {
          build: build !== "" ? build : null,
          sparkleFeed: feed !== "" ? feed : null,
          apple: id.startsWith("com.apple."),
        },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "app", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "app", location, status: "ok", installs };
  },
};
