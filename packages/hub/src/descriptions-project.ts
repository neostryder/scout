import { hubMachineId, findProjects, type Project, type ProjectDescriptionClient } from "@scout/core";
import { CogitatorClient, CogitatorError, loadCogitatorConfig, loadMachines, lookupCogitatorKey, type CogitatorOffReason } from "@scout/ops";

export interface ProjectDescriptionSource {
  client: ProjectDescriptionClient | null;
  projects: () => Project[];
  reason: CogitatorOffReason | null;
}

export function configuredProjects(machinesPath: string): Project[] {
  const machine = loadMachines(machinesPath).find((machine) => machine.id === hubMachineId() && machine.transport.type === "local") as { id: string; projectRoots?: string[] } | undefined;
  return machine ? findProjects(machine.id, machine.projectRoots ?? []) : [];
}

export async function createProjectDescriptionSource(options: {
  dataDir: string;
  machinesPath: string;
  key?: () => Promise<string | null>;
  fetch?: typeof fetch;
}): Promise<ProjectDescriptionSource> {
  const projects = (): Project[] => configuredProjects(options.machinesPath);
  try {
    const config = loadCogitatorConfig(options.dataDir);
    const key = await (options.key ?? lookupCogitatorKey)();
    if (!key) return { client: null, projects, reason: "no key" };
    const client = new CogitatorClient(config, key, { fetch: options.fetch });
    await client.discover();
    return { client, projects, reason: null };
  } catch (error) {
    const reason = error instanceof CogitatorError && ["not configured", "no key", "gateway is not local", "Cogitator is not running"].includes(error.message) ? error.message as CogitatorOffReason : "not configured";
    return { client: null, projects, reason };
  }
}
