import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Probe, ProbeOutput } from "./adapter.ts";

export interface ExecResult { exitCode: number; stdout: string; stderr: string; spawnError?: string }
/** Live views of a running command: `onOutput` gets each chunk as it arrives, `onSpawn` the local child's process id. */
export interface ExecHooks { onOutput?: (chunk: string) => void; onSpawn?: (pid: number) => void; maxOutputBytes?: number }
export type Exec = (transport: Transport, argv: string[], timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>, hooks?: ExecHooks) => Promise<ExecResult>;

export type Transport = { type: "local" } | { type: "ssh"; target: string; options?: string[]; guest?: string[] };

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** A login shell supplies the remote PATH; bash is used when zsh is unavailable. */
export function remoteCommand(argv: string[]): string {
  let words = argv;
  // Homebrew must not update itself or report analytics while it is only being read.
  if (words[0]?.endsWith("/brew")) words = ["env", "HOMEBREW_NO_AUTO_UPDATE=1", "HOMEBREW_NO_ANALYTICS=1", ...words];
  const script = `if command -v zsh >/dev/null 2>&1; then exec zsh -lc "$1"; else exec bash -lc "$1"; fi`;
  return `sh -c ${shellQuote(script)} sh ${shellQuote(words.map(shellQuote).join(" "))}`;
}

/** `input`, when given, is written to the child's stdin and the pipe is closed; otherwise stdin is closed. */
// A detached pwsh on Windows prints nothing to a pipe, so only POSIX children are detached; windowsHide keeps the console window away.
function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: Record<string, string>, input?: string, hooks?: ExecHooks): Promise<ExecResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: -1, stdout: "", stderr: "stopped" });
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, detached: process.platform !== "win32", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: string): string => {
      if (hooks?.maxOutputBytes === undefined) return current + chunk;
      const remaining = Math.max(0, hooks.maxOutputBytes - Buffer.byteLength(current));
      const bytes = Buffer.from(chunk);
      return current + (bytes.length <= remaining ? chunk : new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true }));
    };
    if (child.pid !== undefined) hooks?.onSpawn?.(child.pid);
    const stop = () => child.kill();
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(stop, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => { stdout = append(stdout, d); hooks?.onOutput?.(d); });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => { stderr = append(stderr, d); hooks?.onOutput?.(d); });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ exitCode: 127, stdout, stderr: append(stderr, String(err.message)), spawnError: (err as NodeJS.ErrnoException).code });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * The ssh program to run. Windows' bundled OpenSSH exits with a crash status on about half of its runs, after printing the complete output,
 * which looks like a failed read; the ssh that ships with Git for Windows does not, so it is used when it is installed. `SCOUT_SSH` names another program.
 */
export function sshProgram(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (env["SCOUT_SSH"]) return env["SCOUT_SSH"];
  if (platform === "win32") {
    for (const base of [env["ProgramFiles"], env["ProgramW6432"], env["ProgramFiles(x86)"]]) {
      const candidate = base ? join(base, "Git", "usr", "bin", "ssh.exe") : "";
      if (candidate && exists(candidate)) return candidate;
    }
  }
  return "ssh";
}

/** Windows cmd shims need a shell, so use their CLI scripts or standalone executable. */
export function windowsNodeCli(file: string, execPath: string, platform: string, exists: (path: string) => boolean, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } | null {
  const tool = file.toLowerCase().replace(/\.cmd$/, "");
  if (platform !== "win32" || !["npm", "npx", "pnpm"].includes(tool)) return null;
  const dirs = [dirname(execPath), env["PNPM_HOME"], env["APPDATA"] ? join(env["APPDATA"], "npm") : undefined, env["LOCALAPPDATA"] ? join(env["LOCALAPPDATA"], "pnpm") : undefined, env["ProgramFiles"] ? join(env["ProgramFiles"], "nodejs") : undefined].filter((dir): dir is string => !!dir);
  for (const dir of dirs) {
    const script = tool === "pnpm" ? join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs") : join(dir, "node_modules", "npm", "bin", `${tool}-cli.js`);
    if (exists(script)) return { file: execPath, args: [script] };
    if (tool === "pnpm") {
      const exe = join(dir, "pnpm.exe");
      if (exists(exe)) return { file: exe, args: [] };
      const corepack = join(dir, "node_modules", "corepack", "dist", "pnpm.js");
      if (exists(corepack)) return { file: execPath, args: [corepack] };
    }
  }
  return null;
}

/** An installer can briefly lock a tool while replacing it. */
export function retryExec(exec: Exec, pause: (ms: number, signal?: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, { signal }); }): Exec {
  return async (transport, argv, timeoutMs, signal, env, hooks) => {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return { exitCode: -1, stdout: "", stderr: "stopped" };
      let result: ExecResult;
      try { result = await exec(transport, argv, Math.max(1, deadline - Date.now()), signal, env, hooks); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EBUSY") throw error;
        result = { exitCode: 127, stdout: "", stderr: (error as Error).message, spawnError: code };
      }
      const code = result.spawnError ?? (result.exitCode === 127 ? /\bspawn\b[^\r\n]*\b(EACCES|EBUSY)\b/.exec(result.stderr)?.[1] : undefined);
      if (transport.type !== "local" || code !== "EACCES" && code !== "EBUSY" || attempt >= 5 || Date.now() + 3000 >= deadline) return result;
      try { await pause(3000, signal); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
  };
}

/** Run one argv locally or through SSH, with no stdin and an abortable child. */
export const runArgv: Exec = retryExec((transport, argv, timeoutMs, signal, env, hooks) => {
  if (transport.type === "local") {
    const [file, ...args] = argv;
    if (!file) return Promise.resolve({ exitCode: 127, stdout: "", stderr: "empty argv" });
    const cli = windowsNodeCli(file, process.execPath, process.platform, existsSync, { ...process.env, ...env });
    return cli ? run(cli.file, [...cli.args, ...args], timeoutMs, signal, env, undefined, hooks) : run(file, args, timeoutMs, signal, env, undefined, hooks);
  }
  const words = transport.guest ? [...transport.guest, ...argv] : argv;
  const remote = env ? ["env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...words] : words;
  return run(sshProgram(), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(transport.options ?? []), transport.target, remoteCommand(remote)], timeoutMs, signal, undefined, undefined, hooks);
});

/** Run one probe on a machine and return its raw output. Never throws. */
export function runProbe(transport: Transport, probe: Probe, timeoutMs = 120_000): Promise<ProbeOutput> {
  if (transport.type === "local") {
    const [file, ...args] = probe.argv;
    if (!file) return Promise.resolve({ exitCode: 127, stdout: "", stderr: "empty argv" });
    return run(file, args, timeoutMs, undefined, undefined, probe.stdin);
  }
  return run(
    sshProgram(),
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...(transport.options ?? []), transport.target, remoteCommand(transport.guest ? [...transport.guest, ...probe.argv] : probe.argv)],
    timeoutMs,
    undefined,
    undefined,
    probe.stdin,
  );
}
