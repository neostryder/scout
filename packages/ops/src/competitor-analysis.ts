// Procedural reading of one mirror range. The weights and the score formula are the whole size model:
// churn is added lines plus deleted lines, times the category weight, and
// score = round(clamp(0, 100, 100 * log10(1 + churn) / log10(1 + 5000))).
// source 1, tests 0.35, config 0.25, manifest 0.2, other 0.2, docs 0.05, assets 0.05, generated 0.05, lockfile 0.02.

export const MANIFEST_FILES = ["package.json", "module.json", "manifest.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;
export const ANALYSIS_BYTE_CAP = 64 * 1024;
export const CHANGE_SCORE_BASE = 5000;
export const LARGE_REWRITE_SCORE = 70;
export const TINY_SCORE = 10;
export const DEFAULT_REA_SOURCE_SCORE = 40;
export const OUTBOUND_ALLOW_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "example.com", "example.test", "github.com", "gitlab.com", "codeberg.org", "bitbucket.org", "schema.org", "www.w3.org", "json-schema.org"] as const;

const WEIGHTS = { source: 1, tests: 0.35, config: 0.25, manifest: 0.2, other: 0.2, docs: 0.05, assets: 0.05, generated: 0.05, lockfile: 0.02 } as const;
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "go.sum", "poetry.lock", "composer.lock", "gemfile.lock", "packages.lock.json", "bun.lock", "uv.lock"]);
const MANIFESTS = new Set(MANIFEST_FILES.map((name) => name.toLowerCase()));
const SOURCE = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs", "rb", "php", "java", "kt", "kts", "scala", "cs", "fs", "vb", "cpp", "cc", "cxx", "c", "h", "hpp", "hh", "vue", "svelte", "css", "scss", "less", "sass", "html", "htm"]);
const ASSETS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "woff", "woff2", "ttf", "otf", "eot", "mp3", "wav", "ogg", "mp4", "webm"]);
const PRICE_WORDS = new Set(["pricing", "prices", "price", "plans", "plan", "licensing", "licences", "licenses", "licence", "license"]);
const PRICE_LINE = /\b(price|plan|tier|subscription|license|free|trial|per month)\b/i;
const NOTES_FILE = /^(changelog|changes|release|history)/i;
const HOST_PATTERN = "https?:\\/\\/([^/\\s'\"<>\\\\)#?]+)";
const ALLOW = new Set<string>(OUTBOUND_ALLOW_HOSTS);
const COMMIT_TYPE = /^(feat|fix|docs|chore|refactor|test|build|ci)(?:\([^)\r\n]*\))?(!)?:(?:\s|$)/i;
const TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "build", "ci", "other"] as const;

export type FileCategory = keyof typeof WEIGHTS;
export interface CommitClasses { feat: number; fix: number; docs: number; chore: number; refactor: number; test: number; build: number; ci: number; other: number; breaking: number }
export interface FileCategories { source: number; tests: number; docs: number; config: number; assets: number; generated: number; lockfile: number; manifest: number; other: number }
export interface ManifestChange {
  path: string;
  malformed: boolean;
  version: { from: string | null; to: string | null } | null;
  dependenciesAdded: { name: string; range: string }[];
  dependenciesRemoved: { name: string; range: string }[];
  permissionsAdded: string[];
  permissionsRemoved: string[];
  entryPointsChanged: string[];
}
export interface AnalysisFlags {
  minifiedOrGenerated: boolean;
  docsOnly: boolean;
  dependencyBumpOnly: boolean;
  largeRewrite: boolean;
  reaRecommended: boolean;
  reaReason: string;
}
export interface ChangeAnalysis {
  baseline?: "none";
  commitClasses: CommitClasses;
  fileCategories: FileCategories;
  changeSize: { files: number; added: number; deleted: number; score: number };
  manifestDiff: ManifestChange[];
  newOutboundHosts: { host: string; file: string }[];
  newSettingsKeys: string[];
  addedFiles: string[];
  removedFiles: string[];
  renamed: number;
  changelog: { text: string; releaseNotesFound: boolean };
  pricingFiles: string[];
  pricingTermsAdded: string[];
  flags: AnalysisFlags;
  truncated: boolean;
}

