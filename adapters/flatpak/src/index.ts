import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: `flatpak list --app` describes every installed app as a tab separated row of application, name, version,
// branch, origin, installation and description, and `flatpak remote-ls --updates` lists the rows an update would bring.
// The script text is byte-identical to tools/probes/linux/flatpak.sh. LC_ALL=C keeps the column names in English.
// A machine without flatpak exits 127 with one line on stderr, and an empty user installation exits 0 with no rows.

const FLATPAK_SH = "command -v flatpak >/dev/null 2>&1 || { echo \"flatpak is not installed\" >&2; exit 127; }\nexport LC_ALL=C\nfor inst in system user; do\n  echo \"---SCOUT-LIST-$inst---\"\n  flatpak list --app --$inst --columns=application,name,version,branch,origin,installation,description 2>/dev/null\n  echo \"exit=$?\"\n  echo \"---SCOUT-UPDATES-$inst---\"\n  if command -v timeout >/dev/null 2>&1; then\n    timeout 60 flatpak remote-ls --$inst --updates --app --columns=application,version,branch,origin 2>/dev/null\n  else\n    flatpak remote-ls --$inst --updates --app --columns=application,version,branch,origin 2>/dev/null\n  fi\n  echo \"exit=$?\"\ndone\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

export interface PendingUpdate {
  version: string;
  branch: string;
  origin: string;
}

/** A row needs four columns and an application id; anything shorter is malformed. */
function malformed(line: string): boolean {
  const parts = line.split("\t");
  return parts.length < 4 || (parts[0] ?? "").trim() === "";
}

/**
 * "application\tversion\tbranch\torigin" rows become the version an app can move to, keyed by application, branch and
 * origin, so an update counts only for the app it names.
 */
export function pendingUpdates(lines: string[]): Map<string, PendingUpdate> {
  const found = new Map<string, PendingUpdate>();
  for (const line of lines) {
    if (malformed(line)) continue;
    const parts = line.split("\t");
    const application = (parts[0] ?? "").trim();
    const branch = parts[2] ?? "";
    const origin = parts[3] ?? "";
    found.set(`${application}\t${branch}\t${origin}`, { version: parts[1] ?? "", branch, origin });
  }
  return found;
}

// A section is the text after its marker line up to the next marker. The "exit=N" line the script prints after a tool says whether that tool ran.
function section(text: string, marker: string): string | null {
  const match = new RegExp(`^---SCOUT-${marker}---\\n([\\s\\S]*?)(?=^---SCOUT-|(?![\\s\\S]))`, "m").exec(text);
  return match ? match[1]! : null;
}

/** The rows of a section whose tool ran: the body without the "exit=N" line the script prints after it. */
function listing(body: string | null): string[] {
  if (body === null) return [];
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  const exit = /^exit=(\d+)$/.exec((lines.at(-1) ?? "").trim());
  if (!exit || Number(exit[1]) !== 0) return [];
  return lines.slice(0, -1);
}

export const adapter: Adapter = {
  sourceKind: "flatpak",
  os: ["linux"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", FLATPAK_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "flatpak", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 || probe.stdout.trim() === "") {
      return { sourceKind: "flatpak", location, status: "skipped", installs: [], message: `flatpak did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}` };
    }
    const text = probe.stdout.replaceAll("\r\n", "\n");
    const installs: InstallRecord[] = [];
    let skipped = 0;
    // Each installation has its own listing and its own update listing, so an update counts only for the scope it was listed in.
    for (const scope of ["system", "user"]) {
      const listed = listing(section(text, `LIST-${scope}`));
      const updates = listing(section(text, `UPDATES-${scope}`));
      skipped += updates.filter(malformed).length;
      const pending = pendingUpdates(updates);
      for (const line of listed) {
        if (malformed(line)) {
          skipped++;
          continue;
        }
        const parts = line.split("\t");
        const application = (parts[0] ?? "").trim();
        const name = parts[1] ?? "";
        const version = parts[2] ?? "";
        const branch = parts[3] ?? "";
        const origin = parts[4] ?? "";
        const installation = parts[5] ?? "";
        const description = parts[6] ?? "";
        const update = pending.get(`${application}\t${branch}\t${origin}`);
        // A remote listing of the same version is a rebuild of that version, not an update.
        const availableVersion = update && update.version !== "" && update.version !== version ? update.version : "";
        installs.push({
          ecosystem: "flatpak",
          key: application,
          name,
          kind: "app",
          version: version !== "" ? version : null,
          location: installation,
          ...(description !== "" ? { description } : {}),
          details: { origin, branch, installation, ...(availableVersion !== "" ? { availableVersion } : {}) },
        });
      }
    }
    if (skipped > 0) {
      return { sourceKind: "flatpak", location, status: "partial", installs, message: `skipped ${skipped} malformed line(s)` };
    }
    return { sourceKind: "flatpak", location, status: "ok", installs };
  },
};
