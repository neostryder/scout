#!/usr/bin/env node
// Ask the owning package managers for the latest version of every installed package that is due, then print the updates.
// Usage: node packages/cli/src/research.ts [--limit N] [--db path]
// Only package names go out, to public endpoints (formulae.brew.sh, registry.npmjs.org, pypi.org).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveScanAssertions, openCatalog, updatesView } from "@scout/core";
import { RESEARCHERS, runResearch } from "@scout/research";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const db = openCatalog(resolve(opt("--db") ?? `${root}/.scout-data/catalog.db`));
const limit = opt("--limit") ? Number(opt("--limit")) : undefined;

const derived = deriveScanAssertions(db);
const summaries = await runResearch(db, RESEARCHERS, { ...(limit === undefined ? {} : { limit }) });
for (const s of summaries) console.log(`${s.source.padEnd(9)} asked ${s.asked}, ok ${s.ok}, not found ${s.notfound}, failed ${s.failed}, skipped ${s.skipped}, answers ${s.answers}`);
console.log(`scan answers (winget, Store): ${derived.assertions}`);
const rows = updatesView(db, { onlyOutdated: true });
console.log(`\n${rows.filter((r) => r.updatable).length} updatable, ${rows.filter((r) => r.blockedBy).length} blocked, ${rows.filter((r) => r.upstream).length} with a newer upstream`);
for (const r of rows.filter((r) => r.updatable).slice(0, 25)) console.log(`  ${r.machineId.padEnd(10)} ${r.name.padEnd(32)} ${String(r.installed).padEnd(14)} -> ${r.available}  (${r.availableSource})`);
