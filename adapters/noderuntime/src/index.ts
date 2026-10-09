import type { Adapter, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: the Node.js that answers to `node` on this machine, for hosts where no package manager inventories it
// (a version switcher such as nvm4w keeps Node outside the winget and registry lists). Homebrew already lists Node on
// a Mac, so this source runs on Windows only. The probe prints the version, then the path of the running binary.

const PROBE = ["node", "-p", "[process.version, process.execPath].join(String.fromCharCode(10))"];

export const adapter: Adapter = {
  sourceKind: "noderuntime",
  os: ["windows"],
  probes() {
    return [{ id: "node", argv: PROBE, optional: true }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const out = outputs["node"];
    if (!out) return { sourceKind: "noderuntime", location, status: "failed", installs: [], message: "probe output missing" };
    if (out.exitCode !== 0 && out.stdout.trim() === "") return { sourceKind: "noderuntime", location, status: "skipped", installs: [], message: "node did not run" };
    const [version = "", path = ""] = out.stdout.trim().split(/\r?\n/).map((line) => line.trim());
    const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(version);
    if (!match || path === "") return { sourceKind: "noderuntime", location, status: "failed", installs: [], message: "node output is not a version and a path" };
    return {
      sourceKind: "noderuntime",
      location,
      status: "ok",
      installs: [{ ecosystem: "binary", key: "node", name: "Node.js", kind: "runtime", version: match[1] as string, location: path.replaceAll("\\", "/") }],
    };
  },
};
