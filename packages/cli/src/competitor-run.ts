#!/usr/bin/env node
// Runs one competitor tool from the command line, for a research session that has no MCP connection to Scout.
// Usage: node packages/cli/src/competitor-run.ts <queue|claim|complete|fail|list|gate|watch|repo|probe|facts> ['{"json":"args"}']
// probe reads a watch source once, with the same fetch and version rules the hub uses, and saves nothing.
// facts reads GitHub's releases, commits, files, manifest, and license for a run (pass runId) or for a span (pass remoteUrl, from, to) and says whether the span is a version-only bump that needs no research pass. It saves nothing and never claims or completes a run.
// It reads the catalog and registry of the checkout it runs from, so the installed copy talks to the live hub's data.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkWatchSource, gatherFacts, judgeSpan, localPaths, scoutRoot, versionOnlyDraft, type FactsFetcher, type LocalPaths } from "@scout/ops";
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
  repo: "scout_competitor_repo",
};

function githubToken(): string | null {
  const set = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (set) return set;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim() || null; } catch { return null; }
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const side = (value: unknown): { version: string | null; commit: string | null } => {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { version: text(item["version"]), commit: text(item["commit"]) };
};

export async function runCompetitorTool(command: string | undefined, rawArgs: string | undefined, paths: LocalPaths = localPaths(scoutRoot()), fetcher?: Parameters<typeof checkWatchSource>[1] | FactsFetcher): Promise<unknown> {
  const name = command === undefined ? undefined : TOOLS[command];
  if (!name && command !== "probe" && command !== "facts") throw new Error(`usage: competitor-run.ts <${[...Object.keys(TOOLS), "probe", "facts"].join("|")}> [json arguments]`);
  let args: Record<string, unknown> = {};
  if (rawArgs !== undefined && rawArgs.trim() !== "") {
    let parsed: unknown;
    try { parsed = JSON.parse(rawArgs); } catch { throw new Error("the arguments must be JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the arguments must be a JSON object");
    args = parsed as Record<string, unknown>;
  }
  if (command === "facts") {
    let request: Record<string, unknown> = args;
    let competitorName = text(args["name"]) ?? "The competitor";
    if (args["runId"] !== undefined) {
      const queue = createTools({ paths }).find((item) => item.name === "scout_competitor_queue");
      const listed = (await queue!.run({ states: ["queued", "claimed"] })) as { runs: Array<{ id: number; request: Record<string, unknown> | null }> };
      const run = listed.runs.find((item) => item.id === args["runId"]);
      if (!run?.request) throw new Error("no queued or claimed run with that id and a request");
      const competitor = run.request["competitor"] as Record<string, unknown> | undefined;
      competitorName = text(competitor?.["name"]) ?? competitorName;
      request = { remoteUrl: competitor?.["remoteUrl"], from: run.request["from"], to: run.request["to"] };
    }
    const live: FactsFetcher = (fetcher as FactsFetcher | undefined) ?? (async (url, init) => { const response = await fetch(url, init); return { ok: response.ok, status: response.status, json: () => response.json(), text: () => response.text() }; });
    const facts = await gatherFacts({ remoteUrl: text(request["remoteUrl"]), from: side(request["from"]), to: side(request["to"]) }, live, { token: fetcher ? null : githubToken() });
    const verdict = judgeSpan(facts);
    return { versionOnly: verdict.versionOnly, reason: verdict.reason, facts, ...(verdict.versionOnly ? { releaseDraft: versionOnlyDraft(competitorName, facts, verdict) } : {}) };
  }
  if (command === "probe") {
    const checked = checkWatch(args);
    if (!checked.ok) throw new Error(checked.error);
    const read = await checkWatchSource(checked.watch, fetcher as Parameters<typeof checkWatchSource>[1]);
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
