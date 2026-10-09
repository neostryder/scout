import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSecret, type SecretExec } from "./secrets.ts";

export type CogitatorErrorKind = "off" | "busy" | "deferred" | "invalid" | "network";
export type CogitatorOffReason = "not configured" | "no key" | "gateway is not local" | "Cogitator is not running";

export class CogitatorError extends Error {
  kind: CogitatorErrorKind;
  status: number | undefined;
  constructor(kind: CogitatorErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface CogitatorConfig {
  discoveryFile?: string;
  gateway: string;
  role: string;
}

export interface CogitatorDiscovery {
  schema: 1;
  name: string;
  version: string;
  gateway: string;
  openai_base: string;
  health: string;
  busy_probe: string;
  auth: { type: "bearer"; header: "Authorization"; scheme: "Bearer" };
  models: { id: string; memory_mb: number; priority: number }[];
  roles: { name: string; chain: string[] }[];
}

function localUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CogitatorError("off", "gateway is not local"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new CogitatorError("off", "gateway is not local");
  return url;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadCogitatorConfig(dataDir = ".scout-data"): CogitatorConfig {
  let value: unknown;
  try { value = JSON.parse(readFileSync(resolve(dataDir, "cogitator.json"), "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CogitatorError("off", "not configured");
    value = {};
  }
  if (!record(value) || ["discoveryFile", "gateway", "role"].some((key) => value[key] !== undefined && (typeof value[key] !== "string" || !value[key]))) throw new CogitatorError("off", "not configured");
  return { ...(typeof value.discoveryFile === "string" ? { discoveryFile: resolve(dataDir, value.discoveryFile).replace(/\\/g, "/") } : {}), gateway: typeof value.gateway === "string" ? value.gateway : "http://127.0.0.1:8470", role: typeof value.role === "string" ? value.role : "describe" };
}

export async function lookupCogitatorKey(options: { env?: NodeJS.ProcessEnv; exec?: SecretExec } = {}): Promise<string | null> {
  const key = (options.env ?? process.env).SCOUT_COGITATOR_KEY?.trim();
  if (key) return key;
  try { return (await readSecret("COGITATOR_SCOUT_KEY", options.exec)).trim() || null; } catch { return null; }
}

export class CogitatorClient {
  readonly role: string;
  private config: CogitatorConfig;
  private key: string;
  private fetch: typeof fetch;
  private discovery: CogitatorDiscovery | null = null;
  private probeTimeoutMs: number;
  private requestTimeoutMs: number;

  constructor(config: CogitatorConfig, key: string, options: { fetch?: typeof fetch; probeTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
    this.config = config;
    this.role = config.role;
    this.key = key;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!key) throw new CogitatorError("off", "no key");
    if (!config.discoveryFile) localUrl(config.gateway);
  }

  private async request(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
    localUrl(url);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CogitatorError("network", "Cogitator request failed")); }, timeoutMs);
      });
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new CogitatorError("network", "Cogitator request failed"));
        if (combined.aborted) abort();
        else combined.addEventListener("abort", abort, { once: true });
      });
      return await Promise.race([timeout, cancelled, (async () => {
        const response = await this.fetch(url, { ...init, redirect: "error", signal: combined, headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` } });
        if (response.status === 503) {
          const raw = await response.text();
          throw new CogitatorError(/deferred/i.test(raw) ? "deferred" : /no_capacity/i.test(raw) ? "deferred" : "busy", /deferred/i.test(raw) ? "Cogitator deferred the request" : "Cogitator is busy");
        }
        if (!response.ok) throw new CogitatorError("network", "Cogitator request failed", response.status);
        let body: unknown;
        try { body = await response.json(); } catch { throw new CogitatorError("invalid", "Cogitator returned invalid JSON"); }
        return { response, body };
      })()]);
    } catch (error) {
      if (error instanceof CogitatorError) throw error;
      // A refused connection means the host is off or restarting, which waits like a busy host.
      throw new CogitatorError("busy", "Cogitator is not reachable");
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) combined.removeEventListener("abort", abort);
    }
  }

  async discover(signal?: AbortSignal): Promise<CogitatorDiscovery> {
    let value: unknown;
    if (this.config.discoveryFile) {
      try { value = JSON.parse(readFileSync(this.config.discoveryFile, "utf8")); } catch { throw new CogitatorError("off", "Cogitator is not running"); }
    } else {
      try { value = (await this.request(`${localUrl(this.config.gateway).origin}/v1/cogitator/discovery`, { method: "GET" }, this.probeTimeoutMs, signal)).body; } catch (error) {
        if (error instanceof CogitatorError && error.kind === "off") throw error;
        throw new CogitatorError("off", "Cogitator is not running");
      }
    }
    if (!record(value) || value.schema !== 1 || typeof value.name !== "string" || typeof value.version !== "string" ||
        !["gateway", "openai_base", "health", "busy_probe"].every((key) => typeof value[key] === "string") ||
        !record(value.auth) || value.auth.type !== "bearer" || value.auth.header !== "Authorization" || value.auth.scheme !== "Bearer" ||
        !Array.isArray(value.models) || !value.models.every((model) => record(model) && typeof model.id === "string" && typeof model.memory_mb === "number" && typeof model.priority === "number") ||
        !Array.isArray(value.roles) || !value.roles.every((role) => record(role) && typeof role.name === "string" && Array.isArray(role.chain) && role.chain.every((id) => typeof id === "string"))) throw new CogitatorError("off", "not configured");
    const discovery = value as unknown as CogitatorDiscovery;
    for (const url of [discovery.gateway, discovery.openai_base, discovery.health, discovery.busy_probe]) localUrl(url);
    if (!discovery.busy_probe.includes("{model}") || !discovery.roles.some((role) => role.name === this.role)) throw new CogitatorError("off", "not configured");
    this.discovery = discovery;
    return discovery;
  }

  async probe(role = this.role, signal?: AbortSignal): Promise<{ state: "idle" | "loadable"; serving: string }> {
    const discovery = this.discovery ?? await this.discover(signal);
    const { body } = await this.request(discovery.busy_probe.replace("{model}", encodeURIComponent(role)), { method: "GET" }, this.probeTimeoutMs, signal);
    if (!record(body) || !["idle", "loadable"].includes(String(body.state)) || typeof body.serving !== "string" || body.serving.includes(this.key)) throw new CogitatorError("invalid", "Cogitator returned an invalid probe");
    return body as unknown as { state: "idle" | "loadable"; serving: string };
  }

  async generate(role: string, system: string, user: string, schema: unknown, signal?: AbortSignal): Promise<{ answer: unknown; servedBy: string | null }> {
    const discovery = this.discovery ?? await this.discover(signal);
    const call = (): Promise<{ response: Response; body: unknown }> => this.request(`${discovery.openai_base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", body: JSON.stringify({ model: role, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, max_tokens: 400, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { name: "scout_description", strict: true, schema } } }),
    }, this.requestTimeoutMs, signal);
    // A 502 means the engine died and the gateway freed it, so one retry usually lands on the next model in the chain.
    const { response, body } = await call().catch((error: unknown) => {
      if (error instanceof CogitatorError && error.status === 502) return call();
      throw error;
    });
    if (!record(body) || !Array.isArray(body.choices) || !record(body.choices[0]) || !record(body.choices[0].message) || typeof body.choices[0].message.content !== "string") throw new CogitatorError("invalid", "Cogitator returned an invalid answer");
    try {
      const content = body.choices[0].message.content;
      const servedBy = response.headers.get("x-cogitator-model");
      // A gateway must not be able to echo the client credential into stored evidence or labels.
      if (content.includes(this.key) || servedBy?.includes(this.key)) throw new Error();
      return { answer: JSON.parse(content), servedBy };
    } catch { throw new CogitatorError("invalid", "Cogitator returned an invalid answer"); }
  }
}
