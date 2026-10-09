import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

function result(status: ScanResult["status"], installs: InstallRecord[], message?: string): ScanResult {
  return { sourceKind: "python", location: "", status, installs, ...(message === undefined ? {} : { message }) };
}

export const adapter: Adapter = {
  sourceKind: "python",
  os: ["windows"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["py.exe", "-0p"], optional: true }];
  },
  parse(outputs: ProbeOutputs): ScanResult {
    const output = outputs["list"];
    if (!output) return result("failed", [], "probe output missing");
    if (output.exitCode !== 0 && output.stdout.trim() === "") {
      return result("skipped", [], `python launcher did not run (exit ${output.exitCode}): ${output.stderr.replace(/\r/g, "").trim().split("\n")[0] ?? ""}`);
    }
    const installs: InstallRecord[] = [];
    let malformed = 0;
    for (const line of output.stdout.split("\n").map((part) => part.replace(/\r/g, ""))) {
      if (line.trim() === "") continue;
      const match = /^\s*-V:([^\s]+)\s+(\*)?\s*(.+python\.exe)\s*$/i.exec(line);
      if (!match) {
        malformed++;
        continue;
      }
      const tag = match[1]!;
      const marker = match[2] ?? "";
      const path = match[3]!;
      const slash = tag.indexOf("/");
      const vendor = slash >= 0 ? tag.slice(0, slash) : null;
      let version: string | null = null;
      if (/^\d/.test(tag)) version = tag;
      else if (vendor !== null) {
        const cpython = /CPython(\d+(?:\.\d+)*)/.exec(tag.slice(slash + 1));
        version = cpython?.[1] ?? null;
      }
      installs.push({
        ecosystem: "python",
        key: tag,
        name: `Python ${tag}`,
        kind: "runtime",
        version,
        location: path,
        details: { default: marker === "*", vendor },
      });
    }
    return malformed > 0
      ? result("partial", installs, `skipped ${malformed} malformed row${malformed === 1 ? "" : "s"}`)
      : result("ok", installs);
  },
};
