import { stacksFileReader, stacksResponse, type ActionRecord, type Db } from "@scout/core";
import { ControlRunner, type ControlRunnerDeps } from "@scout/ops";

export async function stacksCommand(db: Db, args: string[], options: { deps?: ControlRunnerDeps; stacksPath?: string; write?: (line: string) => void } = {}): Promise<void> {
  const write = options.write ?? console.log;
  const command = args[0];
  const stacksPath = options.stacksPath ?? options.deps?.stacksPath;
  if (!command || command === "--db") {
    const response = stacksResponse(db, stacksFileReader(stacksPath)());
    const clip = (value: unknown, width: number): string => String(value).replace(/\s+/g, " ").slice(0, width).padEnd(width + 2);
    write(`${clip("Name", 32)}${clip("State", 12)}Members`);
    for (const stack of response.stacks) write(`${clip(stack.name, 32)}${clip(stack.state, 12)}${stack.members.length}`);
    if (response.file.error) write(response.file.error);
    return;
  }
  if (command !== "plan" && command !== "start") throw new Error("stacks requires plan, start or no subcommand");
  if (command === "start" && !args.includes("--yes")) throw new Error("stacks start requires --yes");
  if (!args[1] || !/^[a-z0-9-]{1,32}$/.test(args[1])) throw new Error("stacks requires a stack name");
  const runner = new ControlRunner(db, { machines: [], ...options.deps, stacksPath, ...(command === "plan" ? { reader: async (_machine, row) => row } : {}) });
  try {
    const plan = await runner.plan("stack", args[1], "start");
    if (!plan) throw new Error("not found");
    if (command === "plan" || !plan.allowed) {
      for (const step of plan.steps ?? []) write(`${step.order}. ${step.label}: ${step.skipped ? "Already running" : step.allowed ? step.command : step.refusal}`);
      if (plan.refusal) write(plan.refusal);
      return;
    }
    for (const step of plan.steps ?? []) if (step.skipped) write(`${step.order}. ${step.label}: Already running`);
    runner.on("action", (record: ActionRecord) => {
      if (record.target === "stack" || record.state === "running") return;
      const step = plan.steps?.find((item) => item.type === record.target && item.command === record.command);
      write(`${step?.order ?? "-"}. ${step?.label ?? record.name}: ${record.state} - ${record.message ?? ""}`);
    });
    const run = await runner.run(plan.id!, plan.token!);
    const result = await runner.wait(run.actionId);
    write(result?.message ?? "The stack could not be confirmed.");
  } finally { runner.close(); }
}
