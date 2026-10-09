#!/usr/bin/env node
// Query the catalog with the shared filter. Reads only; never scans.
//   node packages/cli/src/list.ts [--machine a,b] [--source s] [--ecosystem e] [--kind k] [--category c] [-q text]
//     [--path prefix] [--no-libs] [--new-since ISO] [--used-within days] [--never-used] [--unknown-use] [--running]
//     [--autostart] [--ai] [--presence one|all|some] [--sort name|path|machine|lastUsed|firstSeen]
//     [--limit n] [--offset n] [--facets] [--db path]
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countInstalls, facetCounts, openCatalog, queryInstalls, type FacetDimension, type Filter } from "@scout/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (name: string): string[] | undefined => value(name)?.split(",").filter(Boolean);
const on = (name: string): boolean => args.includes(name);
const num = (name: string): number | undefined => {
  const v = value(name);
  return v === undefined ? undefined : Number(v);
};

const filter: Filter = {
  ...(list("--machine") ? { machines: list("--machine") as string[] } : {}),
  ...(list("--source") ? { sources: list("--source") as string[] } : {}),
  ...(list("--ecosystem") ? { ecosystems: list("--ecosystem") as string[] } : {}),
  ...(list("--kind") ? { kinds: list("--kind") as string[] } : {}),
  ...(list("--category") ? { categories: list("--category") as string[] } : {}),
  ...((value("-q") ?? value("--text")) ? { text: (value("-q") ?? value("--text")) as string } : {}),
  ...(value("--path") ? { pathPrefix: value("--path") as string } : {}),
  ...(on("--no-libs") ? { hideLibraries: true } : {}),
  ...(value("--new-since") ? { newSince: value("--new-since") as string } : {}),
  ...(num("--used-within") !== undefined ? { usedWithinDays: num("--used-within") as number } : {}),
  ...(on("--never-used") ? { neverUsed: true } : {}),
  ...(on("--unknown-use") ? { unknownUse: true } : {}),
  ...(on("--running") ? { running: true } : {}),
  ...(on("--autostart") ? { autostart: true } : {}),
  ...(on("--ai") ? { aiUsed: true } : {}),
  ...(value("--presence") ? { presence: value("--presence") as NonNullable<Filter["presence"]> } : {}),
  ...(value("--sort") ? { sort: value("--sort") as NonNullable<Filter["sort"]> } : {}),
  limit: num("--limit") ?? 40,
  offset: num("--offset") ?? 0,
};

const db = openCatalog(resolve(value("--db") ?? `${root}/.scout-data/catalog.db`));
const total = countInstalls(db, filter);

if (on("--facets")) {
  for (const dim of ["machine", "source", "kind", "category"] as FacetDimension[]) {
    const rows = facetCounts(db, filter, dim);
    console.log(`${dim}: ${rows.map((r) => `${r.value} ${r.count}`).join(", ")}`);
  }
  console.log("");
}

const clip = (s: string | null, n: number): string => (s ?? "").replace(/\s+/g, " ").slice(0, n);
for (const r of queryInstalls(db, filter)) {
  console.log(
    `${r.machineId.padEnd(18)}${r.sourceKind.padEnd(9)}${clip(r.name, 34).padEnd(36)}${clip(r.version, 14).padEnd(16)}${clip(r.description, 60)}`,
  );
}
console.log(`\n${total} match${total === 1 ? "" : "es"}${total > (filter.limit ?? 0) + (filter.offset ?? 0) ? `, showing ${filter.limit} from ${filter.offset}` : ""}`);
