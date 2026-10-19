import { packagesDue, putIntel, recordResearch, recordSupportWindows, type Db, type SupportWindow } from "@scout/core";
import { githubRateLimit } from "./github.ts";
import { fetchPublicPage } from "./fetch.ts";
import { vendorEvidence, vendorVersion } from "./vendor.ts";
import type { Researcher, ResearchTarget, ResponseHeaders } from "./types.ts";

// The runner asks each researcher about the packages that are due, records every answer, and logs the lookup so the
// same package is not asked about again until its cache lapses. It fetches public endpoints only and sends nothing
// about the machines: a request names a package, never an install or a path.

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect?: "manual" }) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; url?: string }>;

export interface RunOptions {
  fetch?: Fetcher;
  now?: Date;
  concurrency?: number;
  timeoutMs?: number;
  /** Ask about at most this many packages per source in one run. */
  limit?: number;
  /** Ignore the cache for an explicit refresh. */
  force?: boolean;
  /** Tests can supply only the environment names the runner needs. */
  env?: Record<string, string | undefined>;
  extractVersion?: (page: { name: string; url: string; text: string }) => Promise<string | null>;
  onProgress?: (line: string) => void;
}

export interface SourceSummary {
  source: string;
  asked: number;
  ok: number;
  notfound: number;
  failed: number;
  skipped: number;
  answers: number;
}

const HEADERS = { "user-agent": "scout-version-tracker (github.com/neostryder/scout)", accept: "application/json" };

export async function runResearch(db: Db, researchers: Researcher[], options: RunOptions = {}): Promise<SourceSummary[]> {
  const doFetch: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? new Date();
  const requested = options.concurrency ?? 4;
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.min(4, Math.floor(requested))) : 4;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const summaries: SourceSummary[] = [];
  const metadata = db.prepare(
    `SELECT p.homepage, i.details_json FROM packages p JOIN installs i ON i.package_id = p.id
     WHERE p.id = ? AND i.removed_at IS NULL ORDER BY i.last_seen DESC, i.id DESC LIMIT 1`,
  );
  let githubStopped = false;
  let huggingfaceStopped = false;
  let huggingfaceLastRequest = 0;
  const pacedFetch: Fetcher = async (url, init) => {
    while (Date.now() - huggingfaceLastRequest < 250) {
      await new Promise((resolve) => setTimeout(resolve, 250 - (Date.now() - huggingfaceLastRequest)));
    }
    huggingfaceLastRequest = Date.now();
    return doFetch(url, init);
  };
  for (const r of researchers) {
    const s: SourceSummary = { source: r.source, asked: 0, ok: 0, notfound: 0, failed: 0, skipped: 0, answers: 0 };
    summaries.push(s);
    let queue = packagesDue(db, r.ecosystems, r.source, options.force ? 0 : r.ttlMs, now).map((row): ResearchTarget => {
      const extra = metadata.get(row.id) as { homepage: string | null; details_json: string };
      const details = JSON.parse(extra.details_json) as Record<string, unknown>;
      return { ...row, homepage: extra.homepage, details, tap: typeof details["tap"] === "string" ? details["tap"] : null, observedAt: now.toISOString() };
    });
    if (options.limit !== undefined) queue = queue.slice(0, options.limit);
    const work = async (): Promise<void> => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        if (r.source === "vendor" && db.prepare("SELECT 1 FROM assertions WHERE package_id = ? AND source <> 'vendor' LIMIT 1").get(t.id)) {
          s.skipped++;
          continue;
        }
        if (r.source === "github" && githubStopped) {
          s.skipped++;
          continue;
        }
        if (r.source === "huggingface" && huggingfaceStopped) {
          s.skipped++;
          continue;
        }
        const url = r.url(t);
        if (url === null) {
          s.skipped++;
          continue;
        }
        s.asked++;
        let result;
        let windows: SupportWindow[] | undefined;
        try {
          const headers: Record<string, string> = { ...HEADERS };
          if (r.source === "github") {
            headers["accept"] = "application/vnd.github+json";
            headers["X-GitHub-Api-Version"] = "2022-11-28";
            const token = (options.env ?? process.env)["SCOUT_GITHUB_TOKEN"];
            if (token) headers["authorization"] = `Bearer ${token}`;
          }
          if (r.source === "huggingface") {
            const env = options.env ?? process.env;
            const token = env["HF_TOKEN"] || env["HUGGINGFACE_HUB_TOKEN"];
            if (token) headers["authorization"] = `Bearer ${token}`;
          }
          const request = r.source === "huggingface" ? pacedFetch : doFetch;
          const page = r.source === "vendor" ? await fetchPublicPage(doFetch, url, timeoutMs, { accept: "text/html" }) : null;
          const res = page ? { status: page.status, text: async () => page.body, headers: undefined } : await request(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
          const responseHeaders: ResponseHeaders = {};
          for (const name of ["x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
            const value = res.headers?.get(name);
            if (value !== undefined && value !== null) responseHeaders[name] = value;
          }
          const limited = r.source === "github" ? githubRateLimit(res.status, responseHeaders) : null;
          if (limited) {
            githubStopped = true;
            result = { status: "failed" as const, answers: [], message: limited };
          } else {
            const body = await res.text();
            result = r.parse(res.status, body, t, responseHeaders);
            if (r.source === "huggingface" && res.status === 429) huggingfaceStopped = true;
            if (result.status === "ok") {
              if (r.followups && r.combine) {
                const responses: Record<string, { status: number; body: string }> = {};
                for (const [name, nextUrl] of Object.entries(r.followups(t, body))) {
                  if (r.source === "huggingface" && huggingfaceStopped) break;
                  try {
                    const next = await request(nextUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
                    responses[name] = { status: next.status, body: await next.text() };
                    if (r.source === "huggingface" && next.status === 429) huggingfaceStopped = true;
                  } catch { responses[name] = { status: 0, body: "" }; }
                }
                result = r.combine(result, responses, t);
              }
              windows = r.extra?.(t, res.status, body);
              if (r.source === "vendor" && options.extractVersion && !result.answers.length) {
                const evidence = vendorEvidence(body);
                if (!evidence.versions.length && evidence.text) {
                  const version = vendorVersion(await options.extractVersion({ name: t.name, url, text: evidence.text }));
                  if (version) result.answers.push({ channel: "stable", version, advisory: true, installable: false });
                }
              }
            }
          }
        } catch {
          result = { status: "failed" as const, answers: [], message: "request failed" };
        }
        recordResearch(db, t.id, r.source, result.status, result.answers, result.message ?? null, now.toISOString());
        if ("intel" in result && result.intel) putIntel(db, t.id, r.source, result.intel, now.toISOString());
        if (result.status === "ok" && windows) recordSupportWindows(db, t.id, windows, now.toISOString());
        s[result.status]++;
        s.answers += result.answers.length;
        options.onProgress?.(`${r.source} ${t.key}: ${result.status}${result.answers[0] ? ` ${result.answers[0].version}` : ""}`);
      }
    };
    await Promise.all(Array.from({ length: r.source === "github" || r.source === "vendor" || r.source === "huggingface" ? 1 : concurrency }, work));
  }
  return summaries;
}
