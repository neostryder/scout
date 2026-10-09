import { isIP } from "node:net";

export interface DownloadTarget { platform: "windows" | "macos"; arch: "x64" | "arm64" }
export interface DownloadFile { url: string; fileName: string; size: number | null; sha256: string | null; source: "github" | "cask" | "sparkle" | "winget" }
export interface DownloadPlan {
  installId: number; machineId: string; name: string; kind: "file" | "page" | "none";
  url: string | null; fileName: string | null; size: number | null; sha256: string | null; source: string | null;
  folder: string; warnings: string[]; allowed: boolean; refusal: string | null;
}
export interface ConfirmedDownload extends DownloadFile, DownloadTarget { version: string; installed: string | null }

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const checksum = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
const sizeOf = (value: unknown): number | null => (typeof value === "number" || typeof value === "string" && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function downloadHttps(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !isIP(host) && host !== "localhost" && !host.endsWith(".localhost") && host.includes(".") ? url.href : null;
  } catch { return null; }
}

export function downloadFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[^A-Za-z0-9. _-]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "").replace(/[. ]+$/, "");
  const extension = /\.[A-Za-z0-9]+$/.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - extension.length || name.length).trim();
  if (!/[A-Za-z0-9]/.test(stem) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || extension.length >= 120) return null;
  return name.length <= 120 ? name : stem.slice(0, 120 - extension.length).trimEnd() + extension;
}

function file(urlValue: unknown, name: unknown, size: unknown, hash: unknown, source: DownloadFile["source"]): DownloadFile | null {
  const url = downloadHttps(urlValue);
  let fromUrl: string | null = null;
  try { if (url) fromUrl = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? ""); } catch { return null; }
  const fileName = downloadFileName(name ?? fromUrl);
  // A redirect script such as rotation.php names no installer, so only installer and archive extensions are exact files.
  return url && fileName && INSTALLER_FILE.test(fileName) ? { url, fileName, size: sizeOf(size), sha256: checksum(hash), source } : null;
}

const INSTALLER_FILE = /\.(dmg|pkg|zip|exe|msi|msix|msixbundle|appx|appxbundle|7z|tar\.gz|tgz|tar\.xz|tar\.bz2|iso|cab)$/i;

