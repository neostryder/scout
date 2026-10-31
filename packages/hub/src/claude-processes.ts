import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeMonitor, type ProcessRow } from "@scout/core";

// One pass over the process table. Only Claude's own command lines are kept, because the others are never read and Windows is slow to hand them over.
const WINDOWS_SCRIPT = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; m = [int64]$_.WorkingSetSize; s = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); c = $(if ($_.Name -like 'claude*') { $_.CommandLine } else { '' }) } } | ConvertTo-Json -Compress";

export function parseWindowsProcesses(stdout: string): ProcessRow[] {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessRow[] = [];
  for (const item of list as { p?: unknown; pp?: unknown; m?: unknown; s?: unknown; c?: unknown }[]) {
    if (typeof item?.p !== "number" || typeof item.pp !== "number") continue;
    rows.push({ pid: item.p, parentPid: item.pp, memBytes: typeof item.m === "number" ? item.m : 0, startedAt: typeof item.s === "string" ? item.s : null, command: typeof item.c === "string" ? item.c : "" });
  }
  return rows;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/;

/** `ps -axo pid=,ppid=,rss=,lstart=,args=` output. */
export function parsePsProcesses(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const started = new Date(match[4]!).getTime();
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), memBytes: Number(match[3]) * 1024, startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null, command: /claude/i.test(match[5]!) ? match[5]! : "" });
  }
  return rows;
}

const run = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === "win32") return parseWindowsProcesses(await run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT]));
  return parsePsProcesses(await run("ps", ["-axo", "pid=,ppid=,rss=,lstart=,args="]));
}

/** The folder where the Claude desktop app keeps its per-account session records. */
export function appSessionsDir(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude-code-sessions");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude-code-sessions");
}

export const claudeMonitor = (claudeDir = join(homedir(), ".claude")): ClaudeMonitor => new ClaudeMonitor({ claudeDir, appSessionsDir: appSessionsDir(), listProcesses });
