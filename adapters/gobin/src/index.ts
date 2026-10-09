import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list every executable in GOBIN (or `go env GOPATH`/bin) as one tab-separated line:
// `<file>\t<main package path>\t<module path>\t<module version>`. The script text is byte-identical to
// tools/probes/macos/gobin.sh. `go version -m` prints nothing for a binary it cannot read, so the last three
// fields are then empty. The probe is optional because go may not be installed.

const GOBIN_SH = "d=\"${GOBIN:-$(go env GOPATH)/bin}\"\nfor f in \"$d\"/*; do\n  [ -f \"$f\" ] && [ -x \"$f\" ] || continue\n  printf '%s\\t' \"$f\"\n  go version -m \"$f\" 2>/dev/null | awk -F'\\t' '$2==\"path\"{p=$3} $2==\"mod\"{m=$3; v=$4} END{printf \"%s\\t%s\\t%s\", p, m, v}'\n  echo\ndone\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The final path segment of an absolute path. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

export const adapter: Adapter = {
  sourceKind: "gobin",
  os: ["macos"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", GOBIN_SH], optional: true }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "gobin", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 && probe.stdout.trim() === "") {
      return {
        sourceKind: "gobin",
        location,
        status: "skipped",
        installs: [],
        message: `go did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const parts = line.split("\t");
      if (parts.length < 2) {
        skipped++;
        continue;
      }
      const file = parts[0] ?? "";
      if (file === "") {
        skipped++;
        continue;
      }
      const pkg = (parts[1] ?? "").trim();
      const module = (parts[2] ?? "").trim();
      const version = (parts[3] ?? "").trim();
      installs.push({
        ecosystem: "go-bin",
        key: module !== "" ? module : pkg !== "" ? pkg : file,
        name: baseName(file),
        kind: "binary",
        version: version !== "" ? version : null,
        location: file,
        details: {
          package: pkg !== "" ? pkg : null,
          module,
        },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "gobin", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "gobin", location, status: "ok", installs };
  },
};
