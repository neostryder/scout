import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list every executable in `~/.local/bin`, `~/.cargo/bin` and `~/go/bin` as one tab-separated line:
// `<file>\t<symlink target>`. The target is empty when the file is not a symlink. The script text is
// byte-identical to tools/probes/macos/localbin.sh. The parent folder names which of the three bins it is.

const LOCALBIN_SH = "for d in \"$HOME/.local/bin\" \"$HOME/.cargo/bin\" \"$HOME/go/bin\"; do\n  [ -d \"$d\" ] || continue\n  for f in \"$d\"/*; do\n    [ -f \"$f\" ] && [ -x \"$f\" ] || continue\n    printf '%s\\t%s\\n' \"$f\" \"$(readlink \"$f\")\"\n  done\ndone\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The final path segment of an absolute path. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Which of the three bins a file came from, read from the folder above its `bin` directory. */
function directoryOf(file: string): string | null {
  const parts = file.split("/");
  const parent = parts[parts.length - 3] ?? "";
  if (parent === ".local") return "local-bin";
  if (parent === ".cargo") return "cargo-bin";
  if (parent === "go") return "go-bin";
  return null;
}

export const adapter: Adapter = {
  sourceKind: "localbin",
  os: ["macos"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", LOCALBIN_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "localbin", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 && probe.stdout.trim() === "") {
      return {
        sourceKind: "localbin",
        location,
        status: "skipped",
        installs: [],
        message: `local bin did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}`,
      };
    }
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const line of probe.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const tab = line.indexOf("\t");
      if (tab < 0) {
        skipped++;
        continue;
      }
      const file = line.slice(0, tab);
      if (file === "") {
        skipped++;
        continue;
      }
      const target = line.slice(tab + 1);
      installs.push({
        ecosystem: "binary",
        key: file,
        name: baseName(file),
        kind: "binary",
        version: null,
        location: file,
        details: {
          linkTarget: target !== "" ? target : null,
          directory: directoryOf(file),
        },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "localbin", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "localbin", location, status: "ok", installs };
  },
};