export interface ChangeInput {
  baseline?: "none";
  logText?: string;
  numstatText?: string;
  nameStatusText?: string;
  diffText?: string;
  manifests?: { path: string; before: string | null; after: string | null }[];
  oldFiles?: { path: string; text: string }[];
  remoteHost?: string | null;
  shipsCode?: boolean;
  reaSourceScore?: number;
}

interface NameStatus { status: string; path: string; oldPath?: string }
interface ManifestFacts { version: string | null; dependencies: { name: string; range: string }[]; permissions: string[]; entryPoints: string[]; malformed: boolean }
interface FileDiff { path: string; added: string[]; removed: string[]; context: string[]; raw: string }

/** One row per category, first match wins. `generated` includes minified bundles. */
export function categoryForPath(filePath: string): FileCategory {
  const path = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const name = baseName(path).toLowerCase();
  if (LOCKFILES.has(name)) return "lockfile";
  if (MANIFESTS.has(name)) return "manifest";
  if (isGenerated(path, name)) return "generated";
  if (isTest(path, name)) return "tests";
  if (isDoc(path, name)) return "docs";
  if (ASSETS.has(extension(name))) return "assets";
  if (isConfig(path, name)) return "config";
  if (SOURCE.has(extension(name))) return "source";
  return "other";
}

export function changeSizeScore(churn: number): number {
  if (!(churn > 0)) return 0;
  const score = Math.round((100 * Math.log10(1 + churn)) / Math.log10(1 + CHANGE_SCORE_BASE));
  return Math.max(0, Math.min(100, score));
}

export function analyzeChange(input: ChangeInput): ChangeAnalysis {
  const manifests = (input.manifests ?? []).map((file) => diffManifest(file.path, file.before, file.after));
  if (input.baseline === "none") {
    return capAnalysis({
      baseline: "none",
      commitClasses: emptyClasses(),
      fileCategories: emptyCategories(),
      changeSize: { files: 0, added: 0, deleted: 0, score: 0 },
      manifestDiff: manifests,
      newOutboundHosts: [],
      newSettingsKeys: [],
      addedFiles: [],
      removedFiles: [],
      renamed: 0,
      changelog: { text: "", releaseNotesFound: false },
      pricingFiles: [],
      pricingTermsAdded: [],
      flags: { minifiedOrGenerated: false, docsOnly: false, dependencyBumpOnly: false, largeRewrite: false, reaRecommended: false, reaReason: "no baseline" },
      truncated: false,
    });
  }
  const names = parseNameStatus(input.nameStatusText ?? "");
  const stats = parseNumstat(input.numstatText ?? "");
  const diffs = parseDiff(input.diffText ?? "");
  const categories = emptyCategories();
  let added = 0;
  let deleted = 0;
  let generatedChurn = 0;
  const seen = new Set<string>();
  for (const file of names) {
    const path = file.path.replaceAll("\\", "/");
    if (seen.has(path)) continue;
    seen.add(path);
    const category = categoryForPath(path);
    categories[category] += 1;
    const stat = stats.get(path) ?? stats.get(normalizeNumstatPath(path));
    const churn = stat ? stat.added + stat.deleted : 0;
    added += stat?.added ?? 0;
    deleted += stat?.deleted ?? 0;
    if (category === "generated") generatedChurn += churn;
  }
  for (const [path, stat] of stats) {
    if (seen.has(path)) continue;
    const category = categoryForPath(path);
    categories[category] += 1;
    seen.add(path);
    added += stat.added;
    deleted += stat.deleted;
    if (category === "generated") generatedChurn += stat.added + stat.deleted;
  }
  const churn = weightedChurn(stats, seen);
  const score = changeSizeScore(churn);
  const totalChurn = added + deleted;
  const commitClasses = commitCounts(input.logText ?? "");
  const addedFiles = names.filter((file) => file.status === "A").map((file) => file.path.replaceAll("\\", "/")).slice(0, 100);
  const removedFiles = names.filter((file) => file.status === "D").map((file) => file.path.replaceAll("\\", "/")).slice(0, 100);
  const renamed = names.filter((file) => file.status.startsWith("R") || file.status.startsWith("C")).length;
  const oldByPath = new Map((input.oldFiles ?? []).map((file) => [file.path.replaceAll("\\", "/"), file.text]));
  const hosts = newHosts(diffs, oldByPath, input.remoteHost ?? null);
  const settings = settingKeys(diffs);
  const pricingFiles = [...seen].filter((path) => pricingName(path));
  const pricingTermsAdded = pricingLines(diffs, new Set(pricingFiles));
  const changelog = changelogOf(diffs, names);
  const dependencyChanged = manifests.some((file) => file.dependenciesAdded.length > 0 || file.dependenciesRemoved.length > 0);
  const onlyDeps = seen.size > 0 && [...seen].every((path) => {
    const category = categoryForPath(path);
    return category === "lockfile" || category === "manifest";
  });
  const docsOnly = seen.size > 0 && [...seen].every((path) => categoryForPath(path) === "docs");
  const dependencyBumpOnly = onlyDeps && (dependencyChanged || [...seen].some((path) => categoryForPath(path) === "lockfile"));
  const minifiedChanged = generatedChurn > 0;
  const minifiedOrGenerated = totalChurn > 0 && generatedChurn * 2 > totalChurn;
  const permissionsAdded = manifests.some((file) => file.permissionsAdded.length > 0);
  const flags = decideFlags({
    shipsCode: input.shipsCode === true,
    docsOnly,
    dependencyBumpOnly,
    minifiedOrGenerated,
    minifiedChanged,
    largeRewrite: score >= LARGE_REWRITE_SCORE,
    hosts: hosts.length > 0,
    permissionsAdded,
    score,
    threshold: input.reaSourceScore ?? DEFAULT_REA_SOURCE_SCORE,
  });
  return capAnalysis({
    commitClasses,
    fileCategories: categories,
    changeSize: { files: seen.size, added, deleted, score },
    manifestDiff: manifests,
    newOutboundHosts: hosts,
    newSettingsKeys: settings,
    addedFiles,
    removedFiles,
    renamed,
    changelog,
    pricingFiles,
    pricingTermsAdded,
    flags,
    truncated: false,
  });
}

