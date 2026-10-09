import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";
const script = "$rows = Get-AppxPackage | Where-Object { -not $_.IsFramework -and $_.SignatureKind -ne 'System' } | Select-Object Name, PackageFullName, Version, Publisher, InstallLocation, SignatureKind\nConvertTo-Json -InputObject @($rows) -Depth 3 -Compress\n";
function probes(_ctx: ProbeContext, _location: string) { return [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script] }]; }
function bad(location: string, message: string): ScanResult { return { sourceKind: "appx", location, status: "failed", installs: [], message }; }
export const adapter: Adapter = { sourceKind: "appx", os: ["windows"], probes, parse(outputs: ProbeOutputs, location: string): ScanResult {
  const output = outputs.list; if (!output) return bad(location, "probe output missing");
  if (output.exitCode !== 0) return bad(location, `probe failed (exit ${output.exitCode}): ${output.stderr.trim().split("\n")[0] ?? ""}`);
  let rows: unknown; if (!output.stdout.trim()) rows = []; else try { rows = JSON.parse(output.stdout); } catch { return bad(location, "probe output is not valid JSON"); }
  if (rows === null) rows = []; if (!Array.isArray(rows)) rows = [rows];
  const installs: InstallRecord[] = []; let skipped = 0;
  for (const row of rows as unknown[]) { if (!row || typeof row !== "object" || Array.isArray(row)) { skipped++; continue; } const r = row as Record<string, unknown>; const name = str(r.Name);
    installs.push({ ecosystem: "appx", key: name, name, kind: "app", version: nullable(r.Version), location: str(r.InstallLocation), details: { packageFullName: nullable(r.PackageFullName), publisher: nullable(r.Publisher), signatureKind: r.SignatureKind ?? null } });
  }
  return skipped ? { sourceKind: "appx", location, status: "partial", installs, message: `skipped ${skipped} malformed row${skipped === 1 ? "" : "s"}` } : { sourceKind: "appx", location, status: "ok", installs };
} };
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function nullable(v: unknown): string | null { return typeof v === "string" && v ? v : null; }
