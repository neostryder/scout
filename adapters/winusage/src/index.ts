import type { Probe, ProbeContext, ProbeOutputs } from "@scout/core";
import type { UsageAdapter, UsageMatch, UsageResult, UsageSignalRecord } from "@scout/core";

const USERASSIST_SCRIPT = `$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist'
$rows = foreach ($g in Get-ChildItem $root) {
  $c = Join-Path $g.PSPath 'Count'
  if (-not (Test-Path $c)) { continue }
  $k = Get-Item $c
  foreach ($n in $k.GetValueNames()) {
    $v = $k.GetValue($n)
    if ($v -is [byte[]]) { [pscustomobject]@{ Guid = $g.PSChildName; Name = $n; Hex = ([BitConverter]::ToString($v) -replace '-', '') } }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
const ENV_SCRIPT = `[pscustomobject]@{ UserProfile = $env:USERPROFILE; LocalAppData = $env:LOCALAPPDATA; AppData = $env:APPDATA; ProgramData = $env:ProgramData; ProgramFiles = $env:ProgramFiles; ProgramFilesX86 = \${env:ProgramFiles(x86)}; SystemRoot = $env:SystemRoot } | ConvertTo-Json -Compress
`;
const PROCESSES_SCRIPT = `$paths = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique
ConvertTo-Json -InputObject @($paths) -Compress
`;
const argv = (script: string) => ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script];
const result = (origin: string, status: UsageResult["status"], signals: UsageSignalRecord[] = [], message?: string): UsageResult => ({ origin, status, signals, ...(message === undefined ? {} : { message }) });

export const processesAdapter: UsageAdapter = {
  origin: "processes",
  os: ["windows"],
  probes(_ctx: ProbeContext) { return [{ id: "list", argv: argv(PROCESSES_SCRIPT) }]; },
  parse(outputs: ProbeOutputs) {
    const out = outputs["list"];
    if (!out) return result("processes", "failed", [], "probe output missing: list");
    if (out.exitCode !== 0) return result("processes", "skipped", [], `process probe exited ${out.exitCode}`);
    let value: unknown;
    try { value = JSON.parse(out.stdout.trim()); } catch { return result("processes", "failed", [], "process output is not valid JSON"); }
    if (value === null || value === "") value = [];
    if (typeof value === "string") value = [value];
    if (!Array.isArray(value)) return result("processes", "failed", [], "process output is not an array");
    const seen = new Set<string>();
    const signals: UsageSignalRecord[] = [];
    for (const path of value) if (typeof path === "string" && !seen.has(path)) {
      seen.add(path);
      signals.push({ match: { path }, kind: "running", value: "1", available: true });
    }
    return { origin: "processes", status: "ok", signals, completeFor: ["running"] };
  },
};

const folders: Record<string, (env: Record<string, unknown>) => string | undefined> = {
  "{6D809377-6AF0-444B-8957-A3773F02200E}": (e) => str(e["ProgramFiles"]), "{905E63B6-C1BF-494E-B29C-65B732D3D21A}": (e) => str(e["ProgramFiles"]),
  "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}": (e) => str(e["ProgramFilesX86"]), "{F38BF404-1D43-42F2-9305-67DE0B28FC23}": (e) => str(e["SystemRoot"]),
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}": (e) => child(str(e["SystemRoot"]), "System32"), "{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}": (e) => child(str(e["SystemRoot"]), "SysWOW64"),
  "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}": (e) => str(e["LocalAppData"]), "{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}": (e) => str(e["AppData"]),
  "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}": (e) => str(e["ProgramData"]), "{5E6C858F-0E22-4760-9AFE-EA3317B67173}": (e) => str(e["UserProfile"]),
};
/** Start-menu and taskbar shortcut folders: the readings are about .lnk files, which name no install. */
const SHORTCUT_FOLDERS = new Set(["{9E3995AB-1F9C-4F13-B827-48B24B6C7174}", "{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}", "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}"]);
const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
const child = (base: string | undefined, name: string): string | undefined => base === undefined ? undefined : `${base}\\${name}`;
const rot13 = (s: string) => s.replace(/[a-z]/gi, (c) => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= "m" ? 13 : -13)));
function integer(hex: string, offset: number, size: number): bigint {
  const bytes = hex.slice(offset * 2, (offset + size) * 2).match(/../g) ?? [];
  return BigInt(`0x${bytes.reverse().join("")}`);
}
function date(hex: string): string | null {
  const ticks = integer(hex, 60, 8);
  if (ticks === 0n) return null;
  try { return new Date(Number((ticks - 116444736000000000n) / 10000n)).toISOString().replace(/\.\d{3}Z$/, "Z"); } catch { return null; }
}
function findMatch(name: string, env?: Record<string, unknown>): { match?: UsageMatch; unresolved: boolean } {
  const guid = /^(\{[0-9A-Fa-f-]+\})\\(.*)$/.exec(name);
  if (guid) {
    if (SHORTCUT_FOLDERS.has(guid[1]!.toUpperCase())) return { unresolved: false };
    const base = env && folders[guid[1]!.toUpperCase()]?.(env);
    return base ? { match: { path: `${base}\\${guid[2]}` }, unresolved: false } : { unresolved: true };
  }
  if (/^[A-Za-z]:/.test(name)) return { match: { path: name }, unresolved: false };
  const bang = name.indexOf("!");
  if (bang > 0) {
    const pkg = name.slice(0, bang);
    const split = pkg.lastIndexOf("_");
    return { match: { ecosystem: "appx", key: split > 0 ? pkg.slice(0, split) : pkg }, unresolved: false };
  }
  return { unresolved: false };
}

export const userassistAdapter: UsageAdapter = {
  origin: "userassist",
  os: ["windows"],
  probes(_ctx: ProbeContext): Probe[] { return [{ id: "list", argv: argv(USERASSIST_SCRIPT) }, { id: "env", argv: argv(ENV_SCRIPT) }]; },
  parse(outputs: ProbeOutputs) {
    const out = outputs["list"];
    if (!out) return result("userassist", "failed", [], "probe output missing: list");
    if (out.exitCode !== 0) return result("userassist", "skipped", [], `userassist probe exited ${out.exitCode}`);
    let rows: unknown;
    try { rows = JSON.parse(out.stdout.trim()); } catch { return result("userassist", "failed", [], "userassist output is not valid JSON"); }
    if (rows === null) rows = [];
    if (!Array.isArray(rows)) return result("userassist", "failed", [], "userassist output is not an array");
    let env: Record<string, unknown> | undefined;
    const envOut = outputs["env"];
    if (envOut?.exitCode === 0) try { const v: unknown = JSON.parse(envOut.stdout.trim()); if (v && typeof v === "object" && !Array.isArray(v)) env = v as Record<string, unknown>; } catch { /* missing environment data */ }
    const signals = new Map<string, UsageSignalRecord>();
    let unresolved = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (typeof r["Name"] !== "string" || typeof r["Hex"] !== "string" || r["Hex"].length !== 144 || !/^[0-9A-Fa-f]{144}$/.test(r["Hex"])) continue;
      const hex = r["Hex"];
      const resolved = findMatch(rot13(r["Name"]), env);
      if (resolved.unresolved) { unresolved++; continue; }
      if (!resolved.match) continue;
      const identity = "path" in resolved.match ? `p:${resolved.match.path}` : `e:${resolved.match.ecosystem}:${resolved.match.key}`;
      const values: [string, string | null][] = [["last_used", date(hex)], ["use_count", integer(hex, 4, 4).toString(10)]];
      for (const [kind, value] of values) {
        const key = `${identity}|${kind}`;
        const old = signals.get(key);
        const newer = old && kind === "last_used" && old.value !== null && (value === null || old.value > value) ? old.value : old && kind === "use_count" && BigInt(old.value ?? "0") > BigInt(value ?? "0") ? old.value : value;
        signals.set(key, { match: resolved.match, kind, value: newer, available: true });
      }
    }
    return unresolved ? result("userassist", "partial", [...signals.values()], `${unresolved} unresolved known-folder ids`) : result("userassist", "ok", [...signals.values()]);
  },
};
