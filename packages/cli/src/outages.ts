import { outagesResponse, updateWatchFile, watchFileReader, type Db } from "@scout/core";

export interface OutagesCommandOptions {
  write?: (line: string) => void;
  /** Where the watch switches live, normally `.scout-data/watch.json`. */
  watchPath: string;
  now?: () => number;
}

const USAGE = "outages requires pause <minutes>, resume, watch|unwatch <machine|check|item> <name>, or list filters";

/** Lists the outage log, and edits the watch switches the hub reads (pause, resume, switch a machine, a kind of check or one item off). */
export function outagesCommand(db: Db, args: string[], options: OutagesCommandOptions): void {
  const write = options.write ?? console.log;
  const now = options.now ?? Date.now;
  const read = watchFileReader(options.watchPath);
  const command = args[0];
  if (command === "pause") {
    const minutes = Number(args[1]);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10_080) throw new Error("pause requires a number of minutes from 1 to 10080");
    const config = updateWatchFile(options.watchPath, read(), { pausedUntil: new Date(now() + minutes * 60_000).toISOString() });
    write(JSON.stringify({ pausedUntil: config.pausedUntil }));
    return;
  }
  if (command === "resume") {
    updateWatchFile(options.watchPath, read(), { pausedUntil: null });
    write(JSON.stringify({ pausedUntil: null }));
    return;
  }
  if (command === "watch" || command === "unwatch") {
    const [, scope, name] = args;
    if (scope !== "machine" && scope !== "check" && scope !== "item" || !name) throw new Error(USAGE);
    const config = updateWatchFile(options.watchPath, read(), { [scope]: name, watched: command === "watch" });
    write(JSON.stringify({ machines: config.machines, checks: config.checks, items: config.items }));
    return;
  }
  if (command !== undefined && !command.startsWith("--")) throw new Error(USAGE);
  const params = new URLSearchParams();
  for (const name of ["state", "limit", "machine"]) {
    const index = args.indexOf(`--${name}`);
    if (index < 0) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    params.set(name, value);
  }
  write(JSON.stringify(outagesResponse(db, read(), params, new Date(now()).toISOString())));
}
