import { compareVersions, downloadHttps, resolveCaskDownload, resolveGithubDownload, resolveSparkleDownload, resolveWingetDownload, runArgv, updatesView, type ConfirmedDownload, type Db, type DownloadFile, type DownloadTarget } from "@scout/core";
import type { ResolvedDownload, RunnerDeps } from "@scout/ops";
import { github } from "@scout/research";

export interface DownloadsOptions { fetch?: typeof fetch; githubToken?: string; now?: () => number }
interface Install { packageId: number; machineId: string; os: string; ecosystem: string; key: string; homepage: string | null; details: string }

function appcastFile(xml: string, version: string, target: DownloadTarget): DownloadFile | null {
  const decode = (value: string): string => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const candidates: DownloadFile[] = [];
  for (const item of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const text = item[1] ?? "";
    const enclosure = /<enclosure\s+([^>]*?)\/?\s*>/.exec(text);
    if (!enclosure) continue;
    const attrs: Record<string, string> = {};
    for (const attr of (enclosure[1] ?? "").matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[attr[1] ?? ""] = decode(attr[2] ?? attr[3] ?? "");
    const field = (name: string): string => attrs[`sparkle:${name}`] ?? decode(new RegExp(`<sparkle:${name}[^>]*>([^<]*)</sparkle:${name}>`).exec(text)?.[1] ?? "").trim();
    if (field("channel") || compareVersions(field("shortVersionString") || field("version"), version) !== 0 || /sparkle:deltaFrom\s*=/.test(text)) continue;
    const resolved = resolveSparkleDownload(attrs, target);
    if (resolved) candidates.push(resolved);
  }
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

/** The product page an appcast names in its channel link, or else the site the feed is served from. */
function appcastHome(xml: string, feed: string): string | null {
  const channel = /<channel(?:\s[^>]*)?>([\s\S]*?)(?:<item[\s>]|<\/channel>)/.exec(xml)?.[1] ?? "";
  const link = /<link(?:\s[^>]*)?>\s*(?:<!\[CDATA\[)?\s*([^<\s]+?)\s*(?:\]\]>)?\s*<\/link>/.exec(channel)?.[1];
  const named = downloadHttps(link?.replace(/&amp;/g, "&").replace(/^http:/, "https:"));
  if (named) return named;
  try { return downloadHttps(`https://${new URL(feed).host}/`); } catch { return null; }
}

export function createDownloadResolver(db: Db, deps: RunnerDeps, options: DownloadsOptions = {}): NonNullable<RunnerDeps["resolveDownload"]> {
  const fetchPublic = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { until: number; file: DownloadFile | null; home: string | null }>();
  const read = async (url: string, signal?: AbortSignal): Promise<string | null> => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "Scout" };
    if (new URL(url).hostname === "api.github.com") {
      headers["x-github-api-version"] = "2022-11-28";
      const token = options.githubToken ?? process.env.SCOUT_GITHUB_TOKEN;
      if (token) headers.authorization = `Bearer ${token}`;
    }
    try {
      const timeout = AbortSignal.timeout(30_000);
      const response = await fetchPublic(url, { headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) return null;
      const text = await response.text();
      return text.length <= 8_388_608 ? text : null;
    } catch { return null; }
  };
  const readJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
    try { return JSON.parse(await read(url, signal) ?? "null") as unknown; } catch { return null; }
  };
  return async (installId, fresh = false, signal) => {
    const row = updatesView(db).find((entry) => entry.installId === installId);
    const install = db.prepare("SELECT i.package_id AS packageId, i.machine_id AS machineId, m.os, p.ecosystem, p.key, p.homepage, i.details_json AS details FROM installs i JOIN packages p ON p.id = i.package_id JOIN machines m ON m.id = i.machine_id WHERE i.id = ? AND i.removed_at IS NULL").get(installId) as Install | undefined;
    if (!row || !install) return null;
    const machine = deps.machines.find((entry) => entry.id === row.machineId);
    const details = JSON.parse(install.details) as Record<string, unknown>;
    const archValue = machine?.arch;
    const arch = archValue === "x64" || archValue === "arm64" ? archValue : null;
    const platform = install.os === "macos" || install.os === "windows" ? install.os : null;
    const version = row.upstream ?? (row.updatable ? row.available : null);
    const freezes = db.prepare("SELECT spec FROM constraints WHERE hard = 1 AND type = 'freeze' AND (install_id = ? OR (install_id IS NULL AND package_id = ?))").all(installId, row.packageId) as { spec: string }[];
    let refusal = row.blockedBy ?? (freezes.length ? "This install is frozen." : null);
    if (!machine) refusal ??= "This machine is not set up in Scout.";
    if (!platform) refusal ??= "Scout cannot download files to this kind of machine.";
    const page = downloadHttps(row.downloadUrl);
    const preview: ResolvedDownload["preview"] = { installId, machineId: row.machineId, name: row.name, kind: page ? "page" : "none", url: page, fileName: null, size: null, sha256: null, source: null, folder: platform === "macos" ? "~/Downloads" : "User Downloads", warnings: [], allowed: false, refusal };
    if (!version || !platform || !arch || !machine || refusal) {
      preview.refusal ??= !arch ? "Scout does not know this machine's processor type." : "No exact file is available for the newer version.";
      return { preview, download: null, transport: machine?.transport ?? null };
    }
    const target: DownloadTarget = { platform, arch };
    const key = JSON.stringify([install.packageId, version, platform, arch, install.ecosystem === "winget" ? machine.id : null]);
    const cached = !fresh ? cache.get(key) : undefined;
    let resolved: DownloadFile | null = null;
    // The cask record also names the product's home page, the last resort when there is no file and no download page.
    let home: string | null = null;
    if (cached && cached.until > now()) { resolved = cached.file; home = cached.home; }
    else {
      let cask = install.ecosystem === "cask" && (details.tap === undefined || details.tap === null || details.tap === "homebrew/cask") ? install.key : null;
      if (install.ecosystem === "bundle") {
        const linked = db.prepare("SELECT DISTINCT p.key FROM item_links a JOIN item_links b ON b.item_id = a.item_id JOIN packages p ON p.id = b.package_id JOIN installs i ON i.package_id = p.id WHERE a.package_id = ? AND a.basis = 'deterministic' AND b.basis = 'deterministic' AND p.ecosystem = 'cask' AND b.evidence_json LIKE '%cask declares this app bundle%' AND i.machine_id = ? AND i.removed_at IS NULL AND (json_extract(i.details_json, '$.tap') IS NULL OR json_extract(i.details_json, '$.tap') = 'homebrew/cask')").all(install.packageId, install.machineId) as { key: string }[];
        if (linked.length === 1) cask = linked[0]?.key ?? null;
      }
      if (platform === "macos" && cask && /^[a-z0-9][a-z0-9@._+-]*$/i.test(cask)) {
        const doc = await readJson(`https://formulae.brew.sh/api/cask/${encodeURIComponent(cask)}.json`, signal) as { version?: unknown } | null;
        home = downloadHttps((doc as { homepage?: unknown } | null)?.homepage);
        if (typeof doc?.version === "string" && compareVersions(doc.version.split(",")[0] ?? "", version) === 0) resolved = resolveCaskDownload(doc, target);
      }
      if (!resolved && platform === "windows" && install.ecosystem === "winget" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(install.key) && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
        const shown = await (deps.exec ?? runArgv)(machine.transport, ["winget", "show", "--id", install.key, "--exact", "--version", version], deps.checkTimeoutMs ?? 120_000, signal);
        if (shown.exitCode === 0) resolved = resolveWingetDownload(shown.stdout, target);
      }
      if (!resolved) {
        const endpoint = github.url({ id: install.packageId, ecosystem: install.ecosystem, key: install.key, name: row.name, homepage: install.homepage, tap: null, details });
        if (endpoint) {
          const doc = await readJson(endpoint.replace(/releases\?per_page=30$/, "releases/latest"), signal) as { tag_name?: unknown } | null;
          if (typeof doc?.tag_name === "string" && compareVersions(doc.tag_name.replace(/^v/, ""), version) === 0) resolved = resolveGithubDownload(doc, target);
        }
      }
      const feed = downloadHttps(details.sparkleFeed);
      if (!resolved && platform === "macos" && feed) resolved = appcastFile(await read(feed, signal) ?? "", version, target);
      // An app that names no home page still tells where its updates come from, which is the last page worth opening.
      if (!resolved && !home && !preview.url && typeof details.sparkleFeed === "string") home = appcastHome(feed ? await read(feed, signal) ?? "" : "", details.sparkleFeed);
      cache.set(key, { until: now() + 3_600_000, file: resolved, home });
    }
    if (!resolved) return { preview: { ...preview, kind: preview.url ?? home ? "page" : "none", url: preview.url ?? home, refusal: "No exact file is available." }, download: null, transport: machine.transport };
    const current = db.prepare("SELECT i.version, i.machine_id AS machineId, i.package_id AS packageId, m.os FROM installs i JOIN machines m ON m.id = i.machine_id WHERE i.id = ? AND i.removed_at IS NULL").get(installId) as { version: string | null; machineId: string; packageId: number; os: string } | undefined;
    const frozen = db.prepare("SELECT 1 FROM constraints WHERE hard = 1 AND type = 'freeze' AND (install_id = ? OR (install_id IS NULL AND package_id = ?))").get(installId, install.packageId);
    if (!current || current.version !== row.installed || current.machineId !== row.machineId || current.packageId !== install.packageId || current.os !== platform || machine.arch !== arch || frozen) refusal = "The install changed while Scout was looking up the file. Try again.";
    if (resolved.size !== null && resolved.size > 2147483648) refusal = "The file is larger than 2 GB.";
    const download: ConfirmedDownload = { ...resolved, ...target, version, installed: row.installed };
    return { preview: { ...preview, ...resolved, kind: "file", allowed: refusal === null, refusal, warnings: resolved.sha256 === null ? [resolved.source === "sparkle" ? "No checksum is available. Scout does not verify Sparkle EdDSA signatures." : "No checksum is available."] : [] }, download, transport: machine.transport };
  };
}

/**
 * Which Download rows have an exact file, only a page, or nothing, so the page can color its buttons. The first request
 * starts a background pass over the rows and later requests read what it has found; the pass repeats hourly.
 */
export function createDownloadKinds(db: Db, resolve: NonNullable<RunnerDeps["resolveDownload"]>, now: () => number = Date.now): { snapshot(): { kinds: Record<string, "file" | "page" | "none">; pending: boolean } } {
  const kinds = new Map<number, "file" | "page" | "none">();
  let running = false;
  let finishedAt = 0;
  const run = async (): Promise<void> => {
    running = true;
    try {
      for (const row of updatesView(db)) {
        if (row.updatable || row.blockedBy || !row.statuses.some((status) => status === "upstream" || status === "advisory")) continue;
        try { kinds.set(row.installId, (await resolve(row.installId))?.preview.kind ?? "none"); } catch { kinds.set(row.installId, "none"); }
      }
    } finally {
      running = false;
      finishedAt = now();
    }
  };
  return {
    snapshot() {
      if (!running && now() - finishedAt > 3_600_000) void run();
      return { kinds: Object.fromEntries([...kinds].map(([id, kind]) => [String(id), kind])), pending: running };
    },
  };
}
