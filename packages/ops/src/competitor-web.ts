import type { CandidateSource } from "@scout/core";

/** One listing page to read, such as a Foundry package category or an itch.io tag, and which of its links count. */
export interface WebPage {
  url: string;
  /** A regular expression a link must match to count. With none, every link to another site counts. */
  pattern: string | null;
  /** Most links taken from this page in one run. */
  limit: number;
}

export interface WebConfig {
  /** Addresses of self-hosted FireCrawl, tried in order. The first that answers is used first the next time. */
  firecrawl: string[];
  pages: WebPage[];
  /** Most pages scraped for their text and most repositories looked up in one run. Each scrape takes about half a minute. */
  perRun: number;
}

export interface Scraped { title: string; description: string; markdown: string; links: string[] }
export type Scrape = (url: string, want: "links" | "markdown") => Promise<Scraped>;

type Poster = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const SCRAPE_TIMEOUT_MS = 90_000;
const EXCERPT_CHARS = 800;

/** Reads a page through the self-hosted FireCrawl (no key). Tries each address in turn and throws the last failure when none answers. */
export function firecrawlScraper(options: { post: Poster; bases: string[] }): Scrape {
  const bases = options.bases.map((base) => base.replace(/\/+$/, ""));
  return async (url, want) => {
    let failure = "FireCrawl has no address";
    for (const base of [...bases]) {
      try {
        const response = await options.post(`${base}/v1/scrape`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, formats: [want], onlyMainContent: want === "markdown" }), signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
        });
        if (!response.ok) { failure = `${base} answered ${response.status}`; continue; }
        const body = await response.json() as { success?: boolean; data?: { markdown?: unknown; links?: unknown; metadata?: { title?: unknown; description?: unknown } } };
        if (body.success === false || !body.data) { failure = `${base} could not read ${url}`; continue; }
        const metadata = body.data.metadata ?? {};
        // The address that worked goes first next time.
        bases.splice(0, bases.length, base, ...bases.filter((other) => other !== base));
        return {
          title: typeof metadata.title === "string" ? metadata.title : "", description: typeof metadata.description === "string" ? metadata.description : "",
          markdown: typeof body.data.markdown === "string" ? body.data.markdown : "", links: Array.isArray(body.data.links) ? body.data.links.filter((link): link is string => typeof link === "string") : [],
        };
      } catch (error) { failure = `${base}: ${(error as Error).message}`; }
    }
    throw new Error(failure);
  };
}

const NOISE_HOSTS = new Set(["discord.com", "discord.gg", "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com", "youtu.be", "reddit.com", "t.me", "bsky.app", "mastodon.social", "ko-fi.com", "buymeacoffee.com", "paypal.com", "google.com", "wikipedia.org", "web.archive.org"]);
const NOT_A_PROJECT_OWNERS = new Set(["sponsors", "orgs", "topics", "features", "marketplace", "login", "settings", "about", "pricing", "collections", "search", "explore", "notifications", "apps"]);
const FILE_LINK = /\.(json|zip|png|jpe?g|gif|svg|webp|pdf|css|js|xml|ico)(\?|#|$)/i;

function hostOf(link: string): string | null {
  try { const url = new URL(link); return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase().replace(/^www\./, "") : null; } catch { return null; }
}

/** One key per page: the host and path, with no query, no fragment, no trailing slash, and no letter case. */
export function webKey(link: string): string | null {
  try {
    const url = new URL(link);
    const host = hostOf(link);
    return host ? `web:${host}${url.pathname.replace(/\/+$/, "").toLowerCase()}` : null;
  } catch { return null; }
}

/** The part of a page title before the site name: "Mapper | Foundry Virtual Tabletop" becomes "Mapper". */
export function nameFromTitle(title: string, fallback: string): string {
  const first = title.split(/\s+[|–—·-]\s+/)[0]?.trim() ?? "";
  return first.length >= 2 ? first.slice(0, 80) : fallback;
}

/** Page text as plain words: images and link targets dropped, runs of space collapsed, cut short. */
export function excerpt(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[#*_>`|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
}

export interface WebDeps {
  scrape: Scrape;
  /** "https://github.com/owner/repo" for any link into a repository, else null. */
  repoOf(link: string): string | null;
  /** Facts for a repository, or null when it cannot be read. */
  lookupRepo(repo: string): Promise<CandidateSource | null>;
}

/** Candidates from listing pages: links into GitHub become ordinary repository candidates, links to any other site are read through FireCrawl and become page candidates. A page or link that fails is skipped and logged. */
export async function gatherWeb(config: WebConfig, deps: WebDeps, skip: Set<string>, log: (line: string) => void = () => {}): Promise<CandidateSource[]> {
  const repos = new Map<string, string>();
  const pages = new Map<string, string>();
  for (const page of config.pages) {
    let links: string[];
    try { links = (await deps.scrape(page.url, "links")).links; } catch (error) { log(`discovery: could not read ${page.url}: ${(error as Error).message}`); continue; }
    let pattern: RegExp | null = null;
    try { pattern = page.pattern ? new RegExp(page.pattern, "i") : null; } catch { log(`discovery: the pattern for ${page.url} is not a valid expression`); continue; }
    const own = hostOf(page.url);
    let taken = 0;
    for (const link of links) {
      if (taken >= page.limit) break;
      if (pattern && !pattern.test(link)) continue;
      const repo = deps.repoOf(link);
      if (repo) {
        const key = `github:${repo.slice("https://github.com/".length).toLowerCase()}`;
        const owner = key.slice("github:".length).split("/")[0] ?? "";
        if (NOT_A_PROJECT_OWNERS.has(owner) || skip.has(key) || repos.has(key)) continue;
        repos.set(key, repo);
        taken += 1;
        continue;
      }
      const host = hostOf(link);
      const key = webKey(link);
      if (!host || !key || FILE_LINK.test(link) || NOISE_HOSTS.has(host) || host === "github.com") continue;
      if (!pattern && host === own) continue;
      if (skip.has(key) || pages.has(key)) continue;
      pages.set(key, link);
      taken += 1;
    }
  }
  const out: CandidateSource[] = [];
  for (const repo of [...repos.values()].slice(0, config.perRun)) {
    const facts = await deps.lookupRepo(repo);
    if (facts) out.push(facts);
  }
  for (const [key, link] of [...pages.entries()].slice(0, config.perRun)) {
    try {
      const read = await deps.scrape(link, "markdown");
      const host = hostOf(link) ?? key;
      const description = `${read.description} ${excerpt(read.markdown)}`.replace(/\s+/g, " ").trim();
      if (description === "") continue;
      out.push({ key, source: "web", name: nameFromTitle(read.title, host), org: host, url: link, repoUrl: null, description, topics: [], stars: 0, pushedAt: null });
    } catch (error) { log(`discovery: could not read ${link}: ${(error as Error).message}`); }
  }
  return out;
}
