import { compareVersions } from "@scout/core";
import { DAILY, type Answer, type Researcher, type ResearchTarget, type Researched } from "./types.ts";

// GitHub's compare of {clone}...{default branch} reports ahead_by as the commits on the default branch that the clone does not have. behind_by counts the other direction.
const REPO_KEY = /^github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const AFTER_TAG = /^(.*)-(\d+)-g[0-9a-f]+$/i;

interface Step {
  url: string;
  status: number;
  body: string;
}

interface ReleaseInfo {
  tag: string;
  publishedAt: string | null;
  url: string | null;
}

function repoParts(key: string): { owner: string; repo: string } | null {
  const match = REPO_KEY.exec(key);
  if (!match) return null;
  const owner = match[1] ?? "";
  const repo = match[2] ?? "";
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo };
}

function safeRef(ref: string): boolean {
  return ref.length > 0 && ref.length < 256 && !ref.includes("..") && /^[A-Za-z0-9._/-]+$/.test(ref);
}

function objectOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return null;
}

function arrayOf(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  return null;
}

function textField(doc: Record<string, unknown> | null, key: string): string | null {
  const value = doc?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stepsOf(body: string): Step[] | null {
  const rows = arrayOf(body);
  if (!rows) return null;
  const steps: Step[] = [];
  for (const row of rows) {
    const doc = plainObject(row);
    if (!doc || typeof doc["url"] !== "string" || typeof doc["status"] !== "number" || typeof doc["body"] !== "string") return null;
    steps.push({ url: doc["url"], status: doc["status"], body: doc["body"] });
  }
  return steps;
}

function stepKind(url: string): "repo" | "release" | "tags" | "commit" | "compare" | "other" {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return "other";
  }
  if (path.endsWith("/releases/latest")) return "release";
  if (path.endsWith("/tags")) return "tags";
  if (path.includes("/compare/")) return "compare";
  if (path.includes("/commits/")) return "commit";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "repo";
  return "other";
}

function cloneCommit(details: Record<string, unknown>): string | null {
  const commit = details["commit"];
  return typeof commit === "string" && COMMIT.test(commit) ? commit.toLowerCase() : null;
}

function headAt(doc: Record<string, unknown> | null): string | null {
  const commit = plainObject(doc?.["commit"]);
  const committer = plainObject(commit?.["committer"]);
  return textField(committer, "date");
}

function releaseOf(doc: Record<string, unknown> | null): ReleaseInfo | null {
  if (!doc || doc["draft"] === true || doc["prerelease"] === true) return null;
  const tag = textField(doc, "tag_name");
  if (!tag) return null;
  return { tag, publishedAt: textField(doc, "published_at"), url: textField(doc, "html_url") };
}

function tagNames(body: string): string[] {
  const rows = arrayOf(body);
  if (!rows) return [];
  const names: string[] = [];
  for (const row of rows) {
    const name = textField(plainObject(row), "name");
    if (name) names.push(name);
  }
  return names;
}

// The tags endpoint is ordered by commit date, so the first name is not the highest version.
function newestOf(names: string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (compareVersions(name, name) === null) continue;
    if (best === null || compareVersions(name, best) === 1) best = name;
  }
  return best;
}

