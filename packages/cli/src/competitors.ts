#!/usr/bin/env node
// Read the dossier library and the local mirrors and write .scout-data/competitors.json.
// Usage: node packages/cli/src/competitors.ts seed --dossiers <dir> --mirrors <dir> [--out <path>]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRemote, stripUserinfo } from "@scout/adapter-gitclone";
import { COMPETITOR_FLAGS, parseCompetitorsFile, type CompetitorBaseline, type CompetitorIdentity, type CompetitorsFile } from "@scout/core";
import { spawnGit, type GitRunner } from "@scout/ops";

const FLAG_SET = new Set<string>(COMPETITOR_FLAGS);
const NUMBERED = /^(?!00_)\d+_.+\.md$/i;

export interface ParsedDossier {
  title: string | null;
  repo: string | null;
  packageUrl: string | null;
  reviewed: string | null;
  org: string | null;
  flags: string[];
}

export interface FoundDossier {
  folder: string;
  title: string;
  repo: string | null;
  packageUrl: string | null;
  reviewed: string | null;
  org: string | null;
  flags: string[];
  key: string | null;
  repoName: string | null;
}

export interface FoundMirror {
  folder: string;
  remote: string;
  key: string | null;
  repoName: string;
}

export interface SeedSummary {
  entries: number;
  matched: number;
  unmatchedMirrors: number;
  dossiersWithoutMirror: number;
}