export function resolveGithubDownload(data: unknown, target: DownloadTarget): DownloadFile | null {
  const release = object(data);
  if (!Array.isArray(release.assets) || release.draft === true || release.prerelease === true) return null;
  const candidates: { file: DownloadFile; score: number }[] = [];
  for (const value of release.assets) {
    const asset = object(value);
    if (typeof asset.name !== "string" || typeof asset.content_type !== "string") continue;
    const name = asset.name.toLowerCase();
    if (/(?:source|symbols|debug)(?:[._ -]|$)/.test(name)) continue;
    const arm = /(?:^|[._ -])(?:arm64|aarch64)(?:[._ -]|$)/.test(name);
    const intel = /(?:^|[._ -])(?:x64|amd64|x86_64|intel)(?:[._ -]|$)/.test(name);
    const universal = /(?:^|[._ -])universal(?:[._ -]|$)/.test(name);
    if (target.arch === "x64" && arm && !universal || target.arch === "arm64" && intel && !universal) continue;
    let score = 0;
    if (target.platform === "windows") {
      if (target.arch !== "x64" || !/\.(?:exe|msi|msix)$/.test(name) || arm || /(?:macos|darwin|linux|win32|ia32)/.test(name) || /(?:^|[._ -])x86(?:[._ -]|$)/.test(name) && !name.includes("x86_64") || !intel && !/(?:windows|win64)/.test(name)) continue;
      if (!/^(?:application\/(?:octet-stream|x-msdownload|x-msi|msix|vnd\.ms-appx(?:\.bundle)?|vnd\.microsoft\..*)|binary\/octet-stream)$/i.test(asset.content_type)) continue;
      score = intel ? 2 : 1;
    } else {
      if (!/\.(?:dmg|pkg|zip)$/.test(name) || /(?:windows|linux)/.test(name) || !(universal || (target.arch === "arm64" ? arm : intel))) continue;
      if (/\.zip$/.test(name) && !/\.app(?:[._ -]|$)/.test(name)) continue;
      if (!/^(?:application\/(?:octet-stream|x-apple-diskimage|x-xar|zip|x-zip-compressed)|binary\/octet-stream)$/i.test(asset.content_type)) continue;
      score = (/\.zip$/.test(name) ? 0 : 4) + (universal ? 1 : 2);
    }
    const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : null;
    const resolved = file(asset.browser_download_url, asset.name, asset.size, digest, "github");
    if (resolved) candidates.push({ file: resolved, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] && candidates[0].score !== candidates[1]?.score ? candidates[0].file : null;
}

export function resolveCaskDownload(data: unknown, target: DownloadTarget): DownloadFile | null {
  if (target.platform !== "macos") return null;
  let doc = object(data);
  if (typeof doc.arch === "string" && doc.arch !== "universal" && ![target.arch, target.arch === "arm64" ? "aarch64" : "x86_64", target.arch === "arm64" ? "arm" : "intel"].includes(doc.arch)) return null;
  const required = object(doc.depends_on).arch;
  if (Array.isArray(required) && !required.some((value) => {
    const entry = object(value);
    return entry.type === (target.arch === "arm64" ? "arm" : "intel") && entry.bits === 64;
  })) return null;
  const variant = object(doc[target.arch === "arm64" ? "on_arm" : "on_intel"]);
  const variations = Object.entries(object(doc.variations)).filter(([key]) => !key.includes("linux") && (target.arch === "arm64" ? key.startsWith("arm64") : !key.startsWith("arm64")));
  // OS-specific variants cannot be selected without an OS version unless their files agree.
  const files = variations.map(([, value]) => ({ ...doc, ...object(value) }));
  if (files.length && files.some((entry) => entry.url !== files[0]?.url || entry.sha256 !== files[0]?.sha256 || entry.version !== files[0]?.version)) return null;
  if (files.some((entry) => entry.version !== doc.version) || variant.version !== undefined && variant.version !== doc.version) return null;
  if (files[0]) doc = files[0];
  doc = { ...doc, ...variant };
  const arch = object(doc.arch);
  const pick = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const map = object(value);
    return target.arch === "arm64" ? map.arm ?? map.arm64 : map.intel ?? map.x86_64 ?? map.x64;
  };
  let url = pick(doc.url);
  const archValue = pick(arch);
  if (typeof url === "string" && typeof archValue === "string") url = url.replaceAll("#{arch}", archValue);
  if (typeof url !== "string" || url.includes("#{")) return null;
  const arm = /(?:arm64|aarch64)/i.test(url);
  const intel = /(?:x64|x86_64|amd64)/i.test(url);
  if (target.arch === "arm64" && intel || target.arch === "x64" && arm) return null;
  const hash = pick(doc.sha256);
  if (hash !== "no_check" && hash !== undefined && hash !== null && !checksum(hash)) return null;
  return file(url, null, null, hash, "cask");
}

export function resolveSparkleDownload(enclosure: unknown, target: DownloadTarget): DownloadFile | null {
  if (target.platform !== "macos") return null;
  const doc = object(enclosure);
  const arch = doc["sparkle:os"] ?? doc.os;
  if (typeof arch === "string" && arch !== "macos") return null;
  const cpu = doc["sparkle:arch"] ?? doc.arch;
  if (cpu !== undefined && cpu !== target.arch && cpu !== "universal" && !(cpu === "x86_64" && target.arch === "x64")) return null;
  if (typeof doc.url === "string" && (target.arch === "x64" && /(?:arm64|aarch64)/i.test(doc.url) || target.arch === "arm64" && /(?:x86_64|amd64|x64)/i.test(doc.url))) return null;
  // Sparkle's EdDSA signature is not a SHA-256 checksum.
  return file(doc.url, null, doc.length, null, "sparkle");
}

export function resolveWingetDownload(stdout: unknown, target: DownloadTarget): DownloadFile | null {
  if (target.platform !== "windows" || target.arch !== "x64" || typeof stdout !== "string") return null;
  const blocks: Record<string, string>[] = [];
  let block: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(Installer Type|Installer Url|Installer SHA256|Architecture):\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const label = (match[1] ?? "").toLowerCase();
    if (block[label] !== undefined) { blocks.push(block); block = {}; }
    block[label] = match[2] ?? "";
  }
  blocks.push(block);
  const candidates = blocks.flatMap((entry) => {
    if (entry.architecture?.toLowerCase() !== "x64" || !/^(?:exe|msi|msix|msixbundle|burn|inno|nullsoft|wix)$/i.test(entry["installer type"] ?? "")) return [];
    const hash = entry["installer sha256"];
    if (hash !== undefined && !checksum(hash)) return [];
    const resolved = file(entry["installer url"], null, null, hash, "winget");
    return resolved ? [resolved] : [];
  });
  return candidates.length === 1 ? candidates[0] ?? null : null;
}
