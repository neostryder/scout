import { DESCRIPTION_SOURCES, describeRow, listListeners, listProjectDescriptions, listServices, loadDescriptionResolver, runProjectDescriptions, runPublicDescriptions, setHandDescription, type Db, type ModelRunner } from "@scout/core";
import { fileURLToPath } from "node:url";
import { configuredProjects, createProjectDescriptionSource, type ProjectDescriptionSource } from "../../hub/src/descriptions-project.ts";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export async function describeCommand(db: Db, args: string[], options: { write?: (line: string) => void; model?: ModelRunner; modelLabel?: string; project?: ProjectDescriptionSource; dataDir?: string; machinesPath?: string } = {}): Promise<void> {
  const write = options.write ?? console.log;
  const command = args[0];
  if (command === "project") {
    const action = args[1];
    if (!["list", "run", "show"].includes(action ?? "")) throw new Error("usage: describe project list|run [--force] [--only name]|show name");
    const dataDir = options.dataDir ?? fileURLToPath(new URL("../../../.scout-data", import.meta.url));
    const machinesPath = options.machinesPath ?? fileURLToPath(new URL("../../../machines.json", import.meta.url));
    if (action === "run") {
      if (args.includes("--only") && (!value(args, "--only") || value(args, "--only")!.startsWith("--"))) throw new Error("--only requires a name");
      const source = options.project ?? await createProjectDescriptionSource({ dataDir, machinesPath });
      if (!source.client) throw new Error("project descriptions are off");
      const projects = source.projects();
      const only = value(args, "--only");
      if (only && !projects.some((project) => project.name.toLowerCase() === only.toLowerCase())) throw new Error("project not found");
      const result = await runProjectDescriptions(db, projects, source.client, { force: args.includes("--force"), only });
      write(JSON.stringify({ total: result.total, done: result.done, applied: result.applied, skipped: result.skipped, rejected: result.rejected }));
      if (result.state === "failed") throw new Error(result.error ?? "project description run failed");
    } else {
      const projects = listProjectDescriptions(db, options.project?.projects() ?? configuredProjects(machinesPath));
      if (action === "list") {
        for (const project of projects) write(JSON.stringify({ name: project.name, root: project.root, hashState: project.hashState, description: project.description }));
      } else {
        const project = projects.find((project) => project.name.toLowerCase() === args[2]?.toLowerCase());
        if (!project) throw new Error("project not found");
        write(JSON.stringify({ text: project.text, description: project.description, evidence: project.evidence, confidence: project.confidence }));
      }
    }
    return;
  }
  if (command === "public") {
    if (!options.model && !process.env["SCOUT_AI_TOOLKIT"]) throw new Error("SCOUT_AI_TOOLKIT is not set, so no model can be used");
    const real = options.model ? null : (await import("../../hub/src/models.ts")).createAiModelRunner();
    const result = await runPublicDescriptions(db, options.model ?? real!, { modelLabel: options.modelLabel ?? real?.labels.public });
    write(JSON.stringify({ total: result.total, done: result.done, applied: result.applied, skipped: result.skipped, rejected: result.rejected }));
    if (result.state === "failed") throw new Error(result.error ?? "description run failed");
    return;
  }
  if (command === "set" || command === "clear") {
    const target = args[1];
    const id = Number(args[2]);
    if (target !== "service" && target !== "listener") throw new Error("target must be service or listener");
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("id must be a positive integer");
    if (command === "set" && args[3] === undefined) throw new Error("text is required");
    const resolver = loadDescriptionResolver(db);
    const rows = target === "service" ? listServices(db, {}, resolver) : listListeners(db, {}, resolver);
    const row = rows.find((item) => item.id === id);
    if (!row) throw new Error("not found");
    setHandDescription(db, resolver.subject(row), command === "clear" ? null : args[3]!);
    write(JSON.stringify({ description: describeRow(db, row) }));
    return;
  }
  if (command !== undefined && !command.startsWith("--")) throw new Error("usage: describe [set|clear|public|project] [--missing] [--source source] [--machine id]");
  const source = value(args, "--source");
  if (source !== undefined && ![...DESCRIPTION_SOURCES, "none"].includes(source as typeof DESCRIPTION_SOURCES[number])) throw new Error("unknown description source");
  const machine = value(args, "--machine");
  const resolver = loadDescriptionResolver(db);
  const services = listServices(db, { machine, gone: "present" }, resolver).map((row) => ({ target: "service", ...row }));
  const listeners = listListeners(db, { machine, state: "present" }, resolver).map((row) => ({ target: "listener", ...row }));
  for (const row of [...services, ...listeners]) {
    if (args.includes("--missing") && row.description !== null) continue;
    if (source !== undefined && (row.description?.source ?? "none") !== source) continue;
    write(JSON.stringify({ target: row.target, id: row.id, machineId: row.machineId, name: "name" in row ? row.name : row.processName, description: row.description, source: row.description?.source ?? "none" }));
  }
}
