import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { systemsMapMarkdown, whoIs, type Db } from "@scout/core";
import { localMapInput, localStatus, type LocalPaths } from "@scout/ops";

export interface InsightOptions { paths: LocalPaths; write?: (line: string) => void; now?: string }

const optionValue = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  const next = index < 0 ? undefined : args[index + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
};

/** `status [--json]`: how the fleet is doing and which rows are the reason. */
export function statusCommand(db: Db, args: string[], options: InsightOptions): void {
  const write = options.write ?? console.log;
  const status = localStatus(db, options.paths, options.now);
  if (args.includes("--json")) { write(JSON.stringify(status)); return; }
  write(`Overall: ${status.state}. Open outages: ${status.openOutages}.`);
  for (const machine of status.machines) {
    const c = machine.counts;
    write(`${machine.name.padEnd(16)} ${machine.reachable ? machine.worst : "unreachable"}  up ${c.up}, changed ${c.changed}, down ${c.down}, stopped ${c.stopped}${machine.hidden ? `, hidden ${machine.hidden}` : ""}`);
  }
  for (const outage of status.outages) write(`OUTAGE   ${outage.machineId ?? "-"}: ${outage.label} - ${outage.detail}`);
  for (const problem of status.problems) write(`${problem.state.toUpperCase().padEnd(8)} ${problem.machineId}: ${problem.label}${problem.port === null ? "" : ` (port ${problem.port})`}${problem.detail ? ` - ${problem.detail}` : ""}`);
}

/** `whois <port|name> [--json]`: what owns a port or matches a name, on every machine. */
export function whoisCommand(db: Db, args: string[], options: InsightOptions): void {
  const write = options.write ?? console.log;
  const query = args.find((arg) => !arg.startsWith("--"));
  if (query === undefined) throw new Error("whois requires a port number or a name");
  const matches = whoIs(db, query);
  if (args.includes("--json")) { write(JSON.stringify({ query, matches })); return; }
  if (matches.length === 0) { write(`Nothing matches ${query}.`); return; }
  for (const m of matches) write(`${m.machineName}: ${m.kind} ${m.name}${m.port === null ? "" : ` on port ${m.port}${m.bind ? ` (${m.bind})` : ""}`}, ${m.state}${m.program ? `, ${m.program}` : ""}${m.detail ? `. ${m.detail}` : ""}`);
}

/** `map [--out path]`: the systems map as markdown, printed or written to a file. */
export function mapCommand(db: Db, args: string[], options: InsightOptions): void {
  const write = options.write ?? console.log;
  const text = systemsMapMarkdown(localMapInput(db, options.paths, options.now));
  const out = optionValue(args, "--out");
  if (args.includes("--out") && out === undefined) throw new Error("--out requires a file path");
  if (out === undefined) { write(text.trimEnd()); return; }
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, target);
  write(`Wrote ${target}`);
}
