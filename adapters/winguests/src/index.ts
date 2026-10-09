import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// This string is byte-identical to tools/probes/windows/wsl.ps1.
const WSL_SCRIPT = "$env:WSL_UTF8 = 1\nwsl.exe --list --verbose\n";

function result(sourceKind: string, status: ScanResult["status"], installs: InstallRecord[], message?: string): ScanResult {
  return { sourceKind, location: "", status, installs, ...(message === undefined ? {} : { message }) };
}

function lines(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.replace(/\r/g, ""));
}

function unavailable(source: string, output: ProbeOutputs[string] | undefined): ScanResult | null {
  if (!output) return result(source, "failed", [], "probe output missing");
  if (output.exitCode === 0 || output.stdout.trim() !== "") return null;
  const message = output.stderr.replace(/\r/g, "").trim().split("\n")[0] ?? "";
  return result(source, "skipped", [], `probe did not run (exit ${output.exitCode}): ${message}`);
}

function partial(source: string, installs: InstallRecord[], malformed: number): ScanResult {
  return malformed > 0
    ? result(source, "partial", installs, `skipped ${malformed} malformed row${malformed === 1 ? "" : "s"}`)
    : result(source, "ok", installs);
}

export const wslAdapter: Adapter = {
  sourceKind: "wsl",
  os: ["windows"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", WSL_SCRIPT] }];
  },
  parse(outputs: ProbeOutputs): ScanResult {
    const output = outputs["list"];
    const unavailableResult = unavailable("wsl", output);
    if (unavailableResult) return unavailableResult;
    const installs: InstallRecord[] = [];
    let malformed = 0;
    for (const line of lines(output!.stdout).slice(1)) {
      if (line.trim() === "") continue;
      const match = /^\s*(\*?)\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
      if (!match) {
        malformed++;
        continue;
      }
      const marker = match[1]!;
      const name = match[2]!;
      const state = match[3]!;
      const version = match[4]!;
      installs.push({
        ecosystem: "wsl-distro",
        key: name,
        name,
        kind: "vm",
        version: null,
        location: "",
        details: { state, wslVersion: Number(version), default: marker === "*" },
      });
    }
    return partial("wsl", installs, malformed);
  },
};

export const sbxAdapter: Adapter = {
  sourceKind: "sbx",
  os: ["windows"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["sbx.exe", "ls"], optional: true }];
  },
  parse(outputs: ProbeOutputs): ScanResult {
    const output = outputs["list"];
    const unavailableResult = unavailable("sbx", output);
    if (unavailableResult) return unavailableResult;
    const rows = lines(output!.stdout);
    if (rows.every((line) => line.trim() === "")) return result("sbx", "ok", []);
    const header = rows.find((line) => line.trim() !== "");
    const offsets = header ? ["SANDBOX", "AGENT", "STATUS", "PORTS", "WORKSPACE"].map((name) => header.indexOf(name)) : [];
    if (offsets.length !== 5 || offsets.some((offset) => offset < 0)) return result("sbx", "failed", [], "sandbox output header is malformed");
    const installs: InstallRecord[] = [];
    let malformed = 0;
    let skippedHeader = false;
    for (const line of rows) {
      if (line.trim() === "") continue;
      if (!skippedHeader) {
        skippedHeader = true;
        continue;
      }
      const name = line.slice(offsets[0], offsets[1]).trim();
      const agent = line.slice(offsets[1], offsets[2]).trim();
      const status = line.slice(offsets[2], offsets[3]).trim();
      const ports = line.slice(offsets[3], offsets[4]).trim();
      const workspace = line.slice(offsets[4]).trim();
      if (!name || !agent || !status) {
        malformed++;
        continue;
      }
      installs.push({
        ecosystem: "sbx",
        key: name,
        name,
        kind: "vm",
        version: null,
        location: workspace,
        details: { agent, status, ports: ports || null },
      });
    }
    return partial("sbx", installs, malformed);
  },
};
