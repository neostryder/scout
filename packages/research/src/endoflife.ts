import { compareVersions, supportEnded, type SupportWindow } from "@scout/core";
import { github } from "./github.ts";
import { DAILY, type Researcher, type ResearchTarget } from "./types.ts";

const PRODUCTS: Record<string, string> = {
  node: "nodejs", nodejs: "nodejs", "node.js": "nodejs", "nodejs.lts": "nodejs",
  python: "python", go: "go", golang: "go", ruby: "ruby", php: "php",
  postgresql: "postgresql", postgres: "postgresql", mysql: "mysql", mariadb: "mariadb",
  redis: "redis", nginx: "nginx", openssl: "openssl", git: "git", dotnet: "dotnet", ".net": "dotnet",
  java: "oracle-jdk", openjdk: "openjdk-builds-from-oracle", rust: "rust",
  "docker-engine": "docker-engine", kubernetes: "kubernetes",
};

export function supportProduct(target: ResearchTarget): { slug: string; cycle: string | null } | null {
  for (const value of [target.key, target.name]) {
    let name = value.trim().toLowerCase().replace(/\.exe$/, "");
    const cycle = /(?:@|\.)(\d+(?:\.\d+)*)$/.exec(name);
    if (cycle) name = name.slice(0, cycle.index);
    for (;;) {
      const slug = Object.hasOwn(PRODUCTS, name) ? PRODUCTS[name] : undefined;
      if (slug) return { slug, cycle: cycle?.[1] ?? null };
      const prefix = /^[a-z][a-z0-9-]*\.(?=[a-z])/.exec(name);
      if (!prefix) break;
      name = name.slice(prefix[0].length);
    }
  }
  return null;
}

const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function cycles(body: string): SupportWindow[] | null {
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(doc)) return null;
  const windows = new Map<string, SupportWindow>();
  for (const row of doc) {
    if (!row || typeof row !== "object" || (typeof row.cycle !== "string" && typeof row.cycle !== "number")) continue;
    const cycle = String(row.cycle).trim();
    if (!cycle) continue;
    windows.set(cycle, {
      cycle,
      eol: date(row.eol) || typeof row.eol === "boolean" ? row.eol : null,
      latest: typeof row.latest === "string" && /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/.test(row.latest) ? row.latest : null,
      lts: row.lts === true || date(row.lts),
    });
  }
  return [...windows.values()];
}

export const endoflife: Researcher = {
  source: "endoflife",
  ecosystems: github.ecosystems,
  ttlMs: DAILY,
  url(target) {
    const product = supportProduct(target);
    return product ? `https://endoflife.date/api/${product.slug}.json` : null;
  },
  parse(status, body, target) {
    if (status === 404) return { status: "notfound", answers: [], message: "the source does not list this package" };
    if (status !== 200) return { status: "failed", answers: [], message: `HTTP ${status}` };
    const windows = cycles(body);
    if (!windows) return { status: "failed", answers: [], message: "response is not a cycles array" };
    const product = supportProduct(target);
    if (!product?.cycle && windows.some((window) => typeof window.eol === "string") && (!target.observedAt || !Number.isFinite(Date.parse(target.observedAt)))) return { status: "failed", answers: [], message: "observation time is required" };
    let latest: string | null = null;
    for (const window of windows) {
      if (product?.cycle ? window.cycle !== product.cycle : supportEnded(window.eol, target.observedAt ?? "")) continue;
      if (window.latest !== null && (latest === null || compareVersions(window.latest, latest) === 1)) latest = window.latest;
    }
    return { status: "ok", answers: latest === null ? [] : [{ channel: "stable", version: latest, advisory: true, installable: false }] };
  },
  extra(_target, status, body) {
    return status === 200 ? cycles(body) ?? [] : [];
  },
};
