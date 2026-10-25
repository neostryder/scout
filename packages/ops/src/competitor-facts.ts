// Scripted facts for one competitor research run: GitHub's releases, the commits between two versions with the files each one changed, the package manifest, and the license state.
// GitHub renders release notes with JavaScript, so a scraped page cannot show them; the API returns them as JSON. A span where every commit only moves the version fields of a manifest and no release has notes needs no research pass.
import { versionFromTag } from "./competitor-git.ts";

export type FactsFetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const FACTS_COMMIT_CAP = 30;
export const VERSION_FILES = ["module.json", "package.json", "manifest.json"] as const;
const VERSION_KEYS = ["version", "download"];
const MANIFEST_NAMES = ["module.json", "system.json", "manifest.json"] as const;
const WATCHED_MANIFEST_KEYS = ["id", "name", "title", "version", "compatibility", "minimumCoreVersion", "compatibleCoreVersion", "relationships", "dependencies", "system", "license", "url", "manifest", "download", "esmodules", "languages", "packs", "flags"] as const;
const REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_SLACK_MS = 12 * 60 * 60 * 1000;
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)(\.[a-z]+)?$/i;

export interface FactsInput {
  remoteUrl: string | null;
  from: { version: string | null; commit: string | null };
  to: { version: string | null; commit: string | null };
}

export interface CommitFacts { sha: string; date: string; subject: string; files: string[]; versionOnly: boolean | null }
export interface ReleaseFacts { tag: string; name: string | null; publishedAt: string | null; prerelease: boolean; draft: boolean; assetCount: number; hasNotes: boolean }
export interface ManifestFacts { file: string; values: Record<string, unknown> }
export interface FactsManifestChange { key: string; before: unknown; after: unknown }
export interface Facts {
  supported: boolean;
  repo: string | null;
  span: { fromVersion: string | null; toVersion: string | null; fromCommit: string | null; toCommit: string | null; commitCount: number; commitsListed: number; truncated: boolean };
  commits: CommitFacts[];
  releases: ReleaseFacts[];
  license: { spdx: string | null; fileInRepo: string | null; manifestDeclares: string | null };
  manifest: ManifestFacts | null;
  manifestChanges: FactsManifestChange[];
  dependencies: Array<{ id: string; type: string; version: string | null }>;
  errors: string[];
}
export interface Verdict { versionOnly: boolean; reason: string }

export function githubSlug(remoteUrl: string | null): { owner: string; repo: string } | null {
  const match = remoteUrl === null ? null : REMOTE.exec(remoteUrl.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/** True when every added or removed line of a manifest patch sets a version field and nothing else changes. */
export function patchIsVersionOnly(patch: string | undefined): boolean {
  if (patch === undefined || patch.trim() === "") return false;
  let changed = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    if (line[0] !== "+" && line[0] !== "-") continue;
    const body = line.slice(1).trim();
    if (body === "") return false;
    const key = /^"([^"]+)"\s*:/.exec(body)?.[1];
    if (key === undefined || !VERSION_KEYS.includes(key)) return false;
    changed++;
  }
  return changed > 0;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** One commit changes only manifest version fields. A commit that touches no files, such as a merge, does not count against the span. */
export function commitIsVersionOnly(files: Array<{ filename: string; patch?: string }>): boolean {
  return files.every((file) => (VERSION_FILES as readonly string[]).includes(baseName(file.filename)) && patchIsVersionOnly(file.patch));
}