function weightedChurn(stats: Map<string, { added: number; deleted: number }>, seen: Set<string>): number {
  let churn = 0;
  for (const path of seen) {
    const stat = stats.get(path);
    const lines = stat ? stat.added + stat.deleted : 0;
    churn += lines * WEIGHTS[categoryForPath(path)];
  }
  return churn;
}

function decideFlags(input: { shipsCode: boolean; docsOnly: boolean; dependencyBumpOnly: boolean; minifiedOrGenerated: boolean; minifiedChanged: boolean; largeRewrite: boolean; hosts: boolean; permissionsAdded: boolean; score: number; threshold: number }): AnalysisFlags {
  const base = { minifiedOrGenerated: input.minifiedOrGenerated, docsOnly: input.docsOnly, dependencyBumpOnly: input.dependencyBumpOnly, largeRewrite: input.largeRewrite, reaRecommended: false, reaReason: "no shipped code" };
  if (!input.shipsCode) return base;
  if (input.docsOnly) return { ...base, reaReason: "docs only" };
  if (input.dependencyBumpOnly) return { ...base, reaReason: "dependency bump only" };
  if (input.hosts) return { ...base, reaRecommended: true, reaReason: "new outbound host" };
  if (input.permissionsAdded) return { ...base, reaRecommended: true, reaReason: "new permission" };
  if (input.minifiedChanged) return { ...base, reaRecommended: true, reaReason: "minified code changed" };
  if (input.score >= input.threshold) return { ...base, reaRecommended: true, reaReason: `source score ${input.score}` };
  if (input.score < TINY_SCORE) return { ...base, reaReason: "change is tiny" };
  return { ...base, reaReason: "below the source score threshold" };
}

function emptyClasses(): CommitClasses {
  return { feat: 0, fix: 0, docs: 0, chore: 0, refactor: 0, test: 0, build: 0, ci: 0, other: 0, breaking: 0 };
}

