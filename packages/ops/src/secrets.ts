import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecretExecOptions {
  timeout: number;
  windowsHide: boolean;
}

export type SecretExec = (file: string, args: readonly string[], options: SecretExecOptions) => Promise<{ stdout: string }>;

const BWS_ARGS = ["secret", "list"] as const;
const BWS_OPTIONS: SecretExecOptions = { timeout: 15_000, windowsHide: true };

function runOnce(file: string, args: readonly string[], options: SecretExecOptions): Promise<{ stdout: string } | "missing" | "failed"> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: options.timeout, windowsHide: options.windowsHide, encoding: "utf8" }, (err, stdout) => {
      // The child error can quote the environment, so only its kind is kept.
      if (err) resolve((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed");
      else resolve({ stdout: String(stdout) });
    });
  });
}

// bws often lives in the user's local bin, which a service or an app-launched process may not have on PATH.
async function defaultExec(file: string, args: readonly string[], options: SecretExecOptions): Promise<{ stdout: string }> {
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? `${file}.exe` : file);
  for (const candidate of [file, local]) {
    const result = await runOnce(candidate, args, options);
    if (result === "failed") break;
    if (result !== "missing") return result;
  }
  throw new Error("bws failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSecrets(stdout: string): { key: string; value: string }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("bws failed"); }
  const record = isRecord(parsed) ? parsed : null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(record?.data) ? record.data : Array.isArray(record?.secrets) ? record.secrets : null;
  if (!list) throw new Error("bws failed");
  const secrets: { key: string; value: string }[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.value !== "string" || item.value === "") continue;
    secrets.push({ key: item.key, value: item.value });
  }
  return secrets;
}

async function loadSecrets(exec: SecretExec): Promise<{ key: string; value: string }[]> {
  try {
    return parseSecrets((await exec("bws", BWS_ARGS, BWS_OPTIONS)).stdout);
  } catch (err) {
    if (err instanceof Error && err.message === "bws failed") throw err;
    throw new Error("bws failed");
  }
}

/** The matching bws value, held by the caller in memory. Errors name the failure and never the value. */
export async function readSecret(key: string, exec: SecretExec = defaultExec): Promise<string> {
  const found = (await loadSecrets(exec)).find((item) => item.key === key);
  if (!found) throw new Error("key was not found");
  return found.value;
}

export interface CloudflareSecrets {
  token: string;
  accountId: string | null;
}

/**
 * `SCOUT_CLOUDFLARE_TOKEN` wins when it is set. Otherwise the named key, or
 * `CLOUDFLARE_SCOUT_READ`. The account id
 * is `CLOUDFLARE_ACCOUNT_ID` when bws has it.
 */
export async function lookupCloudflareSecrets(options: {
  env?: NodeJS.ProcessEnv;
  secretName?: string | null;
  exec?: SecretExec;
} = {}): Promise<CloudflareSecrets | null> {
  const env = options.env ?? process.env;
  const envToken = env.SCOUT_CLOUDFLARE_TOKEN?.trim() ?? "";
  const exec = options.exec ?? defaultExec;
  let listed: { key: string; value: string }[] | null | undefined;
  const load = async (): Promise<{ key: string; value: string }[] | null> => {
    if (listed !== undefined) return listed;
    try {
      listed = await loadSecrets(exec);
      return listed;
    } catch {
      listed = null;
      return null;
    }
  };
  let token = envToken;
  if (!token) {
    const secrets = await load();
    if (!secrets) return null;
    const names = options.secretName ? [options.secretName] : ["CLOUDFLARE_SCOUT_READ"];
    for (const name of names) {
      const found = secrets.find((item) => item.key === name);
      if (found) { token = found.value; break; }
    }
    if (!token) return null;
  }
  const secrets = await load();
  const account = secrets?.find((item) => item.key === "CLOUDFLARE_ACCOUNT_ID");
  return { token, accountId: account?.value ?? null };
}