export function judgeSpan(facts: Facts): Verdict {
  if (!facts.supported) return { versionOnly: false, reason: "the remote is not a GitHub repository, so the commits cannot be read" };
  if (facts.errors.length) return { versionOnly: false, reason: `a read failed: ${facts.errors[0]}` };
  if (facts.span.fromCommit === null) return { versionOnly: false, reason: "there is no earlier baseline to compare with" };
  if (facts.span.commitCount === 0) return { versionOnly: false, reason: "the span holds no commits" };
  if (facts.span.truncated) return { versionOnly: false, reason: `the span has ${facts.span.commitCount} commits and only the newest ${facts.span.commitsListed} were read` };
  const touching = facts.commits.filter((commit) => commit.files.length > 0);
  if (touching.length === 0) return { versionOnly: false, reason: "no commit in the span lists a changed file" };
  const other = facts.commits.find((commit) => commit.files.length > 0 && commit.versionOnly !== true);
  if (other) return { versionOnly: false, reason: `commit ${other.sha.slice(0, 7)} changes more than manifest version fields (${other.files.slice(0, 3).join(", ")})` };
  const withNotes = facts.releases.find((release) => release.hasNotes);
  if (withNotes) return { versionOnly: false, reason: `release ${withNotes.tag} carries notes` };
  return { versionOnly: true, reason: `${touching.length} commit${touching.length === 1 ? " changes" : "s change"} only version fields of ${[...new Set(touching.flatMap((commit) => commit.files.map(baseName)))].join(", ")} and no release in the span has notes` };
}

const FILLER_WORDS = new Set(["release", "released", "version", "v", "new", "full", "changelog", "update", "bump"]);

/** A release body that only restates the tag, the release name, or the repository, or that holds nothing but a changelog link, says nothing about what changed. */
export function isPlaceholderNotes(body: string | null | undefined, tag: string, name: string | null, repo: string): boolean {
  const text = (body ?? "").replace(/https?:\/\/\S+/g, " ");
  const known = new Set([...[tag, name ?? "", repo].flatMap((part) => part.toLowerCase().split(/[^a-z0-9]+/)), ...FILLER_WORDS].filter((word) => word !== ""));
  const versionLike = (word: string): boolean => /^v?\d+$/.test(word);
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "").every((word) => known.has(word) || versionLike(word) || word.length <= 1);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of WATCHED_MANIFEST_KEYS) if (manifest[key] !== undefined) picked[key] = manifest[key];
  return picked;
}

export function diffManifest(before: Record<string, unknown> | null, after: Record<string, unknown> | null): FactsManifestChange[] {
  if (before === null || after === null) return [];
  const changes: FactsManifestChange[] = [];
  for (const key of WATCHED_MANIFEST_KEYS) {
    const left = JSON.stringify(before[key] ?? null);
    const right = JSON.stringify(after[key] ?? null);
    if (left !== right) changes.push({ key, before: before[key] ?? null, after: after[key] ?? null });
  }
  return changes;
}

/** Every package the manifest depends on, from the current relationships block or the older flat fields. */
export function manifestDependencies(manifest: Record<string, unknown> | null): Array<{ id: string; type: string; version: string | null }> {
  if (manifest === null) return [];
  const found: Array<{ id: string; type: string; version: string | null }> = [];
  const add = (entry: unknown, type: string): void => {
    if (typeof entry === "string") { found.push({ id: entry, type, version: null }); return; }
    if (!record(entry) || typeof entry["id"] !== "string") return;
    const compatibility = record(entry["compatibility"]) ? entry["compatibility"] : {};
    const version = [compatibility["verified"], compatibility["minimum"], entry["version"]].find((value) => typeof value === "string");
    found.push({ id: entry["id"], type: typeof entry["type"] === "string" ? entry["type"] : type, version: typeof version === "string" ? version : null });
  };
  const relationships = record(manifest["relationships"]) ? manifest["relationships"] : {};
  for (const [group, entries] of Object.entries(relationships)) if (Array.isArray(entries)) for (const entry of entries) add(entry, group);
  if (Array.isArray(manifest["dependencies"])) for (const entry of manifest["dependencies"]) add(entry, "dependencies");
  if (typeof manifest["system"] === "string") add(manifest["system"], "system");
  else if (Array.isArray(manifest["system"])) for (const entry of manifest["system"]) add(entry, "system");
  return found;
}

function declaredLicense(manifest: Record<string, unknown> | null): string | null {
  const value = manifest?.["license"];
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 120) : null;
}