function emptyCategories(): FileCategories {
  return { source: 0, tests: 0, docs: 0, config: 0, assets: 0, generated: 0, lockfile: 0, manifest: 0, other: 0 };
}

function commitCounts(text: string): CommitClasses {
  const counts = emptyClasses();
  for (const record of text.split("\x1e")) {
    if (!record.trim()) continue;
    const parts = record.split("\x1f");
    const subject = parts[2] ?? "";
    const body = parts.slice(3).join("\x1f");
    if (!subject && !parts[0]) continue;
    const match = COMMIT_TYPE.exec(subject.trim());
    const type = (match?.[1] ?? "other").toLowerCase();
    if ((TYPES as readonly string[]).includes(type)) counts[type as keyof Omit<CommitClasses, "breaking">] += 1;
    else counts.other += 1;
    const breakingBody = body.split(/\r?\n/).some((line) => line.includes("BREAKING"));
    if (subject.includes("!:") || breakingBody) counts.breaking += 1;
  }
  return counts;
}

function parseNameStatus(text: string): NameStatus[] {
  const files: NameStatus[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = parts[2];
      if (path) files.push({ status: status[0] ?? "R", path, oldPath: parts[1] });
    } else if (parts[1]) files.push({ status: status[0] ?? "M", path: parts[1] });
  }
  return files;
}

function parseNumstat(text: string): Map<string, { added: number; deleted: number }> {
  const files = new Map<string, { added: number; deleted: number }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    if (!Number.isInteger(added) || !Number.isInteger(deleted)) continue;
    const path = normalizeNumstatPath(parts.slice(2).join("\t"));
    if (path) files.set(path, { added, deleted });
  }
  return files;
}

function normalizeNumstatPath(raw: string): string {
  const text = raw.replaceAll("\\", "/").trim();
  const wrapped = /^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/.exec(text);
  if (wrapped) return `${wrapped[1] ?? ""}${wrapped[3] ?? ""}${wrapped[4] ?? ""}`;
  const plain = /^(.*) => (.*)$/.exec(text);
  return plain?.[2] ? plain[2] : text;
}

function parseDiff(text: string): FileDiff[] {
  const chunks = text.split(/^diff --git /m).slice(1);
  const files: FileDiff[] = [];
  for (const chunk of chunks) {
    const lines = (`diff --git ${chunk}`).split(/\r?\n/);
    let path = "";
    const added: string[] = [];
    const removed: string[] = [];
    const context: string[] = [];
    for (const line of lines) {
      if (line.startsWith("--- ")) {
        const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
        if (!path && raw !== "/dev/null") path = raw.replace(/^a\//, "");
        continue;
      }
      if (line.startsWith("+++ ")) {
        const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
        if (raw !== "/dev/null") path = raw.replace(/^b\//, "");
        continue;
      }
      if (line.startsWith("+")) added.push(line.slice(1));
      else if (line.startsWith("-")) removed.push(line.slice(1));
      else if (line.startsWith("@@") || line.startsWith("\\") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("old mode") || line.startsWith("new mode")) continue;
      else context.push(line.startsWith(" ") ? line.slice(1) : line);
    }
    if (path) files.push({ path: path.replaceAll("\\", "/"), added, removed, context, raw: lines.join("\n") });
  }
  return files;
}

function newHosts(files: FileDiff[], oldByPath: Map<string, string>, remoteHost: string | null): { host: string; file: string }[] {
  const found: { host: string; file: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const oldText = oldByPath.get(file.path);
    const oldHosts = hostsIn(oldText ?? [...file.removed, ...file.context].join("\n"));
    for (const host of hostsIn(file.added.join("\n"))) {
      if (seen.has(host) || oldHosts.has(host) || hostAllowed(host, remoteHost)) continue;
      seen.add(host);
      found.push({ host, file: file.path });
      if (found.length >= 50) return found;
    }
  }
  return found;
}

function hostsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(HOST_PATTERN, "gi"))) {
    const host = cleanHost(match[1] ?? "");
    if (host) found.add(host);
  }
  return found;
}

function cleanHost(raw: string): string | null {
  const afterUser = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  const host = afterUser.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
  if (!host || host.length > 253) return null;
  if (!/^[a-z0-9._-]+$/.test(host)) return null;
  return host;
}

