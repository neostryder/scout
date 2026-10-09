#!/usr/bin/env node
// Enrichment queue. Usage:
//   node packages/cli/src/enrich.ts export [--size 40] [--out dir]   write todo batches (names only, no paths or hosts)
//   node packages/cli/src/enrich.ts apply <answers.json>...          validate and store answers from a model
//   node packages/cli/src/enrich.ts status                            what is described, categorized, and still open
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, applyEnrichment, extractJsonArray, openCatalog, todoList, type Answer } from "@scout/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [command, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const db = openCatalog(resolve(opt("--db") ?? `${root}/.scout-data/catalog.db`));

if (command === "export") {
  const size = Number(opt("--size") ?? 40);
  const out = resolve(opt("--out") ?? `${root}/.scout-data/enrich`);
  mkdirSync(out, { recursive: true });
  const todo = todoList(db);
  let n = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size).map((t) => ({
      name: t.display,
      kinds: t.ecosystems,
      ...(t.publisher ? { publisher: t.publisher } : {}),
      ...(t.homepage ? { homepage: t.homepage } : {}),
    }));
    writeFileSync(`${out}/todo-${String(++n).padStart(3, "0")}.json`, JSON.stringify(batch, null, 1) + "\n");
  }
  writeFileSync(`${out}/categories.json`, JSON.stringify(CATEGORIES) + "\n");
  console.log(`${todo.length} names in ${n} batches of up to ${size} written to ${out}`);
} else if (command === "apply") {
  let applied = 0;
  const rejected: { name: string; reason: string }[] = [];
  for (const file of rest.filter((a) => !a.startsWith("--"))) {
    let answers: Answer[];
    const found = extractJsonArray(readFileSync(file, "utf8"));
    if (!found) {
      console.log(`${file}: no JSON array in the reply`);
      continue;
    }
    answers = found as Answer[];
    const r = applyEnrichment(db, answers);
    applied += r.applied;
    rejected.push(...r.rejected);
  }
  console.log(`${applied} answers applied, ${rejected.length} refused`);
  for (const r of rejected.slice(0, 30)) console.log(`  ${r.name}: ${r.reason}`);
} else if (command === "status") {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  console.log(`packages ${one("SELECT COUNT(*) n FROM packages")}`);
  console.log(`described: source ${one("SELECT COUNT(*) n FROM packages WHERE description_source = 'source'")}, generated ${one("SELECT COUNT(*) n FROM packages WHERE description_source = 'generated'")}, manual ${one("SELECT COUNT(*) n FROM packages WHERE description_source = 'manual'")}`);
  console.log(`categorized: rule ${one("SELECT COUNT(*) n FROM packages WHERE category_source = 'rule'")}, generated ${one("SELECT COUNT(*) n FROM packages WHERE category_source = 'generated'")}, manual ${one("SELECT COUNT(*) n FROM packages WHERE category_source = 'manual'")}`);
  console.log(`names still open: ${todoList(db).length}`);
} else {
  console.log("usage: enrich.ts export | apply <file>... | status");
  process.exit(2);
}
