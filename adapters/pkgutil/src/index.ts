import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list non-Apple receipts and print one tab-separated row per receipt (id, version, volume, location).
// The script text is byte-identical to tools/probes/macos/pkgutil.sh.

const PKGUTIL_SH = "for id in $(pkgutil --pkgs | grep -v '^com\\.apple\\.'); do\n  info=$(pkgutil --pkg-info \"$id\" 2>/dev/null)\n  v=$(printf '%s\\n' \"$info\" | sed -n 's/^version: //p')\n  vol=$(printf '%s\\n' \"$info\" | sed -n 's/^volume: //p')\n  loc=$(printf '%s\\n' \"$info\" | sed -n 's/^location: //p')\n  printf '%s\\t%s\\t%s\\t%s\\n' \"$id\" \"$v\" \"$vol\" \"$loc\"\ndone\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** Join a volume and a location relative to it, collapsing slashes. An empty location is just the volume. */
function joinLocation(volume: string, location: string): string {
  if (location === "") return volume;
  const base = volume.replace(/\/+$/, "");
  return (base + "/" + location).replace(/\/{2,}/g, "/");
}

export const adapter: Adapter = {
  sourceKind: "pkgutil",
  os: ["macos"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", PKGUTIL_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "pkgutil", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0) {
      return {
        sourceKind: "pkgutil",
        location,
        status: "skipped",
        installs: [],
        message: `pkgutil did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const parts = line.split("\t");
      if (parts.length !== 4) {
        skipped++;
        continue;
      }
      const id = parts[0] ?? "";
      const version = parts[1] ?? "";
      const volume = parts[2] ?? "";
      const loc = parts[3] ?? "";
      installs.push({
        ecosystem: "pkgutil",
        key: id,
        name: id,
        kind: "package",
        version: version !== "" ? version : null,
        location: joinLocation(volume, loc),
        details: { volume, location: loc },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "pkgutil", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "pkgutil", location, status: "ok", installs };
  },
};