function hostAllowed(host: string, remoteHost: string | null): boolean {
  const names = host.startsWith("www.") ? [host, host.slice(4)] : [host, `www.${host}`];
  const remote = remoteHost?.toLowerCase() ?? "";
  return names.some((name) => name === remote || ALLOW.has(name));
}

function settingKeys(files: FileDiff[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const patterns: { re: RegExp; join: boolean }[] = [
    { re: /game\.settings\.register\(\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/, join: true },
    { re: /registerSetting\(\s*['"]([^'"]+)['"]/, join: false },
    { re: /config\.get\(\s*['"]([^'"]+)['"]/, join: false },
    { re: /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/, join: false },
  ];
  for (const file of files) {
    for (const line of file.added) {
      for (const pattern of patterns) {
        const match = pattern.re.exec(line);
        const first = match?.[1];
        if (!first) continue;
        const key = pattern.join && match?.[2] ? `${first}.${match[2]}` : first;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
        if (keys.length >= 100) return keys;
      }
    }
  }
  return keys;
}

function pricingLines(files: FileDiff[], pricing: Set<string>): string[] {
  const lines: string[] = [];
  for (const file of files) {
    if (!pricing.has(file.path)) continue;
    for (const line of file.added) {
      const text = line.trim();
      if (!text || !PRICE_LINE.test(text)) continue;
      lines.push(text.slice(0, 200));
      if (lines.length >= 40) return lines;
    }
  }
  return lines;
}

function changelogOf(files: FileDiff[], names: NameStatus[]): { text: string; releaseNotesFound: boolean } {
  const paths = new Set(names.map((file) => file.path.replaceAll("\\", "/")).filter((path) => NOTES_FILE.test(baseName(path))));
  for (const file of files) if (NOTES_FILE.test(baseName(file.path))) paths.add(file.path);
  const text = files.filter((file) => paths.has(file.path)).map((file) => file.raw).join("\n").slice(0, 20_000);
  return { text, releaseNotesFound: paths.size > 0 };
}

function diffManifest(path: string, before: string | null, after: string | null): ManifestChange {
  const left = before === null ? emptyFacts() : parseManifest(path, before);
  const right = after === null ? emptyFacts() : parseManifest(path, after);
  const malformed = (before !== null && left.malformed) || (after !== null && right.malformed);
  const dependenciesAdded = malformed ? [] : addedDeps(left.dependencies, right.dependencies);
  const dependenciesRemoved = malformed ? [] : addedDeps(right.dependencies, left.dependencies);
  return {
    path: path.replaceAll("\\", "/"),
    malformed,
    version: left.version === right.version ? null : { from: left.version, to: right.version },
    dependenciesAdded,
    dependenciesRemoved,
    permissionsAdded: malformed ? [] : missing(right.permissions, left.permissions),
    permissionsRemoved: malformed ? [] : missing(left.permissions, right.permissions),
    entryPointsChanged: malformed ? [] : changedEntries(left.entryPoints, right.entryPoints),
  };
}

function addedDeps(before: { name: string; range: string }[], after: { name: string; range: string }[]): { name: string; range: string }[] {
  const prior = new Map(before.map((item) => [item.name, item.range]));
  return after.filter((item) => prior.get(item.name) !== item.range);
}

function missing(have: string[], against: string[]): string[] {
  const known = new Set(against);
  return have.filter((item) => !known.has(item));
}

function changedEntries(before: string[], after: string[]): string[] {
  const left = new Map(before.map(splitEntry));
  const right = new Map(after.map(splitEntry));
  const keys = new Set([...left.keys(), ...right.keys()]);
  const changed: string[] = [];
  for (const key of keys) {
    const from = left.get(key);
    const to = right.get(key);
    if (from === to) continue;
    changed.push(`${key}: ${from ?? "(absent)"} -> ${to ?? "(absent)"}`);
  }
  return changed;
}

function splitEntry(value: string): [string, string] {
  const index = value.indexOf(": ");
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index + 2)];
}

function emptyFacts(): ManifestFacts {
  return { version: null, dependencies: [], permissions: [], entryPoints: [], malformed: false };
}

function parseManifest(path: string, text: string): ManifestFacts {
  try {
    const name = baseName(path).toLowerCase();
    if (name === "pyproject.toml") return parsePyproject(text);
    if (name === "cargo.toml") return parseCargo(text);
    if (name === "go.mod") return parseGoMod(text);
    return parseJsonManifest(name, text);
  } catch {
    return { ...emptyFacts(), malformed: true };
  }
}

function parseJsonManifest(name: string, text: string): ManifestFacts {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ...emptyFacts(), malformed: true }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...emptyFacts(), malformed: true };
  const row = value as Record<string, unknown>;
  if (name === "package.json") return packageFacts(row);
  if (name === "module.json") return foundryFacts(row);
  return extensionFacts(row);
}

