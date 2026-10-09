#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listServices, type ServiceKind, type ServiceState } from "@scout/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const kinds = ["windows-service", "scheduled-task", "launchd"];
const states = ["running", "stopped", "disabled", "other"];
const kind = value("--kind");
const state = value("--state");
const serviceClass = value("--class");
if (kind !== undefined && !kinds.includes(kind)) throw new Error("--kind requires windows-service, scheduled-task or launchd");
if (state !== undefined && !states.includes(state)) throw new Error("--state requires running, stopped, disabled or other");
if (serviceClass !== undefined && !["essential", "optional", "third-party"].includes(serviceClass)) throw new Error("--class requires essential, optional or third-party");

// A read-only connection prevents a query command from creating or migrating the catalog.
const db = new DatabaseSync(resolve(value("--db") ?? `${root}/.scout-data/catalog.db`), { readOnly: true });
try {
  const filter = { machine: value("--machine"), kind: kind as ServiceKind | undefined, state: state as ServiceState | undefined, q: value("--q"), hasPort: args.includes("--ports") ? true : undefined, gone: "present" as const, class: serviceClass as "essential" | "optional" | "third-party" | undefined, official: args.includes("--official") ? true : undefined };
  const allRows = listServices(db, { ...filter, includeHidden: true });
  const rows = args.includes("--all") ? allRows : allRows.filter((row) => !row.classification.hidden);
  const hidden = allRows.length - rows.length;
  const clip = (text: string | null, length: number): string => (text ?? "").replace(/\s+/g, " ").slice(0, length).padEnd(length + 2);
  console.log(`${clip("Machine", 18)}${clip("Kind", 16)}${clip("Domain", 8)}${clip("State", 10)}${clip("Name", 42)}Ports`);
  for (const row of rows) console.log(`${clip(row.machineName, 18)}${clip(row.kind, 16)}${clip(row.domain, 8)}${clip(row.state, 10)}${clip(row.name, 42)}${row.ports.map((port) => port.port).join(",")}`);
  console.log(`\n${rows.length} service${rows.length === 1 ? "" : "s"}`);
  if (!args.includes("--all")) console.log(`${hidden} hidden system rows (use --all)`);
} finally {
  db.close();
}