function portable(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function validDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function fieldValue(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

function flagsIn(value: string): string[] {
  const out: string[] = [];
  for (const part of fieldValue(value).split(/[^A-Za-z0-9]+/)) {
    const flag = part.toLowerCase();
    if (FLAG_SET.has(flag) && !out.includes(flag)) out.push(flag);
  }
  return out;
}

export function parseDossierMarkdown(text: string): ParsedDossier {
  const parsed: ParsedDossier = { title: null, repo: null, packageUrl: null, reviewed: null, org: null, flags: [] };
  let inFence = false;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#\s+(.+)$/.exec(line);
    if (heading?.[1] && !parsed.title) { parsed.title = heading[1].trim(); continue; }
    const body = line.replace(/^[-*]\s+/, "");
    const field = /^([A-Za-z][A-Za-z /]*)\s*:\s*(.*)$/.exec(body);
    if (!field?.[1]) continue;
    const label = field[1].trim().toLowerCase();
    const value = field[2] ?? "";
    if (label === "repo" && !parsed.repo) parsed.repo = fieldValue(value) || null;
    else if (label === "package" && !parsed.packageUrl) parsed.packageUrl = fieldValue(value) || null;
    else if (label === "last reviewed" && !parsed.reviewed) parsed.reviewed = validDate(fieldValue(value));
    else if (label === "organization / creator" && !parsed.org) parsed.org = fieldValue(value) || null;
    else if (label === "flags" || label === "tags") {
      for (const flag of flagsIn(value)) if (!parsed.flags.includes(flag)) parsed.flags.push(flag);
    }
  }
  return parsed;
}

export function remoteKey(remote: string): string | null {
  const cleaned = stripUserinfo(remote.trim());
  if (!cleaned) return null;
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(cleaned);
  const scp = /^[^@\s]+@[^:\s]+:\S+$/.test(cleaned);
  if (!url && !scp) return null;
  const normalized = normalizeRemote(cleaned, "repo");
  if (!normalized?.key.includes("/")) return null;
  return normalized.key;
}

function repoNameOf(remote: string, fallback: string): string {
  const normalized = normalizeRemote(stripUserinfo(remote.trim()), fallback);
  return normalized?.name || fallback;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function freshId(name: string, used: Set<string>): string {
  const base = slug(name);
  if (!used.has(base)) { used.add(base); return base; }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const id = `${base}-${n}`;
  used.add(id);
  return id;
}

interface Draft {
  name: string;
  org: string | null;
  remoteUrl: string | null;
  mirrorPath: string | null;
  packageUrl: string | null;
  dossierDir: string | null;
  dossierReviewed: string | null;
  flags: string[];
  key: string | null;
  repoName: string;
  measured: { version: string | null; commit: string | null } | null;
}

function emptyBaseline(): CompetitorBaseline {
  return { version: null, commit: null, at: null, source: "none" };
}

export function assembleSeed(input: {
  dossiers: FoundDossier[];
  mirrors: FoundMirror[];
  existing: CompetitorIdentity[];
  dossierRoot: string;
  mirrorRoot: string;
  today: string;
  baselines: Map<string, { version: string | null; commit: string | null }>;
}): { file: CompetitorsFile; matched: number; unmatchedMirrors: number; dossiersWithoutMirror: number } {
  const mirrorsByKey = new Map<string, FoundMirror>();
  for (const mirror of input.mirrors) if (mirror.key && !mirrorsByKey.has(mirror.key)) mirrorsByKey.set(mirror.key, mirror);
  const usedMirror = new Set<string>();
  const drafts: Draft[] = [];
  let matched = 0;
  let dossiersWithoutMirror = 0;
  for (const dossier of input.dossiers) {
    const mirror = dossier.key ? mirrorsByKey.get(dossier.key) : undefined;
    if (mirror) { matched += 1; usedMirror.add(mirror.folder); }
    else if (dossier.repo) dossiersWithoutMirror += 1;
    const remote = dossier.repo ? stripUserinfo(dossier.repo) : mirror?.remote ? stripUserinfo(mirror.remote) : null;
    drafts.push({
      name: dossier.title,
      org: dossier.org,
      remoteUrl: remote,
      mirrorPath: mirror ? portable(mirror.folder) : null,
      packageUrl: dossier.packageUrl,
      dossierDir: portable(dossier.folder),
      dossierReviewed: dossier.reviewed,
      flags: dossier.flags,
      key: dossier.key ?? mirror?.key ?? null,
      repoName: dossier.repoName ?? mirror?.repoName ?? dossier.title,
      measured: mirror ? input.baselines.get(mirror.folder) ?? null : null,
    });
  }
  let unmatchedMirrors = 0;
  for (const mirror of input.mirrors) {
    if (usedMirror.has(mirror.folder)) continue;
    unmatchedMirrors += 1;
    drafts.push({
      name: mirror.repoName,
      org: null,
      remoteUrl: stripUserinfo(mirror.remote),
      mirrorPath: portable(mirror.folder),
      packageUrl: null,
      dossierDir: null,
      dossierReviewed: null,
      flags: [],
      key: mirror.key,
      repoName: mirror.repoName,
      measured: input.baselines.get(mirror.folder) ?? null,
    });
  }
  const existingByKey = new Map<string, CompetitorIdentity>();
  for (const entry of input.existing) {
    const key = entry.remoteUrl ? remoteKey(entry.remoteUrl) : null;
    if (key && !existingByKey.has(key)) existingByKey.set(key, entry);
  }
  const usedExisting = new Set<string>();
  const usedIds = new Set(input.existing.map((entry) => entry.id));
  const updated = new Map<string, CompetitorIdentity>();
  const added: CompetitorIdentity[] = [];
  for (const draft of drafts) {
    const byKey = draft.key ? existingByKey.get(draft.key) : undefined;
    const prior = byKey && !usedExisting.has(byKey.id) ? byKey : undefined;
    if (prior) {
      usedExisting.add(prior.id);
      updated.set(prior.id, {
        ...prior,
        name: draft.name,
        org: draft.org,
        remoteUrl: draft.remoteUrl,
        mirrorPath: draft.mirrorPath,
        packageUrl: draft.packageUrl,
        dossierDir: draft.dossierDir,
        dossierReviewed: draft.dossierReviewed,
        flags: draft.flags,
      });
      continue;
    }
    const id = freshId(draft.repoName, usedIds);
    const baseline: CompetitorBaseline = draft.mirrorPath
      ? { version: draft.measured?.version ?? null, commit: draft.measured?.commit ?? null, at: draft.dossierReviewed ?? input.today, source: "mirror" }
      : emptyBaseline();
    added.push({ id, name: draft.name, org: draft.org, remoteUrl: draft.remoteUrl, mirrorPath: draft.mirrorPath, packageUrl: draft.packageUrl, dossierDir: draft.dossierDir, dossierReviewed: draft.dossierReviewed, flags: draft.flags, baseline });
  }
  const entries = input.existing.map((entry) => updated.get(entry.id) ?? entry).concat(added);
  return {
    file: { dossierRoot: portable(input.dossierRoot), mirrorRoot: portable(input.mirrorRoot), entries },
    matched,
    unmatchedMirrors,
    dossiersWithoutMirror,
  };
}

function readDossiers(root: string): FoundDossier[] {
  const found: FoundDossier[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = join(root, entry.name);
    const numbered = readdirSync(folder).filter((name) => NUMBERED.test(name)).sort();
    if (!numbered.length) continue;
    for (const name of numbered) {
      const parsed = parseDossierMarkdown(readFileSync(join(folder, name), "utf8"));
      const repo = parsed.repo;
      found.push({
        folder,
        title: parsed.title ?? name.replace(/\.md$/i, ""),
        repo,
        packageUrl: parsed.packageUrl,
        reviewed: parsed.reviewed,
        org: parsed.org,
        flags: parsed.flags,
        key: repo ? remoteKey(repo) : null,
        repoName: repo ? repoNameOf(repo, name) : parsed.title ?? name,
      });
    }
  }
  return found;
}

async function readMirrors(root: string, git: GitRunner): Promise<FoundMirror[]> {
  const found: FoundMirror[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = join(root, entry.name);
    if (!existsSync(join(folder, ".git"))) continue;
    const remote = await git(["remote", "get-url", "origin"], { cwd: folder, timeoutMs: 30_000 });
    const url = remote.code === 0 ? remote.stdout.trim() : "";
    if (!url) continue;
    found.push({ folder, remote: stripUserinfo(url), key: remoteKey(url), repoName: repoNameOf(url, entry.name) });
  }
  return found;
}

async function measure(folder: string, git: GitRunner): Promise<{ version: string | null; commit: string | null }> {
  const described = await git(["describe", "--tags", "--abbrev=0"], { cwd: folder, timeoutMs: 30_000 });
  const head = await git(["rev-parse", "HEAD"], { cwd: folder, timeoutMs: 30_000 });
  const line = described.code === 0 ? described.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "" : "";
  const version = line ? line.replace(/^v(?=\d)/i, "") : null;
  const commit = head.code === 0 ? head.stdout.trim() : null;
  return { version: version || null, commit: commit && /^[0-9a-f]{7,64}$/i.test(commit) ? commit : null };
}

export async function seedCompetitors(options: { dossiers: string; mirrors: string; out: string; today?: string; git?: GitRunner }): Promise<SeedSummary> {
  const dossiers = resolve(options.dossiers);
  const mirrors = resolve(options.mirrors);
  if (!statSync(dossiers, { throwIfNoEntry: false })?.isDirectory()) throw new Error("dossiers folder not found");
  if (!statSync(mirrors, { throwIfNoEntry: false })?.isDirectory()) throw new Error("mirrors folder not found");
  const git = options.git ?? spawnGit;
  const out = resolve(options.out);
  const existing = existsSync(out) ? parseCompetitorsFile(readFileSync(out, "utf8")).entries : [];
  const foundMirrors = await readMirrors(mirrors, git);
  const baselines = new Map<string, { version: string | null; commit: string | null }>();
  for (const mirror of foundMirrors) baselines.set(mirror.folder, await measure(mirror.folder, git));
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const assembled = assembleSeed({ dossiers: readDossiers(dossiers), mirrors: foundMirrors, existing, dossierRoot: dossiers, mirrorRoot: mirrors, today, baselines });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(assembled.file, null, 2)}\n`);
  return { entries: assembled.file.entries.length, matched: assembled.matched, unmatchedMirrors: assembled.unmatchedMirrors, dossiersWithoutMirror: assembled.dossiersWithoutMirror };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (args[0] !== "seed") {
    console.error("usage: node packages/cli/src/competitors.ts seed --dossiers <dir> --mirrors <dir> [--out <path>]");
    process.exitCode = 1;
    return;
  }
  const dossiers = option(args, "--dossiers");
  const mirrors = option(args, "--mirrors");
  if (!dossiers || !mirrors) throw new Error("seed requires --dossiers and --mirrors");
  const summary = await seedCompetitors({ dossiers, mirrors, out: option(args, "--out") ?? join(root, ".scout-data/competitors.json") });
  console.log(`entries: ${summary.entries}`);
  console.log(`matched: ${summary.matched}`);
  console.log(`unmatched mirrors: ${summary.unmatchedMirrors}`);
  console.log(`dossiers with no mirror: ${summary.dossiersWithoutMirror}`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "command failed");
    process.exitCode = 1;
  });
}