function packageFacts(row: Record<string, unknown>): ManifestFacts {
  const dependencies: { name: string; range: string }[] = [];
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const table = row[key];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    for (const [name, range] of Object.entries(table as Record<string, unknown>)) {
      dependencies.push({ name, range: typeof range === "string" ? range : JSON.stringify(range) });
    }
  }
  const entryPoints: string[] = [];
  for (const key of ["main", "module", "browser", "types", "typings"]) pushScalar(entryPoints, key, row[key]);
  pushBin(entryPoints, row["bin"]);
  pushExports(entryPoints, row["exports"]);
  return { version: typeof row["version"] === "string" ? row["version"] : null, dependencies, permissions: [], entryPoints, malformed: false };
}

function foundryFacts(row: Record<string, unknown>): ManifestFacts {
  const permissions: string[] = [];
  const relationships = row["relationships"];
  if (relationships && typeof relationships === "object" && !Array.isArray(relationships)) {
    for (const [name, value] of Object.entries(relationships as Record<string, unknown>)) {
      for (const entry of relationEntries(value)) permissions.push(`${name}:${entry}`);
    }
  }
  const flags = row["flags"];
  if (Array.isArray(flags)) {
    for (const flag of flags) if (typeof flag === "string") permissions.push(`flag:${flag}`);
  } else if (flags && typeof flags === "object") {
    for (const [key, value] of Object.entries(flags as Record<string, unknown>)) if (value) permissions.push(`flag:${key}`);
  }
  const entryPoints: string[] = [];
  for (const key of ["esmodules", "scripts", "styles"]) {
    const value = row[key];
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string") entryPoints.push(`${key}: ${item}`);
  }
  return { version: typeof row["version"] === "string" ? row["version"] : null, dependencies: depList(row["dependencies"]), permissions, entryPoints, malformed: false };
}

function extensionFacts(row: Record<string, unknown>): ManifestFacts {
  const permissions: string[] = [];
  for (const key of ["permissions", "optional_permissions", "host_permissions"]) {
    const value = row[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) if (typeof item === "string") permissions.push(item);
  }
  const capabilities = row["capabilities"];
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    for (const key of Object.keys(capabilities as Record<string, unknown>)) permissions.push(`capability:${key}`);
  }
  const entryPoints: string[] = [];
  const background = row["background"];
  if (background && typeof background === "object" && !Array.isArray(background)) {
    const record = background as Record<string, unknown>;
    pushScalar(entryPoints, "background.service_worker", record["service_worker"]);
    pushScalar(entryPoints, "background.page", record["page"]);
  }
  const action = row["action"] ?? row["browser_action"];
  if (action && typeof action === "object" && !Array.isArray(action)) pushScalar(entryPoints, "action", (action as Record<string, unknown>)["default_popup"]);
  const scripts = row["content_scripts"];
  if (Array.isArray(scripts)) {
    for (const script of scripts) {
      if (!script || typeof script !== "object") continue;
      const js = (script as Record<string, unknown>)["js"];
      if (Array.isArray(js)) for (const item of js) if (typeof item === "string") entryPoints.push(`content_scripts: ${item}`);
    }
  }
  return { version: typeof row["version"] === "string" ? row["version"] : null, dependencies: [], permissions, entryPoints, malformed: false };
}

