import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list every dpkg package as `<package>\t<version>\t<status abbrev>\t<architecture>`. The script
// text is byte-identical to tools/probes/linux/dpkg.sh. Only packages the status abbreviation marks `ii`
// (installed) are reported; removed, half-installed and other states are skipped silently.

const DPKG_SH = "dpkg-query -W -f='${Package}\\t${Version}\\t${db:Status-Abbrev}\\t${Architecture}\\t${binary:Summary}\\n'\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

export const adapter: Adapter = {
  sourceKind: "dpkg",
  os: ["linux"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", DPKG_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "dpkg", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0) {
      return {
        sourceKind: "dpkg",
        location,
        status: "skipped",
        installs: [],
        message: `dpkg-query did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
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
      const name = parts[0] ?? "";
      const version = parts[1] ?? "";
      const status = parts[2] ?? "";
      const arch = parts[3] ?? "";
      const summary = (parts[4] ?? "").trim();
      if (status.trim() !== "ii") continue;
      installs.push({
        ecosystem: "dpkg",
        key: name,
        name,
        kind: "package",
        version: version !== "" ? version : null,
        location: "",
        ...(summary !== "" ? { description: summary } : {}),
        details: { arch },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "dpkg", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "dpkg", location, status: "ok", installs };
  },
};
