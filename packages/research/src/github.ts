import { compareVersions } from "@scout/core";
import { SIX_HOURS, type Answer, type Researcher, type ResearchTarget, type ResponseHeaders } from "./types.ts";

const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/.*)?$/;
const VERSION = /^v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)$/;

export function githubRepo(target: ResearchTarget): string | null {
  let path: string | null = null;
  if (typeof target.homepage === "string" && URL.canParse(target.homepage)) {
    const url = new URL(target.homepage);
    if (url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && /^\/[^/]+\/[^/]+(?:\/*|\/(?:tree|releases)(?:\/.*)?)$/.test(url.pathname)) path = url.pathname.slice(1);
  }
  if (path === null && target.ecosystem === "go-bin") {
    const module = target.details.module;
    const key = typeof module === "string" && module !== "" ? module : target.key;
    if (key.startsWith("github.com/")) path = key.slice("github.com/".length);
  }
  const match = path === null ? null : REPO.exec(path);
  const repo = match?.[2]?.replace(/\.git$/, "");
  if (!match || !repo || repo === "." || repo === "..") return null;
  return `${match[1]}/${repo}`;
}

export function githubRateLimit(status: number, headers: ResponseHeaders = {}): string | null {
  if ((status !== 403 && status !== 429) || headers["x-ratelimit-remaining"] !== "0") return null;
  const reset = headers["x-ratelimit-reset"];
  const time = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
  const when = Number.isFinite(time) && time <= 8_640_000_000_000_000 ? new Date(time).toISOString() : reset ?? "unknown";
  return `GitHub rate limit resets at ${when}`;
}

export const github: Researcher = {
  source: "github",
  ecosystems: ["brew", "cask", "npm", "pipx", "uv-tool", "go-bin", "cargo", "bundle", "winget", "winget-local", "msstore", "arp", "binary", "pkgutil", "appx", "dpkg", "image", "python", "launchd", "service", "wsl-distro", "sbx"],
  ttlMs: SIX_HOURS,
  url(target) {
    const repo = githubRepo(target);
    return repo === null ? null : `https://api.github.com/repos/${repo}/releases?per_page=30`;
  },
  parse(status, body, _target, headers) {
    const limited = githubRateLimit(status, headers);
    if (limited) return { status: "failed", answers: [], message: limited };
    if (status === 404) return { status: "notfound", answers: [], message: "the source does not list this package" };
    if (status !== 200) return { status: "failed", answers: [], message: `HTTP ${status}` };
    let releases: unknown;
    try {
      releases = JSON.parse(body);
    } catch {
      return { status: "failed", answers: [], message: "response is not a releases array" };
    }
    if (!Array.isArray(releases)) return { status: "failed", answers: [], message: "response is not a releases array" };
    let stable: string | null = null;
    let beta: string | null = null;
    for (const release of releases) {
      if (!release || typeof release !== "object" || release.draft !== false || typeof release.prerelease !== "boolean" || typeof release.tag_name !== "string") continue;
      const version = VERSION.exec(release.tag_name)?.[1];
      if (!version) continue;
      if (release.prerelease) {
        if (beta === null || compareVersions(version, beta) === 1) beta = version;
      } else if (stable === null || compareVersions(version, stable) === 1) stable = version;
    }
    const answers: Answer[] = [];
    if (stable !== null) answers.push({ channel: "stable", version: stable, installable: false });
    if (beta !== null && (stable === null || compareVersions(beta, stable) === 1)) answers.push({ channel: "beta", version: beta, installable: false });
    return { status: "ok", answers };
  },
};
