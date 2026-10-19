import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: `pacman -Qi` describes every installed package in a block of "Field : value" lines, and `pacman -Qmq`
// lists the foreign ones, which are the packages no sync database carries, usually built from the AUR or locally.
// The script text is byte-identical to tools/probes/linux/pacman.sh. LC_ALL=C keeps the field names in English.

// `pacman -Qmq` exits 1 when no foreign package exists, so the script exits with the status of `pacman -Qi` alone.
const PACMAN_SH = 'LC_ALL=C pacman -Qi 2>/dev/null\nrc=$?\necho "---SCOUT-FOREIGN---"\nLC_ALL=C pacman -Qmq 2>/dev/null\nexit $rc\n';

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
const NONE = new Set(["", "None", "N/A"]);

export const adapter: Adapter = {
  sourceKind: "pacman",
  os: ["linux"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", PACMAN_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "pacman", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 || probe.stdout.trim() === "") {
      return { sourceKind: "pacman", location, status: "skipped", installs: [], message: `pacman did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}` };
    }
    const [details = "", foreignList = ""] = probe.stdout.replaceAll("\r\n", "\n").split(/^---SCOUT-FOREIGN---$/m);
    const foreign = new Set(foreignList.split("\n").map((line) => line.trim()).filter(Boolean));
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const block of details.split(/\n\s*\n/)) {
      if (block.trim() === "") continue;
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const match = /^([A-Za-z][A-Za-z ]*?)\s*:\s?(.*)$/.exec(line);
        if (match && !fields.has(match[1]!)) fields.set(match[1]!, match[2]!.trim());
      }
      const name = fields.get("Name") ?? "";
      if (name === "") {
        skipped++;
        continue;
      }
      const version = fields.get("Version") ?? "";
      const description = fields.get("Description") ?? "";
      const url = fields.get("URL") ?? "";
      const arch = fields.get("Architecture") ?? "";
      const reason = /^Explicitly/.test(fields.get("Install Reason") ?? "") ? "explicit" : "dependency";
      installs.push({
        ecosystem: foreign.has(name) ? "aur" : "pacman",
        key: name,
        name,
        kind: "package",
        version: version !== "" ? version : null,
        location: "",
        ...(!NONE.has(description) ? { description } : {}),
        ...(!NONE.has(url) ? { homepage: url } : {}),
        details: { arch, reason },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "pacman", location, status: "partial", installs, message: `skipped ${skipped} malformed block(s)` };
    }
    return { sourceKind: "pacman", location, status: "ok", installs };
  },
};