function depList(value: unknown): { name: string; range: string }[] {
  if (!Array.isArray(value)) return [];
  const deps: { name: string; range: string }[] = [];
  for (const item of value) {
    if (typeof item === "string") deps.push({ name: item, range: item });
    else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") deps.push({ name: (item as { id: string }).id, range: JSON.stringify(item) });
  }
  return deps;
}

function relationEntries(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string") ids.push(item);
    else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") ids.push((item as { id: string }).id);
  }
  return ids;
}

function pushScalar(out: string[], key: string, value: unknown): void {
  if (typeof value === "string" && value) out.push(`${key}: ${value}`);
}

function pushBin(out: string[], value: unknown): void {
  if (typeof value === "string") out.push(`bin: ${value}`);
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, path] of Object.entries(value as Record<string, unknown>)) if (typeof path === "string") out.push(`bin.${key}: ${path}`);
  }
}

function pushExports(out: string[], value: unknown): void {
  if (typeof value === "string") out.push(`exports: ${value}`);
  else if (value && typeof value === "object") out.push(`exports: ${JSON.stringify(value)}`);
}

function parsePyproject(text: string): ManifestFacts {
  let section = "";
  let collecting = false;
  const dependencies: { name: string; range: string }[] = [];
  const entryPoints: string[] = [];
  let version: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0] ?? "";
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header?.[1]) { section = header[1].trim(); collecting = false; continue; }
    if (section === "project" || section === "tool.poetry") {
      const ver = /^\s*version\s*=\s*["']([^"']+)["']/.exec(line);
      if (ver?.[1] && version === null) version = ver[1];
    }
    if (section === "project" && /^\s*dependencies\s*=\s*\[/.test(line)) collecting = true;
    if (collecting) {
      for (const spec of line.matchAll(/["']([^"']+)["']/g)) {
        const value = spec[1];
        if (!value) continue;
        const name = /^([A-Za-z0-9_.-]+)/.exec(value)?.[1] ?? value;
        dependencies.push({ name, range: value });
      }
      if (line.includes("]")) collecting = false;
    }
    if (section === "tool.poetry.dependencies" || section === "project.optional-dependencies") {
      const pair = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (pair?.[1] && pair[2] && pair[1] !== "python") dependencies.push({ name: pair[1], range: pair[2] });
    }
    if (section === "project.scripts" || section === "project.gui-scripts") {
      const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (pair?.[1] && pair[2]) entryPoints.push(`${pair[1]}: ${pair[2]}`);
    }
  }
  return { version, dependencies, permissions: [], entryPoints, malformed: false };
}

function parseCargo(text: string): ManifestFacts {
  let section = "";
  const dependencies: { name: string; range: string }[] = [];
  const entryPoints: string[] = [];
  let version: string | null = null;
  let binName: string | null = null;
  let binPath: string | null = null;
  const flushBin = (): void => {
    if (section !== "bin") return;
    if (binPath) entryPoints.push(binName ? `bin.${binName}: ${binPath}` : `bin: ${binPath}`);
    else if (binName) entryPoints.push(`bin: ${binName}`);
    binName = null;
    binPath = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0] ?? "";
    const header = /^\s*\[+([^\]]+)\]+/.exec(line);
    if (header?.[1]) {
      flushBin();
      section = header[1].trim();
      continue;
    }
    if (section === "package") {
      const ver = /^\s*version\s*=\s*["']([^"']+)["']/.exec(line);
      if (ver?.[1]) version = ver[1];
    }
    if (section === "dependencies" || section === "dev-dependencies" || section === "build-dependencies") {
      const simple = /^\s*([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (simple?.[1] && simple[2]) dependencies.push({ name: simple[1], range: simple[2] });
      const table = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*["']([^"']+)["']/.exec(line);
      if (table?.[1] && table[2]) dependencies.push({ name: table[1], range: table[2] });
    }
    if (section === "lib") {
      const path = /^\s*path\s*=\s*["']([^"']+)["']/.exec(line);
      if (path?.[1]) entryPoints.push(`lib: ${path[1]}`);
    }
    if (section === "bin") {
      const name = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line);
      if (name?.[1]) binName = name[1];
      const path = /^\s*path\s*=\s*["']([^"']+)["']/.exec(line);
      if (path?.[1]) binPath = path[1];
    }
  }
  flushBin();
  return { version, dependencies, permissions: [], entryPoints, malformed: false };
}

