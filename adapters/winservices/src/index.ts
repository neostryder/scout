import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";
const script = "$rows = Get-CimInstance Win32_Service | Select-Object Name, DisplayName, PathName, State, StartMode\nConvertTo-Json -InputObject @($rows) -Depth 3 -Compress\n";
function probes(_ctx: ProbeContext, _location: string) { return [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script] }]; }
function bad(location: string, message: string): ScanResult { return { sourceKind: "services", location, status: "failed", installs: [], message }; }
export const adapter: Adapter = { sourceKind: "services", os: ["windows"], probes, parse(outputs: ProbeOutputs, location: string): ScanResult {
  const output = outputs.list; if (!output) return bad(location, "probe output missing");
  if (output.exitCode !== 0) return bad(location, `probe failed (exit ${output.exitCode}): ${output.stderr.trim().split("\n")[0] ?? ""}`);
  let rows: unknown; if (!output.stdout.trim()) rows = []; else try { rows = JSON.parse(output.stdout); } catch { return bad(location, "probe output is not valid JSON"); }
  if (rows === null) rows = []; if (!Array.isArray(rows)) rows = [rows];
  const installs: InstallRecord[] = []; let skipped = 0;
  for (const row of rows as unknown[]) { if (!row || typeof row !== "object" || Array.isArray(row)) { skipped++; continue; } const r = row as Record<string, unknown>; const name = str(r.Name); const pathName = nullable(r.PathName);
    installs.push({ ecosystem: "service", key: name, name: str(r.DisplayName) || name, kind: "service", version: null, location: executable(pathName), details: { state: nullable(r.State), startMode: nullable(r.StartMode), pathName } });
  }
  return skipped ? { sourceKind: "services", location, status: "partial", installs, message: `skipped ${skipped} malformed row${skipped === 1 ? "" : "s"}` } : { sourceKind: "services", location, status: "ok", installs };
} };
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function nullable(v: unknown): string | null { return typeof v === "string" && v ? v : null; }
function executable(value: string | null): string { if (!value) return ""; if (value.startsWith('"')) { const end = value.indexOf('"', 1); return end < 0 ? value.slice(1) : value.slice(1, end); } const exe = /\.exe\b/i.exec(value); return exe ? value.slice(0, exe.index + exe[0].length) : value; }
