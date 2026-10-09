import { joinedInstall, listActions, protectedFileReader, protectedResponse, uninstallInstructions, type ControlAction, type ControlTarget, type Db } from "@scout/core";
import { ControlRunner, resolveControlRow, type ControlRunnerDeps } from "@scout/ops";

export interface ControlCommandOptions { deps?: ControlRunnerDeps; write?: (line: string) => void; protectedPath?: string }

export async function controlCommand(db: Db, args: string[], options: ControlCommandOptions = {}): Promise<void> {
  const write = options.write ?? console.log;
  const output = (data: unknown): void => write(JSON.stringify(data));
  const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const command = args[0];
  if (command === "log") {
    const raw = value("--limit");
    const limit = raw === undefined ? 50 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit requires an integer from 1 to 200");
    const machine = value("--machine");
    output({ items: listActions(db, { limit, ...(machine ? { machine } : {}) }), generatedAt: new Date().toISOString() });
    return;
  }
  if (command === "protected") { output(protectedResponse(protectedFileReader(options.protectedPath ?? options.deps?.protectedPath ?? ".scout-data/protected.json")())); return; }
  if (command !== "plan" && command !== "run" && command !== "uninstall") throw new Error("control requires plan, run, log, protected or uninstall");
  if (command === "run" && !args.includes("--yes")) throw new Error("control run requires --yes");
  const target = args[1] as ControlTarget;
  const id = Number(args[2]);
  if (target !== "service" && target !== "listener") throw new Error("target must be service or listener");
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("id must be a positive integer");
  const row = resolveControlRow(db, target, id);
  if (!row) throw new Error("not found");
  if (command === "uninstall") { output(uninstallInstructions(row, joinedInstall(db, row))); return; }
  const action = args[3] as ControlAction;
  if (!["start", "stop", "restart"].includes(action)) throw new Error("action must be start, stop or restart");
  const hard = args.includes("--hard");
  if (hard && action !== "stop") throw new Error("--hard is allowed only for stop");
  const deps = options.deps ?? { machines: [] };
  const runner = new ControlRunner(db, { ...deps, ...(options.protectedPath ? { protectedPath: options.protectedPath } : {}), ...(command === "plan" ? { reader: async (_machine, stored) => stored } : {}) });
  try {
    const plan = await runner.plan(target, id, action, hard);
    if (!plan) throw new Error("not found");
    if (command === "plan" || !plan.allowed) {
      const { token, ...printable } = plan;
      output(printable);
      return;
    }
    const started = await runner.run(plan.id!, plan.token!);
    if (started.state === "waiting") output({ actionId: started.actionId, state: started.state, sudoCommand: started.sudoCommand });
    output(await runner.wait(started.actionId));
  } finally { runner.close(); }
}
