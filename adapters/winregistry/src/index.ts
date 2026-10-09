import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";
import { MSI_SCRIPT } from "./msi-script.ts";

const script = "$paths = @(\n  @{ Hive = 'HKLM'; Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },\n  @{ Hive = 'HKLM-WOW6432'; Path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },\n  @{ Hive = 'HKCU'; Path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }\n)\n$rows = foreach ($p in $paths) {\n  Get-ItemProperty $p.Path -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {\n    [pscustomobject]@{ Hive = $p.Hive; Key = $_.PSChildName; DisplayName = $_.DisplayName; DisplayVersion = $_.DisplayVersion; Publisher = $_.Publisher; InstallLocation = $_.InstallLocation; DisplayIcon = $_.DisplayIcon; UninstallString = $_.UninstallString; SystemComponent = $_.SystemComponent }\n  }\n}\nConvertTo-Json -InputObject @($rows) -Depth 3 -Compress\n";
function probes(_ctx: ProbeContext, _location: string) {
  return [
    { id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script] },
    // The Windows Installer's own component records name a folder for MSI products that leave InstallLocation empty.
    { id: "msi", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", MSI_SCRIPT], optional: true },
  ];
}
function bad(sourceKind: string, location: string, message: string): ScanResult { return { sourceKind, location, status: "failed", installs: [], message }; }
export const adapter: Adapter = {
  sourceKind: "registry", os: ["windows"], probes,
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const output = outputs.list;
    if (!output) return bad("registry", location, "probe output missing");
    if (output.exitCode !== 0) return bad("registry", location, `probe failed (exit ${output.exitCode}): ${output.stderr.trim().split("\n")[0] ?? ""}`);
    let rows: unknown;
    if (!output.stdout.trim()) rows = [];
    else try { rows = JSON.parse(output.stdout); } catch { return bad("registry", location, "probe output is not valid JSON"); }
    if (rows === null) rows = [];
    if (!Array.isArray(rows)) rows = [rows];
    const msiFolders = parseMsiFolders(outputs.msi?.exitCode === 0 ? outputs.msi.stdout : "");
    const installs: InstallRecord[] = []; let skipped = 0;
    for (const row of rows as unknown[]) {
      if (!row || typeof row !== "object" || Array.isArray(row)) { skipped++; continue; }
      const r = row as Record<string, unknown>; const hive = str(r.Hive); const key = str(r.Key);
      const declared = str(r.InstallLocation);
      const derived = declared === "" ? deriveLocation(str(r.DisplayIcon), str(r.UninstallString)) : null;
      const fromInstaller = declared === "" && !derived ? msiFolders.get(key.toUpperCase()) ?? null : null;
      installs.push({ ecosystem: "arp", key: `${hive}\\${key}`, name: str(r.DisplayName), kind: "package", version: nullable(r.DisplayVersion), location: declared || (derived?.folder ?? fromInstaller ?? ""), ...(nullable(r.Publisher) ? { publisher: nullable(r.Publisher) as string } : {}), details: { hive, key, publisher: nullable(r.Publisher), systemComponent: r.SystemComponent === 1, ...(derived ? { locationSource: derived.source } : fromInstaller ? { locationSource: "WindowsInstaller" } : {}), scope: hive === "HKCU" ? "user" : "machine", wow64: hive === "HKLM-WOW6432" } });
    }
    return skipped ? { sourceKind: "registry", location, status: "partial", installs, message: `skipped ${skipped} malformed row${skipped === 1 ? "" : "s"}` } : { sourceKind: "registry", location, status: "ok", installs };
  },
};
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function nullable(v: unknown): string | null { return typeof v === "string" && v ? v : null; }

/**
 * Lines of `{product code}<TAB>common folder<TAB>component count` from the Windows Installer probe, keyed by upper-case
 * product code. A folder that is a system or shared location, a bare drive, or malformed names no single product and is dropped.
 */
export function parseMsiFolders(stdout: string): Map<string, string> {
  const folders = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const [code, raw] = line.trim().split("\t");
    if (!code || !raw || !/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i.test(code)) continue;
    const folder = raw.replaceAll("\\", "/").replace(/^\?/, "").replace(/\/+$/, "");
    const lower = folder.toLowerCase();
    if (!/^[a-z]:\/[^:?*"<>|]+$/i.test(folder)) continue;
    if (SHARED_FOLDER.test(lower) || /^[a-z]:\/(windows|\$recycle\.bin)(\/|$)|\/(system32|syswow64|fonts|common files)(\/|$)/.test(lower)) continue;
    folders.set(code.toUpperCase(), folder.replaceAll("/", "\\"));
  }
  return folders;
}

/** Folders too shared to name one product: Program Files itself, the Windows tree, per-user roots. */
const SHARED_FOLDER = /^[a-z]:(\/(program files|program files \(x86\)|programdata|users|windows|users\/[^/]+|users\/[^/]+\/appdata|users\/[^/]+\/appdata\/(local|roaming)|users\/[^/]+\/appdata\/local\/programs))?$|^[a-z]:\/windows\//;

/** The folder of an executable or icon path taken from a registry value, or null when it names no single product. */
function folderOf(path: string): string | null {
  const folder = path.replaceAll("\\", "/").replace(/\/[^/]*$/, "").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(folder) && !SHARED_FOLDER.test(folder.toLowerCase()) ? folder.replaceAll("/", "\\") : null;
}

/**
 * Many installers leave InstallLocation empty but name their own files elsewhere. The icon path ("C:\x\app.exe,0")
 * comes first, then the uninstaller's program. A launcher URL or an MSI product code names no folder.
 */
export function deriveLocation(displayIcon: string, uninstallString: string): { folder: string; source: "DisplayIcon" | "UninstallString" } | null {
  const icon = /^"?([a-z]:[^",]*?)"?(?:,-?\d+)?$/i.exec(displayIcon.trim());
  const fromIcon = icon?.[1] ? folderOf(icon[1]) : null;
  if (fromIcon) return { folder: fromIcon, source: "DisplayIcon" };
  const u = uninstallString.trim();
  if (u.includes("://") || /^"?msiexec/i.test(u)) return null;
  const exe = /^"([a-z]:[^"]+)"/i.exec(u)?.[1] ?? /^([a-z]:.+?\.(?:exe|com|bat|cmd))(?:\s|$)/i.exec(u)?.[1];
  const fromUninstall = exe ? folderOf(exe) : null;
  return fromUninstall ? { folder: fromUninstall, source: "UninstallString" } : null;
}