function behindFrom(doc: Record<string, unknown> | null): number | null {
  const value = doc?.["ahead_by"];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function apiBase(key: string): string | null {
  const parts = repoParts(key);
  return parts ? `https://api.github.com/repos/${parts.owner}/${parts.repo}` : null;
}

export function mergeCloneIntel(previous: Record<string, unknown> | null, incoming: Record<string, unknown>): Record<string, unknown> {
  const prior = plainObject(previous?.["clones"]) ?? {};
  const next = plainObject(incoming["clones"]) ?? {};
  const clones: Record<string, unknown> = {};
  for (const [key, value] of [...Object.entries(next), ...Object.entries(prior)]) {
    if (Object.keys(clones).length >= 20) break;
    if (Object.prototype.hasOwnProperty.call(clones, key)) continue;
    clones[key] = value;
  }
  return { ...incoming, clones };
}

// A clone is behind a newer release when nearestTag compares lower than the release tag, or when describe shows commits after its tag and that release is newer than the tag.
export function cloneBehindRelease(nearestTag: string | null, describe: string | null, releaseTag: string | null): boolean {
  if (releaseTag === null || releaseTag === "") return false;
  if (nearestTag && compareVersions(nearestTag, releaseTag) === -1) return true;
  const match = AFTER_TAG.exec(describe ?? "");
  if (!match) return false;
  const commits = Number(match[2]);
  if (!Number.isInteger(commits) || commits <= 0) return false;
  return compareVersions(releaseTag, match[1] ?? "") === 1;
}

export const gitclone: Researcher = {
  source: "gitclone",
  ecosystems: ["gitclone"],
  ttlMs: DAILY,
  url(target) {
    return apiBase(target.key);
  },
  follow(target, prior) {
    const base = apiBase(target.key);
    if (!base) return null;
    const repo = prior.find((step) => step.url === base);
    if (!repo || repo.status !== 200) return null;
    const branch = textField(objectOf(repo.body), "default_branch");
    const releaseUrl = `${base}/releases/latest`;
    if (!prior.some((step) => step.url === releaseUrl)) return releaseUrl;
    const release = prior.find((step) => step.url === releaseUrl);
    const tagsUrl = `${base}/tags?per_page=100`;
    if (release?.status === 404 && !prior.some((step) => step.url === tagsUrl)) return tagsUrl;
    if (!branch || !safeRef(branch)) return null;
    const commitUrl = `${base}/commits/${encodeURIComponent(branch)}`;
    if (!prior.some((step) => step.url === commitUrl)) return commitUrl;
    const commit = cloneCommit(target.details);
    if (!commit) return null;
    const head = textField(objectOf(prior.find((step) => step.url === commitUrl)?.body ?? ""), "sha")?.toLowerCase() ?? null;
    if (head === commit) return null;
    const compareUrl = `${base}/compare/${commit}...${encodeURIComponent(branch)}`;
    if (!prior.some((step) => step.url === compareUrl)) return compareUrl;
    return null;
  },
  parse(_status, body, target): Researched {
    const steps = stepsOf(body);
    const repo = steps?.find((step) => stepKind(step.url) === "repo");
    if (!repo) return { status: "failed", answers: [], message: "response is not a JSON object" };
    if (repo.status === 404) return { status: "notfound", answers: [], message: "the source does not list this package" };
    if (repo.status !== 200) return { status: "failed", answers: [], message: `HTTP ${repo.status}` };
    const repoDoc = objectOf(repo.body);
    if (!repoDoc) return { status: "failed", answers: [], message: "response is not a JSON object" };
    const releaseStep = steps?.find((step) => stepKind(step.url) === "release");
    const release = releaseStep?.status === 200 ? releaseOf(objectOf(releaseStep.body)) : null;
    const tagsStep = steps?.find((step) => stepKind(step.url) === "tags");
    const newestTag = release ? release.tag : tagsStep?.status === 200 ? newestOf(tagNames(tagsStep.body)) : null;
    const commitStep = steps?.find((step) => stepKind(step.url) === "commit");
    const commitDoc = commitStep?.status === 200 ? objectOf(commitStep.body) : null;
    const headSha = textField(commitDoc, "sha")?.toLowerCase() ?? null;
    const compareStep = steps?.find((step) => stepKind(step.url) === "compare");
    const commit = cloneCommit(target.details);
    let behindBy: number | null = null;
    let behindKnown = false;
    const clones: Record<string, number | null> = {};
    if (commit && headSha === commit) {
      behindBy = 0;
      behindKnown = true;
      clones[commit] = 0;
    } else if (commit && compareStep?.status === 200) {
      const measured = behindFrom(objectOf(compareStep.body));
      behindBy = measured;
      behindKnown = measured !== null;
      clones[commit] = measured;
    } else if (commit && compareStep?.status === 404) {
      clones[commit] = null;
    }
    const answers: Answer[] = [];
    // compareVersions strips a leading v, so the assertion keeps the tag the release published.
    if (release) answers.push({ channel: "stable", version: release.tag, installable: false });
    return {
      status: "ok",
      answers,
      intel: {
        defaultBranch: textField(repoDoc, "default_branch"),
        headSha,
        headAt: headAt(commitDoc),
        latestRelease: release,
        newestTag,
        behindBy,
        behindKnown,
        archived: repoDoc["archived"] === true,
        checkedAt: target.observedAt ?? "",
        clones,
      },
    };
  },
};
