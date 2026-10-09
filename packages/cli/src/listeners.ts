#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listListeners, type ListenerBind } from "@scout/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const bind = value("--bind");
const listenerClass = value("--class");
if (bind !== undefined && !["all", "lan", "loopback"].includes(bind)) throw new Error("--bind requires all, lan or loopback");
if (listenerClass !== undefined && !["essential", "optional", "third-party"].includes(listenerClass)) throw new Error("--class requires essential, optional or third-party");

// A read-only connection prevents a query command from creating or migrating the catalog.
const db = new DatabaseSync(resolve(value("--db") ?? `${root}/.scout-data/catalog.db`), { readOnly: true });
try {
  const filter = { machine: value("--machine"), bind: bind as ListenerBind | undefined, q: value("--q"), state: "present" as const, class: listenerClass as "essential" | "optional" | "third-party" | undefined, official: args.includes("--official") ? true : undefined };
  const allRows = listListeners(db, { ...filter, includeHidden: true });
  const rows = args.includes("--all") ? allRows : allRows.filter((row) => !row.classification.hidden);
  const hidden = allRows.length - rows.length;
  const clip = (text: string | null, length: number): string => (text ?? "").replace(/\s+/g, " ").slice(0, length).padEnd(length + 2);
  console.log(`${clip("Machine", 18)}${clip("Port", 7)}${clip("Bind", 8)}${clip("Address", 24)}${clip("Process or container", 36)}Path or image`);
  for (const row of rows) console.log(`${clip(row.machineName, 18)}${clip(String(row.port), 7)}${clip(row.bind, 8)}${clip(row.address, 24)}${clip(row.processName ?? row.containerName, 36)}${(row.processPath ?? row.containerImage ?? "").replace(/\s+/g, " ")}`);
  console.log(`\n${rows.length} listener${rows.length === 1 ? "" : "s"}`);
  if (!args.includes("--all")) console.log(`${hidden} hidden system rows (use --all)`);
} finally {
  db.close();
}