export async function gatherFacts(input: FactsInput, fetcher: FactsFetcher, options: { token?: string | null } = {}): Promise<Facts> {
  const facts: Facts = {
    supported: false,
    repo: null,
    span: { fromVersion: input.from.version, toVersion: input.to.version, fromCommit: input.from.commit, toCommit: input.to.commit, commitCount: 0, commitsListed: 0, truncated: false },
    commits: [], releases: [], license: { spdx: null, fileInRepo: null, manifestDeclares: null }, manifest: null, manifestChanges: [], dependencies: [], errors: [],
  };
  const parsed = githubSlug(input.remoteUrl);
  if (!parsed) return facts;
  facts.supported = true;
  const slug = `${parsed.owner}/${parsed.repo}`;
  facts.repo = `https://github.com/${slug}`;
  const headers = (accept: string): Record<string, string> => ({ accept, "user-agent": "scout-competitor-facts", "x-github-api-version": "2022-11-28", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) });
  const api = async (path: string, accept = "application/vnd.github+json"): Promise<unknown> => {
    const response = await fetcher(`https://api.github.com/repos/${slug}${path}`, { headers: headers(accept), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path.split("?")[0] || "/"}`);
    return accept.includes("raw") ? response.text() : response.json();
  };
  const attempt = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); } catch (error) { facts.errors.push(error instanceof Error ? error.message.slice(0, 200) : "read failed"); return fallback; }
  };

  const repoInfo = await attempt(() => api(""), null as unknown);
  if (record(repoInfo) && record(repoInfo["license"]) && typeof repoInfo["license"]["spdx_id"] === "string" && repoInfo["license"]["spdx_id"] !== "NOASSERTION") facts.license.spdx = repoInfo["license"]["spdx_id"];

  const toRef = input.to.commit && SHA.test(input.to.commit) ? input.to.commit : (record(repoInfo) && typeof repoInfo["default_branch"] === "string" ? repoInfo["default_branch"] : "HEAD");
  const listing = await attempt(() => api(`/contents?ref=${encodeURIComponent(toRef)}`), [] as unknown);
  if (Array.isArray(listing)) {
    const names = listing.filter(record).map((entry) => entry["name"]).filter((name): name is string => typeof name === "string");
    facts.license.fileInRepo = names.find((name) => LICENSE_FILE.test(name)) ?? null;
    const manifestName = MANIFEST_NAMES.find((name) => names.includes(name));
    if (manifestName) {
      const now = await attempt(async () => JSON.parse(await api(`/contents/${manifestName}?ref=${encodeURIComponent(toRef)}`, "application/vnd.github.raw+json") as string) as unknown, null as unknown);
      if (record(now)) {
        facts.manifest = { file: manifestName, values: pickManifest(now) };
        facts.dependencies = manifestDependencies(now);
        facts.license.manifestDeclares = declaredLicense(now);
        if (input.from.commit && SHA.test(input.from.commit)) {
          const before = await attempt(async () => JSON.parse(await api(`/contents/${manifestName}?ref=${input.from.commit}`, "application/vnd.github.raw+json") as string) as unknown, null as unknown);
          if (record(before)) facts.manifestChanges = diffManifest(before, now);
        }
      }
    }
  }

  let fromDate: string | null = null;
  let toDate: string | null = null;
  if (input.from.commit && SHA.test(input.from.commit) && input.to.commit && SHA.test(input.to.commit)) {
    const compared = await attempt(() => api(`/compare/${input.from.commit}...${input.to.commit}?per_page=100`), null as unknown);
    if (record(compared)) {
      const list = Array.isArray(compared["commits"]) ? compared["commits"].filter(record) : [];
      const total = typeof compared["total_commits"] === "number" ? compared["total_commits"] : list.length;
      facts.span.commitCount = total;
      const base = record(compared["base_commit"]) && record(compared["base_commit"]["commit"]) && record(compared["base_commit"]["commit"]["committer"]) ? compared["base_commit"]["commit"]["committer"]["date"] : null;
      fromDate = typeof base === "string" ? base : null;
      const last = list[list.length - 1];
      const lastDate = last && record(last["commit"]) && record(last["commit"]["committer"]) ? last["commit"]["committer"]["date"] : null;
      toDate = typeof lastDate === "string" ? lastDate : null;
      const newest = list.slice(-FACTS_COMMIT_CAP).reverse();
      facts.span.truncated = total > newest.length;
      for (const entry of newest) {
        const sha = typeof entry["sha"] === "string" ? entry["sha"] : "";
        if (!SHA.test(sha)) continue;
        const commit = record(entry["commit"]) ? entry["commit"] : {};
        const message = typeof commit["message"] === "string" ? commit["message"].split(/\r?\n/)[0]!.slice(0, 200) : "";
        const committer = record(commit["committer"]) && typeof commit["committer"]["date"] === "string" ? commit["committer"]["date"] : "";
        const detail = await attempt(() => api(`/commits/${sha}`), null as unknown);
        const files = record(detail) && Array.isArray(detail["files"]) ? detail["files"].filter(record).map((file) => ({ filename: String(file["filename"] ?? ""), patch: typeof file["patch"] === "string" ? file["patch"] : undefined })) : null;
        facts.commits.push({ sha, date: committer, subject: message, files: files?.map((file) => file.filename) ?? [], versionOnly: files === null ? null : commitIsVersionOnly(files) });
      }
      facts.span.commitsListed = facts.commits.length;
    }
  }

  const releases = await attempt(() => api("/releases?per_page=50"), [] as unknown);
  if (Array.isArray(releases)) {
    for (const entry of releases.filter(record)) {
      const tag = typeof entry["tag_name"] === "string" ? entry["tag_name"] : "";
      const published = typeof entry["published_at"] === "string" ? entry["published_at"] : null;
      if (!tag || (fromDate !== null && published !== null && published <= fromDate)) continue;
      if (toDate !== null && published !== null && Date.parse(published) > Date.parse(toDate) + RELEASE_SLACK_MS) continue;
      if (input.from.version !== null && versionFromTag(tag) === input.from.version) continue;
      facts.releases.push({
        tag, name: typeof entry["name"] === "string" && entry["name"] !== tag ? entry["name"].slice(0, 120) : null, publishedAt: published,
        prerelease: entry["prerelease"] === true, draft: entry["draft"] === true,
        assetCount: Array.isArray(entry["assets"]) ? entry["assets"].length : 0,
        hasNotes: typeof entry["body"] === "string" && entry["body"].trim() !== "" && !isPlaceholderNotes(entry["body"], tag, typeof entry["name"] === "string" ? entry["name"] : null, parsed.repo),
      });
    }
  }
  return facts;
}

function plain(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value)).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

/** The release file body for a span that needed no research pass, written from the facts alone. */
export function versionOnlyDraft(name: string, facts: Facts, verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(`# ${plain(name)} ${plain(facts.span.fromVersion ?? "?")} to ${plain(facts.span.toVersion ?? "?")}`, "");
  lines.push("Version-only, no research run.", "", `Basis: ${verdict.reason}.`, "");
  lines.push("## Commits", "");
  for (const commit of facts.commits) lines.push(`- ${commit.sha.slice(0, 7)} ${commit.date.slice(0, 10)} ${plain(commit.subject)} (${commit.files.map(plain).join(", ") || "no files listed"})`);
  lines.push("", "## Releases", "");
  if (facts.releases.length === 0) lines.push("- None published in the span.");
  for (const release of facts.releases) lines.push(`- ${plain(release.tag)}${release.publishedAt ? ` on ${release.publishedAt.slice(0, 10)}` : ""}: ${release.assetCount} asset${release.assetCount === 1 ? "" : "s"}, no notes${release.prerelease ? ", prerelease" : ""}.`);
  lines.push("", "## Dependencies", "");
  if (facts.dependencies.length === 0) lines.push("- None declared in the manifest.");
  for (const dependency of facts.dependencies) lines.push(`- ${plain(dependency.id)} (${plain(dependency.type)})${dependency.version ? ` ${plain(dependency.version)}` : ""}`);
  const compatibility = facts.manifest?.values["compatibility"];
  if (compatibility !== undefined) lines.push("", "## Compatibility", "", `- ${plain(compatibility)}`);
  lines.push("", "## License", "");
  lines.push(`- Repository file: ${facts.license.fileInRepo ?? "none"}.`, `- GitHub license: ${facts.license.spdx ?? "none detected"}.`, `- Manifest declares: ${facts.license.manifestDeclares ?? "nothing"}.`);
  lines.push("", "## Sources", "", `- ${facts.repo ?? "unknown"} through the GitHub API: releases, compare, commits, contents.`, "- Nothing here was read by a model.", "");
  return lines.join("\n");
}
