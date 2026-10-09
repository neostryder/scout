import { changelogSummaryFor, compareVersions, queryUpdates, recordChangelogSummary, recordResearch, type Db } from "@scout/core";
import { fetchPublicPage } from "./fetch.ts";
import { githubRepo } from "./github.ts";
import { DAILY, type ResearchTarget } from "./types.ts";
import type { Fetcher } from "./runner.ts";

export interface ChangelogOptions {
  summarize?: (input: { name: string; version: string; installed: string | null; text: string }) => Promise<{ summary: string; model: string } | null>;
  fetch?: Fetcher;
  now?: Date;
  timeoutMs?: number;
}

export interface ChangelogResult {
  stored: number;
  skipped: number;
  reason?: string;
}

export function releaseText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/!\[[^\]]*\](?:\([^\n]*?\)|\[[^\]]*\])/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/^#{1,6}\s+(?:new\s+)?contributors?\b[^\n]*\n[\s\S]*?(?=^#{1,6}\s|$(?![\s\S]))/gim, "")
    .replace(/^.*\b(?:made their first contribution|new contributors|contributors:)\b.*$/gim, "")
    .replace(/https?:\/\/[^\s<>)]*\/(?:compare|commits|contributors|graphs\/contributors)(?:[/?#][^\s<>)]*)?/gi, "")
    .trim().slice(0, 8000);
}

export function summaryText(text: string): string {
  return text.replace(/[\u2010-\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d\u00ab\u00bb]/g, '"').replace(/\u2026/g, "...").replace(/[^\x00-\x7f]/g, (character) => /\p{P}/u.test(character) ? "" : character).trim().slice(0, 600).trim();
}

const pending = new WeakMap<Db, Promise<ChangelogResult>>();

export function summarizeChangelogs(db: Db, options: ChangelogOptions = {}): Promise<ChangelogResult> {
  const previous = pending.get(db) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => summarizeRun(db, options));
  pending.set(db, run);
  void run.finally(() => { if (pending.get(db) === run) pending.delete(db); }).catch(() => {});
  return run;
}

async function summarizeRun(db: Db, options: ChangelogOptions): Promise<ChangelogResult> {
  const now = options.now ?? new Date();
  const candidates = new Map<number, { packageId: number; ecosystem: string; key: string; name: string; installed: string | null; version: string }>();
  for (let offset = 0;; offset += 1000) {
    const page = queryUpdates(db, { limit: 1000, offset, now: now.toISOString() });
    for (const row of page.rows) {
      const version = row.upstream ?? row.available;
      if (version === null || row.installed === null || compareVersions(version, row.installed) !== 1 || changelogSummaryFor(db, row.packageId, version)) continue;
      if (!candidates.has(row.packageId)) candidates.set(row.packageId, { packageId: row.packageId, ecosystem: row.ecosystem, key: row.key, name: row.name, installed: row.installed, version });
    }
    if (offset + 1000 >= page.total) break;
  }
  const result: ChangelogResult = { stored: 0, skipped: candidates.size };
  if (!options.summarize) return { ...result, reason: "no summarizer configured" };
  const fetcher: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  let asked = 0;
  for (const row of candidates.values()) {
    const source = `changelog:${row.version}`;
    const cached = db.prepare("SELECT checked_at FROM research_log WHERE package_id = ? AND source = ?").get(row.packageId, source) as { checked_at: string } | undefined;
    if (cached && cached.checked_at > new Date(now.getTime() - DAILY).toISOString()) continue;
    const metadata = db.prepare("SELECT p.homepage, i.details_json FROM packages p JOIN installs i ON i.package_id = p.id WHERE p.id = ? AND i.removed_at IS NULL ORDER BY i.last_seen DESC, i.id DESC LIMIT 1").get(row.packageId) as { homepage: string | null; details_json: string };
    const target: ResearchTarget = { id: row.packageId, ecosystem: row.ecosystem, key: row.key, name: row.name, tap: null, homepage: metadata.homepage, details: JSON.parse(metadata.details_json) as Record<string, unknown> };
    const repo = githubRepo(target);
    if (!repo || asked >= 20) continue;
    asked++;
    try {
      let release: { body: string; html_url: string } | null = null;
      const version = row.version.replace(/^v(?=\d)/, "");
      for (const tag of [`v${version}`, version]) {
        const response = await fetchPublicPage(fetcher, `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, options.timeoutMs ?? 15_000, { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
        if (response.status === 404) continue;
        if (response.status !== 200) break;
        const doc: unknown = JSON.parse(response.body);
        if (doc && typeof doc === "object" && "body" in doc && typeof doc.body === "string" && "html_url" in doc && typeof doc.html_url === "string" && URL.canParse(doc.html_url)) {
          const url = new URL(doc.html_url);
          if (url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.port) release = { body: doc.body, html_url: doc.html_url };
        }
        break;
      }
      const text = release ? releaseText(release.body) : "";
      const answer = text ? await options.summarize({ name: row.name, version: row.version, installed: row.installed, text }) : null;
      const summary = answer && typeof answer.summary === "string" ? summaryText(answer.summary) : "";
      if (release && summary && answer && typeof answer.model === "string" && answer.model.trim()) {
        recordChangelogSummary(db, { packageId: row.packageId, version: row.version, summary, sourceUrl: release.html_url, model: answer.model.trim() }, now.toISOString());
        result.stored++;
        result.skipped--;
        continue;
      }
    } catch {
      // A missing or unusable release must not stop the remaining packages.
    }
    recordResearch(db, row.packageId, source, "notfound", [], "no changelog summary", now.toISOString());
  }
  return result;
}
