import type { Adapter, InstallRecord, ScanResult } from "@scout/core";

// Reads installed packages through the Microsoft.WinGet.Client cmdlets. The module must be installed
// (Install-PSResource Microsoft.WinGet.Client -Scope CurrentUser); when it is not, the scan is skipped.
const SCRIPT = `Import-Module Microsoft.WinGet.Client -ErrorAction Stop
$rows = Get-WinGetPackage | Select-Object Id, Name, InstalledVersion, Source, IsUpdateAvailable, @{ n = 'AvailableVersion'; e = { $_.AvailableVersions | Select-Object -First 1 } }
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress
`;

const result = (status: ScanResult["status"], installs: InstallRecord[], message?: string): ScanResult => ({
  sourceKind: "winget",
  location: "",
  status,
  installs,
  ...(message === undefined ? {} : { message }),
});

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export const adapter: Adapter = {
  sourceKind: "winget",
  os: ["windows"],
  probes() {
    return [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", SCRIPT] }];
  },
  parse(outputs) {
    const out = outputs["list"];
    if (!out) return result("failed", [], "probe output missing");
    if (out.exitCode !== 0) {
      return result("skipped", [], `winget module did not run (exit ${out.exitCode}): ${out.stderr.trim().split("\n")[0] ?? ""}`);
    }
    let rows: unknown = [];
    if (out.stdout.trim() !== "") {
      try {
        rows = JSON.parse(out.stdout);
      } catch {
        return result("failed", [], "winget output is not valid JSON");
      }
    }
    if (rows === null) rows = [];
    if (!Array.isArray(rows)) rows = [rows];
    const installs: InstallRecord[] = [];
    let skipped = 0;
    for (const row of rows as unknown[]) {
      const r = row as Record<string, unknown> | null;
      const id = r && typeof r === "object" ? text(r["Id"]) : null;
      if (!r || id === null) {
        skipped++;
        continue;
      }
      const source = text(r["Source"]);
      const installed = text(r["InstalledVersion"]);
      installs.push({
        // Catalog matches keep their source as the ecosystem; ARP and MSIX entries winget could not match stay apart.
        ecosystem: source ?? "winget-local",
        key: id,
        name: text(r["Name"]) ?? id,
        kind: "package",
        version: installed === null || installed === "Unknown" ? null : installed,
        location: "",
        details: {
          source,
          updateAvailable: r["IsUpdateAvailable"] === true,
          availableVersion: text(r["AvailableVersion"]),
        },
      });
    }
    return skipped > 0
      ? result("partial", installs, `skipped ${skipped} malformed row${skipped === 1 ? "" : "s"}`)
      : result("ok", installs);
  },
};
