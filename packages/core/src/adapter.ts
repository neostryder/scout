// The adapter contract. An adapter never touches a machine: it names the fixed probes to run and parses their
// recorded output. The transport (local process, ssh to scout-op, guest CLI) runs probes and hands back raw
// output, so every adapter is a pure function and is tested against recorded fixtures.

export interface Probe {
  /** Stable name, used as the key in the fixture and in ProbeOutputs. */
  id: string;
  /** The exact argument array. Never a shell string. Fixed by the adapter, never built from page input. */
  argv: string[];
  /** Optional stdin document (JSON) for scout-op operations. */
  stdin?: string;
  /** A probe that may fail on a healthy machine (tool not installed). A failed optional probe is not an error. */
  optional?: boolean;
}

export interface ProbeOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProbeOutputs = Record<string, ProbeOutput>;

export type InstallKind = "package" | "app" | "binary" | "service" | "image" | "runtime" | "vm" | "repo" | "model";

/** One discovered install. Identity is (ecosystem, key); the catalog merges nothing on its own. */
export interface InstallRecord {
  ecosystem: string; // brew | cask | mas | bundle | pkgutil | launchd | npm | pypi | uv | winget | appx | image | ...
  key: string; // formula name, bundle id, winget id, image repo, ...
  name: string;
  kind: InstallKind;
  version: string | null;
  /** Where it lives on disk (a Cellar path, an .app path, a binary path). Empty when the source gives none. */
  location: string;
  digest?: string;
  /** What the source itself says the software is. Only text the source supplied; never generated. */
  description?: string;
  homepage?: string;
  publisher?: string;
  /** Source-specific extras: pinned, tap, SUFeedURL, bundle id, compose file, dependents, ... */
  details?: Record<string, unknown>;
}

export type ScanStatus = "ok" | "partial" | "failed" | "skipped";

export interface ScanResult {
  sourceKind: string; // brew | cask | app | pkgutil | launchd | npm | ...
  /** The prefix or root this source instance covers ("/opt/homebrew", "/Applications"); "" when there is one. */
  location: string;
  status: ScanStatus;
  installs: InstallRecord[];
  selectors?: { file: string; project: string; kind: "node" | "python" | "rust" | "go" | "ruby" | "packageManager" | "engines"; tool: string; spec: string }[];
  /** Why a source failed or skipped, or what was partial. Shown in the coverage report. */
  message?: string;
}

export interface ProbeContext {
  machineId: string;
  os: "macos" | "windows" | "linux";
  /** Paths and roots the transport discovered from files and processes. Adapters never start anything. */
  roots: Record<string, string[]>;
}

export interface Adapter {
  /** Matches ScanResult.sourceKind. */
  sourceKind: string;
  /** The operating systems this adapter reads. */
  os: ReadonlyArray<"macos" | "windows" | "linux">;
  /** The fixed probes for one source instance. `location` selects one (for example a Homebrew prefix). */
  probes(ctx: ProbeContext, location: string): Probe[];
  /** Pure: turn the recorded outputs of those probes into a ScanResult. Must not throw on odd input; return status "partial" or "failed". */
  parse(outputs: ProbeOutputs, location: string): ScanResult;
}
