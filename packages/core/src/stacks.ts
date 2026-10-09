import { hubMachineId } from "./hub.ts";
import type { Db } from "./db.ts";
import { listServices, type ServiceKind } from "./services.ts";
import { recipesResponse } from "./recipes.ts";
import { registryFileReader, registryObject, registryPort, type RegistryFile } from "./ports.ts";

interface MemberWait { waitPort?: number; waitSeconds: number }
export type StackMember = MemberWait & ({ type: "recipe"; project: string; source: "package-json" | "launch-json" | "compose"; name: string } | { type: "service"; machine: string; kind: ServiceKind; name: string });
export interface Stack { name: string; label: string; members: StackMember[] }
export type StackState = "ready" | "partial" | "running" | "blocked";
export interface ResolvedStackMember {
  order: number; type: "service" | "recipe"; label: string; machineId: string; detail: string;
  waitPort: number | null; waitSeconds: number; running: boolean | null; available: boolean; reason: string | null;
  rowId: number | null;
}
export interface ResolvedStack { name: string; label: string; state: StackState; members: ResolvedStackMember[] }

export function validateStacks(data: unknown): { config: Stack[]; fileError: string | null } {
  if (!registryObject(data) || !Array.isArray(data.stacks)) throw new Error("The stack registry must contain a stacks array.");
  const stacks: Stack[] = [];
  const errors: string[] = [];
  for (const [index, row] of data.stacks.entries()) {
    let reason: string | null = null;
    const members: StackMember[] = [];
    if (!registryObject(row)) reason = "the entry must be an object";
    else if (typeof row.name !== "string" || !/^[a-z0-9-]{1,32}$/.test(row.name)) reason = "the name must contain 1 to 32 lowercase letters, digits or hyphens";
    else if (stacks.some((stack) => stack.name === row.name)) reason = "the name is duplicated";
    else if (typeof row.label !== "string" || !row.label.length) reason = "the label must be nonempty text";
    else if (!Array.isArray(row.members) || row.members.length < 1 || row.members.length > 12) reason = "the stack must contain 1 to 12 members";
    else if (stacks.length >= 32) reason = "the registry already contains 32 stacks";
    else for (const [memberIndex, member] of row.members.entries()) {
      let problem: string | null = null;
      if (!registryObject(member)) problem = "must be an object";
      else if (member.waitPort !== undefined && !registryPort(member.waitPort)) problem = "has an invalid waitPort";
      else if (member.waitSeconds !== undefined && (!Number.isInteger(member.waitSeconds) || Number(member.waitSeconds) < 5 || Number(member.waitSeconds) > 120)) problem = "has an invalid waitSeconds";
      else if (typeof member.name !== "string" || !member.name.length) problem = "needs a nonempty name";
      else if (member.type === "recipe") {
        if (typeof member.project !== "string" || !member.project.length || !["package-json", "launch-json", "compose"].includes(String(member.source))) problem = "needs a project folder and a recipe source";
      } else if (member.type === "service") {
        if (typeof member.machine !== "string" || !member.machine.length || !["windows-service", "scheduled-task", "launchd"].includes(String(member.kind))) problem = "needs a machine and a service kind";
      } else problem = "must have type service or recipe";
      if (problem) { reason = `member ${memberIndex + 1} ${problem}`; break; }
      members.push({ ...member, waitSeconds: member.waitSeconds ?? 30 } as StackMember);
    }
    if (reason) errors.push(`Stack ${index + 1} was dropped because ${reason}.`);
    else stacks.push({ name: row!.name as string, label: row!.label as string, members });
  }
  return { config: stacks, fileError: errors.length ? errors.join(" ") : null };
}

export const stacksFileReader = (path = ".scout-data/stacks.json") => registryFileReader(path, () => [] as Stack[], validateStacks);

export function resolveStack(db: Db, stack: Stack): ResolvedStack {
  const services = listServices(db, { includeHidden: true });
  const recipes = recipesResponse(db).recipes;
  const members = stack.members.map((member, index): ResolvedStackMember => {
    const common = { order: index + 1, type: member.type, waitPort: member.waitPort ?? null, waitSeconds: member.waitSeconds };
    if (member.type === "service") {
      const service = services.find((row) => row.machineId === member.machine && row.kind === member.kind && row.name === member.name && row.goneAt === null);
      const label = service?.displayName ?? member.name.replace(/^.*[/\\]/, "");
      const noun = member.kind === "scheduled-task" ? "scheduled task" : member.kind === "windows-service" ? "Windows service" : "launchd job";
      return { ...common, label, machineId: member.machine, detail: `${noun} ${member.name}`, rowId: service?.id ?? null, running: service ? service.state === "running" : false, available: !!service, reason: service ? null : "No such service." };
    }
    const recipe = recipes.find((row) => row.project === member.project && row.source === member.source && row.name === member.name);
    const reason = !recipe ? "No such recipe." : recipe.gone ? "The recipe source is gone." : recipe.state !== "approved" ? "The recipe needs approval." : null;
    return { ...common, label: `${member.project} ${member.name}`, machineId: recipe?.machineId ?? hubMachineId(), detail: recipe ? `${recipe.command} in ${recipe.cwd}` : `${member.project} ${member.name}`, rowId: recipe?.id ?? null, running: recipe?.running ?? null, available: reason === null, reason };
  });
  const state: StackState = members.some((member) => !member.available) ? "blocked" : members.every((member) => member.running === true) ? "running" : members.some((member) => member.running === true) ? "partial" : "ready";
  return { name: stack.name, label: stack.label, state, members };
}

export function stacksResponse(db: Db, file: RegistryFile<Stack[]>, at = new Date().toISOString()) {
  return { stacks: file.config.map((stack) => {
    const resolved = resolveStack(db, stack);
    return { ...resolved, members: resolved.members.map(({ rowId, ...member }) => member) };
  }), file: { path: ".scout-data/stacks.json", exists: file.exists, error: file.fileError }, generatedAt: at };
}
