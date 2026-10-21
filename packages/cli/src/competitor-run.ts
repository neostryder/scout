#!/usr/bin/env node
// Runs one competitor tool from the command line, for a research session that has no MCP connection to Scout.
// Usage: node packages/cli/src/competitor-run.ts <queue|claim|complete|fail|list|gate|watch|probe> ['{"json":"args"}']
// probe reads a watch source once, with the same fetch and version rules the hub uses, and saves nothing.
// It reads the catalog and registry of the checkout it runs from, so the installed copy talks to the live hub's data.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWatchSource, localPaths, scoutRoot, type LocalPaths } from "@scout/ops";
import { checkWatch } from "@scout/core";
import { createTools } from "../../mcp/src/index.ts";

const TOOLS: Record<string, string> = {
  list: "scout_competitors",
  queue: "scout_competitor_queue",
  claim: "scout_competitor_claim",
  complete: "scout_competitor_complete",
  fail: "scout_competitor_fail",
  gate: "scout_competitor_gate",
  watch: "scout_competitor_watch",
};

export async function runCompetitorTool(command: string | undefined, rawArgs: string | undefined, paths: LocalPaths = localPaths(scoutRoot()), fetcher?: Parameters<typeof checkWatchSource>[1]): Promise<unknown> {
  const name = command === undefined ? undefined : TOOLS[command];
  if (!name && command !== "probe") throw new Error(`usage: competitor-run.ts <${[...Object.keys(TOOLS), "probe"].join("|")}> [json arguments]`);
  let args: Record<string, unknown> = {};
  if (rawArgs !== undefined && rawArgs.trim() !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(rawArgs); } catch { throw new Error("the arguments must be JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the arguments must be a JSON object");
    args = parsed as Record<string, unknown>;
  }
  if (command === "probe") {
    const checked = checkWatch(args);
    if (!checked.ok) throw new Error(checked.error);
    const read = await checkWatchSource(checked.watch, fetcher);
    return { version: read.version, token: read.commit, error: read.error, excerpt: read.excerpt.slice(0, 300) };
  }
  const tool = createTools({ paths }).find((item) => item.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runCompetitorTool(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "command failed");
    process.exitCode = 1;
  }
}
