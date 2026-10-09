#!/usr/bin/env node
// Coverage report. Usage: node packages/cli/src/report.ts [--db <path>]
// For each machine, the most recent result of every source: what ran, what it found, and what it could not see.
// A source that is missing here was never run, and an item absent from the catalog is never proof it is not installed.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCatalog } from "@scout/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const i = args.indexOf("--db");
const db = openCatalog(resolve(i >= 0 ? (args[i + 1] ?? "") : `${root}/.scout-data/catalog.db`));

interface CoverageRow {
  source_kind: string;
  location: string;
  ran_at: string;
  status: string;
  found: number;
  message: string | null;
}

const machines = db
  .prepare("SELECT id, name, kind, state, last_scan FROM machines ORDER BY kind, id")
  .all() as { id: string; name: string; kind: string; state: string; last_scan: string | null }[];

for (const m of machines) {
  const live = (db.prepare("SELECT COUNT(*) AS n FROM installs WHERE machine_id = ? AND removed_at IS NULL").get(m.id) as { n: number }).n;
  console.log(`\n${m.id}  [${m.kind}, ${m.state}]  ${live} installs  last scan ${m.last_scan ?? "never"}`);
  const rows = db
    .prepare(
      `SELECT c.source_kind, c.location, c.ran_at, c.status, c.found, c.message FROM coverage c
       WHERE c.machine_id = ? AND c.id = (SELECT MAX(id) FROM coverage WHERE machine_id = c.machine_id AND source_kind = c.source_kind AND location = c.location)
       ORDER BY c.source_kind, c.location`,
    )
    .all(m.id) as unknown as CoverageRow[];
  for (const r of rows) {
    const where = r.location ? ` [${r.location}]` : "";
    console.log(`  ${r.source_kind.padEnd(10)}${r.status.padEnd(9)}${String(r.found).padStart(5)}  ${r.ran_at}${where}${r.message ? `  ${r.message}` : ""}`);
  }
}
