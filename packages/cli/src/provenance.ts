import { flaggedInstalls, mineFileReader, provenanceContext, provenanceResponse, refreshProjectGit, type Db, type FlagKind, type Project } from "@scout/core";

const KINDS: FlagKind[] = ["odd-location", "no-publisher", "unsigned", "mine"];
const clip = (value: unknown, width: number): string => String(value ?? "-").replace(/\s+/g, " ").slice(0, width).padEnd(width + 2);

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

/** `provenance` lists the projects and why each is or is not yours; `provenance scan` re-reads their git facts; `provenance flags` lists flagged installs. */
export async function provenanceCommand(db: Db, args: string[], options: { minePath: string; projects?: () => Project[]; write?: (line: string) => void }): Promise<void> {
  const write = options.write ?? console.log;
  const file = mineFileReader(options.minePath)();
  if (args[0] === "scan") {
    const result = await refreshProjectGit(db, options.projects?.() ?? []);
    write(JSON.stringify(result));
    return;
  }
  if (args[0] === "flags") {
    const kind = option(args, "--kind");
    if (kind !== undefined && !KINDS.includes(kind as FlagKind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
    const rows = flaggedInstalls(db, provenanceContext(db, file.profile), { ...(option(args, "--machine") ? { machine: option(args, "--machine")! } : {}), ...(kind ? { kind: kind as FlagKind } : {}) });
    write(`${clip("Machine", 12)}${clip("Name", 34)}${clip("Flags", 28)}Evidence`);
    for (const row of rows) write(`${clip(row.machineId, 12)}${clip(row.name, 34)}${clip(row.flags.map((flag) => flag.kind).join(", "), 28)}${row.flags.map((flag) => flag.evidence).join(" ")}`);
    write(`${rows.length} flagged install${rows.length === 1 ? "" : "s"}`);
    return;
  }
  if (args[0] && !args[0].startsWith("--")) throw new Error("provenance requires scan, flags, or no subcommand");
  const response = provenanceResponse(db, file);
  write(`${clip("Machine", 10)}${clip("Project", 30)}${clip("Remote", 44)}Mine`);
  for (const row of response.projects) write(`${clip(row.machineId, 10)}${clip(row.project, 30)}${clip(row.remote, 44)}${row.mine ?? "no"}`);
  if (!response.projects.length) write("No project git facts are stored yet. Run provenance scan.");
  if (file.fileError) write(file.fileError);
  else if (!file.profile.owners.length && !file.profile.emails.length) write("No owners or emails are set, so no project counts as yours. List them in .scout-data/mine.json.");
}
