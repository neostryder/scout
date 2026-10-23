import { runArgv, type Exec, type JobAttentionKind, type Transport } from "@scout/core";

/** One look at the desktop while an update runs: whether the administrator prompt is showing, and the windows the installer opened. */
export interface Observation { uac: boolean; windows: { pid: number; process: string; title: string }[] }
/** Reads the desktop for the process tree under `rootPid`. Null means it could not look, which changes nothing. */
export type Observer = (rootPid: number, signal: AbortSignal) => Promise<Observation | null>;

// Read-only: lists processes and their main windows, and whether consent.exe (the UAC prompt) is running. It starts and changes nothing.
export const OBSERVE_SCRIPT = `$ErrorActionPreference = 'Stop'
$root = [int]$args[0]
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($root)
do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n)
[void]$ids.Remove($root)
$windows = @()
if ($ids.Count -gt 0) { $windows = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle } }) }
$uac = $null -ne (Get-Process -Name consent -ErrorAction SilentlyContinue)
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ uac = $uac; windows = $windows }) -Depth 3
`;

export function parseObservation(stdout: string): Observation | null {
  let value: unknown;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { uac, windows } = value as { uac?: unknown; windows?: unknown };
  if (typeof uac !== "boolean") return null;
  // ConvertTo-Json writes a lone window as an object and none as null.
  const list = Array.isArray(windows) ? windows : windows && typeof windows === "object" ? [windows] : [];
  return {
    uac,
    windows: list.flatMap((w): Observation["windows"] => {
      const { pid, process, title } = w as { pid?: unknown; process?: unknown; title?: unknown };
      return Number.isSafeInteger(pid) && typeof process === "string" && typeof title === "string" ? [{ pid: pid as number, process, title }] : [];
    }),
  };
}

export function windowsObserver(exec: Exec = runArgv, transport: Transport = { type: "local" }): Observer {
  return async (rootPid, signal) => {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return null;
    const result = await exec(transport, ["pwsh", "-NoProfile", "-NonInteractive", "-CommandWithArgs", OBSERVE_SCRIPT, String(rootPid)], 15_000, signal);
    return result.exitCode === 0 ? parseObservation(result.stdout) : null;
  };
}

export interface Attention { kind: JobAttentionKind; detail: string | null }

/**
 * Decides what the job is waiting on a person for, from the output lines and the desktop looks.
 * winget announces the administrator prompt before it appears, so the line starts the wait and the prompt closing ends it.
 * The prompt outranks a window. A window is reported only while the installer's tree owns a titled, visible one.
 */
export class AttentionTracker {
  private uac: "none" | "expected" | "showing" = "none";
  private window: string | null = null;
  /** Whether the administrator prompt was ever expected or seen, which tells a declined prompt from other failures. */
  uacSeen = false;
  /** Whether the installer ever opened a window, which tells a stalled wizard from a stalled download. */
  windowSeen = false;

  line(event: { uacExpected?: true; phase?: string }): void {
    if (event.uacExpected) { if (this.uac === "none") this.uac = "expected"; this.uacSeen = true; }
    if (event.phase === "finish") this.uac = "none";
  }

  look(observation: Observation | null): void {
    if (!observation) return;
    if (observation.uac) { this.uac = "showing"; this.uacSeen = true; }
    else if (this.uac === "showing") this.uac = "none";
    const first = observation.windows[0];
    this.window = first ? `${first.title} (${first.process})` : null;
    if (first) this.windowSeen = true;
  }

  /** True while the prompt is on screen and unanswered, the only state a timeout may act on. */
  get prompting(): boolean { return this.uac === "showing"; }

  current(): Attention | null {
    if (this.uac !== "none") return { kind: "uac", detail: null };
    return this.window ? { kind: "window", detail: this.window } : null;
  }
}