function parseGoMod(text: string): ManifestFacts {
  const dependencies: { name: string; range: string }[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = (raw.split("//")[0] ?? "").trim();
    if (line === "require (") { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
    if (single?.[1] && single[2]) { dependencies.push({ name: single[1], range: single[2] }); continue; }
    if (inBlock) {
      const pair = /^(\S+)\s+(\S+)$/.exec(line);
      if (pair?.[1] && pair[2]) dependencies.push({ name: pair[1], range: pair[2] });
    }
  }
  return { version: null, dependencies, permissions: [], entryPoints: [], malformed: false };
}

function capAnalysis(analysis: ChangeAnalysis): ChangeAnalysis {
  const size = (): number => Buffer.byteLength(JSON.stringify(analysis), "utf8");
  if (size() <= ANALYSIS_BYTE_CAP) return analysis;
  analysis.truncated = true;
  for (let guard = 0; guard < 20_000 && size() > ANALYSIS_BYTE_CAP; guard += 1) {
    const cuts: { bytes: number; cut: () => boolean }[] = [];
    if (analysis.changelog.text) {
      cuts.push({ bytes: Buffer.byteLength(analysis.changelog.text, "utf8"), cut: () => {
        const next = Math.floor(analysis.changelog.text.length * 0.7);
        analysis.changelog.text = next < 1 ? "" : analysis.changelog.text.slice(0, next);
        return true;
      } });
    }
    for (const list of [analysis.pricingTermsAdded, analysis.newSettingsKeys, analysis.addedFiles, analysis.removedFiles] as string[][]) {
      if (!list.length) continue;
      cuts.push({ bytes: Buffer.byteLength(JSON.stringify(list), "utf8"), cut: () => { list.pop(); return true; } });
    }
    if (analysis.newOutboundHosts.length) {
      cuts.push({ bytes: Buffer.byteLength(JSON.stringify(analysis.newOutboundHosts), "utf8"), cut: () => { analysis.newOutboundHosts.pop(); return true; } });
    }
    if (!cuts.length) break;
    cuts.sort((a, b) => b.bytes - a.bytes);
    if (!cuts[0]?.cut()) break;
  }
  return analysis;
}

function baseName(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

function isGenerated(path: string, name: string): boolean {
  if (/(?:^|\/)(?:dist|build|generated|vendor|coverage)(?:\/|$)/.test(path.toLowerCase())) return true;
  return /\.(?:min\.(?:js|mjs|css)|bundle\.js|js\.map|css\.map)$/.test(name) || name.includes(".generated.");
}

function isTest(path: string, name: string): boolean {
  if (/(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/.test(path.toLowerCase())) return true;
  return /\.(?:test|spec)\./.test(name) || /_test\.(?:go|py|rs)$/.test(name);
}

function isDoc(path: string, name: string): boolean {
  if (/(?:^|\/)docs?(?:\/|$)/.test(path.toLowerCase())) return true;
  if (NOTES_FILE.test(name) || /^(license|licence|copying|authors)(?:\.|$)/.test(name)) return true;
  const ext = extension(name);
  return ext === "md" || ext === "markdown" || ext === "rst" || ext === "adoc" || ext === "txt";
}

function isConfig(path: string, name: string): boolean {
  if (/(?:^|\/)\.github(?:\/|$)/.test(path.toLowerCase())) return true;
  if (/^(dockerfile|makefile|jenkinsfile)$/.test(name) || name.startsWith("tsconfig") || name.startsWith("jsconfig")) return true;
  if (/(?:^|\.)(?:eslintrc|prettierrc|babelrc|editorconfig|npmrc|nvmrc|gitignore)$/.test(name)) return true;
  const ext = extension(name);
  return ext === "yml" || ext === "yaml" || ext === "toml" || ext === "ini" || ext === "cfg" || ext === "conf" || ext === "json";
}

function pricingName(filePath: string): boolean {
  return baseName(filePath).toLowerCase().split(/[^a-z0-9]+/).some((word) => PRICE_WORDS.has(word));
}
