import { spawn } from "node:child_process";
import type { Probe, ProbeOutput } from "./adapter.ts";

export interface ExecResult { exitCode: number; stdout: string; stderr: string }
export type Exec = (transport: Transport, argv: string[], timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>) => Promise<ExecResult>;

export type Transport = { type: "local" } | { type: "ssh"; target: string; options?: string[]; guest?: string[] };

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The remote command line for an ssh probe: the argv, quoted, run under a login zsh so the login PATH is present. */
export function remoteCommand(argv: string[]): string {
  let words = argv;
  // Homebrew must not update itself or report analytics while it is only being read.
  if (words[0]?.endsWith("/brew")) words = ["env", "HOMEBREW_NO_AUTO_UPDATE=1", "HOMEBREW_NO_ANALYTICS=1", ...words];
  return `zsh -lc ${shellQuote(words.map(shellQuote).join(" "))}`;
}

/** `input`, when given, is written to the child's stdin and the pipe is closed; otherwise stdin is closed. */
// A detached pwsh on Windows prints nothing to a pipe, so only POSIX children are detached; windowsHide keeps the console window away.
function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>, input?: string): Promise<ExecResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: -1, stdout: "", stderr: "stopped" });
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = "";
    let stderr = "";
    const stop = () => child.kill();
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(stop, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** Run one argv locally or through SSH, with no stdin and an abortable child. */
export const runArgv: Exec = (transport, argv, timeoutMs, signal, env) => {
  if (transport.type === "local") {
    const [file, ...args] = argv;
    return file ? run(file, args, timeoutMs, signal, env) : Promise.resolve({ exitCode: 127, stdout: "", stderr: "empty argv" });
  }
  const words = transport.guest ? [...transport.guest, ...argv] : argv;
  const remote = env ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...words] : words;
  return run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(transport.options ?? []), transport.target, remoteCommand(remote)], timeoutMs, signal);
};

/** Run one probe on a machine and return its raw output. Never throws. */
export function runProbe(transport: Transport, probe: Probe, timeoutMs = 120_000): Promise<ProbeOutput> {
  if (transport.type === "local") {
    const [file, ...args] = probe.argv;
    if (!file) return Promise.resolve({ exitCode: 127, stdout: "", stderr: "empty argv" });
    return run(file, args, timeoutMs, undefined, undefined, probe.stdin);
  }
  return run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(transport.options ?? []), transport.target, remoteCommand(transport.guest ? [...transport.guest, ...probe.argv] : probe.argv)],
    timeoutMs,
    undefined,
    undefined,
    probe.stdin,
  );
}
