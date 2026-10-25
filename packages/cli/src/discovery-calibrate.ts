#!/usr/bin/env node
// Score the competitors already in .scout-data/competitors.json with the discovery judge, to see how many the current bars would have offered.
// Usage: node packages/cli/src/discovery-calibrate.ts [--data <dir>] [--min-competitor 0.6] [--min-worth 0.4]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCompetitorsFile } from "@scout/core";
import { calibrateDiscovery, jevDecider, loadDiscoveryConfig, minimaxJudge } from "@scout/ops";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const dataDir = resolve(flag("--data") ?? ".scout-data");
const config = loadDiscoveryConfig(dataDir);
if (!config) { console.error("discovery.json is not in the data folder"); process.exit(1); }
if (flag("--min-competitor")) config.minCompetitor = Number(flag("--min-competitor"));
if (flag("--min-worth")) config.minWorthTracking = Number(flag("--min-worth"));

// Fifty-nine repository reads exceed GitHub's hourly allowance for anonymous callers, so use the signed-in gh token when there is one.
let token = process.env["GITHUB_TOKEN"] ?? "";
if (!token) { try { token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true }).trim(); } catch { /* anonymous */ } }
const authed = (init?: { headers?: Record<string, string>; signal?: AbortSignal }) => ({ ...init, headers: { ...init?.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

const registry = parseCompetitorsFile(readFileSync(resolve(dataDir, "competitors.json"), "utf8"));
const known = registry.entries.flatMap((entry) => entry.remoteUrl ? [{ name: entry.name, remoteUrl: entry.remoteUrl }] : []);
console.error(`Judging ${known.length} known competitors against bars ${config.minCompetitor} and ${config.minWorthTracking}.`);
const { rows, skipped } = await calibrateDiscovery({ config, known, fetcher: (url, init) => fetch(url, authed(init)), judge: minimaxJudge(), decider: jevDecider(), log: (line) => console.error(line) });
rows.sort((a, b) => a.competitor - b.competitor);
for (const row of rows) console.log([row.offered ? "offered" : "MISSED ", row.competitor.toFixed(2), row.worthTracking.toFixed(2), row.name, "|", row.summary.slice(0, 120), "| overlaps:", row.overlaps.join(",") || "none"].join(" "));
const offered = rows.filter((row) => row.offered).length;
console.log(`\n${offered} of ${rows.length} known competitors would have been offered. Skipped ${skipped.length}: ${skipped.join(", ") || "none"}.`);
