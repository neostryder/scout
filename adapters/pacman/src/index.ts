import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: `pacman -Qi` describes every installed package in a block of "Field : value" lines, and `pacman -Qmq`
// lists the foreign ones, which are the packages no sync database carries, usually built from the AUR or locally.
// `checkupdates` (pacman-contrib, which syncs a private copy of the databases) and `yay -Qua` list what an update
// would change as "name old -> new", which becomes the version each package row can be updated to. Arch cannot upgrade one
// package alone, so updating any row runs the whole-system update (see planUpdate).
// The script text is byte-identical to tools/probes/linux/pacman.sh. LC_ALL=C keeps the field names in English.

// `pacman -Qmq` exits 1 when no foreign package exists, so the script exits with the status of `pacman -Qi` alone.
const PACMAN_SH = "LC_ALL=C pacman -Qi 2>/dev/null\nrc=$?\necho \"---SCOUT-FOREIGN---\"\nLC_ALL=C pacman -Qmq 2>/dev/null\necho \"---SCOUT-PENDING---\"\nif command -v checkupdates >/dev/null 2>&1; then\n  LC_ALL=C timeout 50 checkupdates 2>/dev/null\n  echo \"exit=$?\"\nfi\necho \"---SCOUT-AUR---\"\nif command -v yay >/dev/null 2>&1; then\n  LC_ALL=C timeout 50 yay -Qua 2>/dev/null\n  echo \"exit=$?\"\nfi\necho \"---SCOUT-UPGRADED---\"\ngrep 'starting full system upgrade' /var/log/pacman.log 2>/dev/null | tail -n 1\necho \"---SCOUT-NOW---\"\ndate +%Y-%m-%dT%H:%M:%S\nexit $rc\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** "chromium 154.0.8037.97-1 -> 155.0.8059.84-1" lines become package name to the version an update brings. */
export function pendingVersions(lines: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of lines) {
    const match = /^(\S+)\s+\S+\s+->\s+(\S+)/.exec(line.trim());
    if (match) found.set(match[1]!, match[2]!);
  }
  return found;
}

// A section is the text after its marker line up to the next marker. The "exit=N" line the script prints after a tool says whether the tool ran.
function section(text: string, marker: string): string | null {
  const match = new RegExp(`^---SCOUT-${marker}---\\n([\\s\\S]*?)(?=^---SCOUT-|(?![\\s\\S]))`, "m").exec(text);
  return match ? match[1]! : null;
}
function listing(body: string | null, okExits: number[]): string[] | null {
  if (body === null) return null;
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  const exit = /^exit=(\d+)$/.exec(lines.at(-1) ?? "");
  if (!exit || !okExits.includes(Number(exit[1]))) return null;
  return lines.slice(0, -1);
}

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
    const text = probe.stdout.replaceAll("\r\n", "\n");
    const [details = "", rest = ""] = text.split(/^---SCOUT-FOREIGN---$/m);
    const foreign = new Set((rest.split(/^---SCOUT-PENDING---$/m)[0] ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
    // checkupdates exits 0 with updates, 2 with none; yay -Qua exits 0 with updates, 1 with none. A tool that failed or is missing says nothing about its packages.
    const pending = new Map([...pendingVersions(listing(section(text, "PENDING"), [0, 2]) ?? []), ...pendingVersions(listing(section(text, "AUR"), [0, 1]) ?? [])]);
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
        details: { arch, reason, ...(pending.has(name) ? { availableVersion: pending.get(name) } : {}) },
      });
    }
    if (skipped > 0) {
      return { sourceKind: "pacman", location, status: "partial", installs, message: `skipped ${skipped} malformed block(s)` };
    }
    return { sourceKind: "pacman", location, status: "ok", installs };
  },
};
