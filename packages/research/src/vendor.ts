import { github } from "./github.ts";
import { WEEKLY, type Researcher } from "./types.ts";

const SHAPE = /^v?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

export function vendorVersion(value: unknown): string | null {
  return typeof value === "string" ? SHAPE.exec(value.trim())?.[1] ?? null : null;
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (!key.startsWith("#")) return named[key.toLowerCase()] ?? entity;
    const value = /^#x/i.test(key) ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

function attributes(tag: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const match of tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) fields[(match[1] as string).toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  return fields;
}

export function vendorEvidence(body: string): { versions: string[]; text: string } {
  const versions = new Set<string>();
  const add = (value: unknown): void => { const version = vendorVersion(value); if (version) versions.add(version); };
  const html = body.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attributes(match[1] ?? "")["type"]?.toLowerCase() !== "application/ld+json") continue;
    try {
      const nodes: unknown[] = [JSON.parse(match[2] ?? "")];
      while (nodes.length) {
        const node = nodes.pop();
        if (Array.isArray(node)) nodes.push(...node);
        else if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) {
            if (key === "softwareVersion") add(value);
            else if (value && typeof value === "object") nodes.push(value);
          }
        }
      }
    } catch {
      // A malformed metadata block must not hide readable download text.
    }
  }
  const visible = html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  for (const match of visible.matchAll(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    const fields = attributes(match[0]);
    const name = fields["name"]?.toLowerCase();
    const property = fields["property"]?.toLowerCase();
    if (name === "version" || name === "application-version" || (property?.startsWith("og:") && property.endsWith("version"))) add(fields["content"]);
  }
  const text = decode(visible.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  const words = [...text.matchAll(/\b(?:download|latest|release|current)\b/gi)];
  for (const match of text.matchAll(/\b(?:Version\s+|v)(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)(?![\w.+-])/gi)) {
    if (words.some((word) => Math.max(0, Math.max(word.index, match.index) - Math.min(word.index + word[0].length, match.index + match[0].length)) <= 200)) add(match[1]);
  }
  return { versions: [...versions], text: text.slice(0, 6000) };
}

export const vendor: Researcher = {
  source: "vendor",
  ecosystems: github.ecosystems,
  ttlMs: WEEKLY,
  url(target) {
    if (!target.homepage || !URL.canParse(target.homepage)) return null;
    const url = new URL(target.homepage);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  },
  parse(status, body) {
    if (status === 404) return { status: "notfound", answers: [], message: "the source does not list this package" };
    if (status !== 200) return { status: "failed", answers: [], message: `HTTP ${status}` };
    const { versions } = vendorEvidence(body);
    return { status: "ok", answers: versions.length === 1 ? [{ channel: "stable", version: versions[0] as string, advisory: true, installable: false }] : [] };
  },
};
