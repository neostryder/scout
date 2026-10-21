import { createHash } from "node:crypto";
import { applyCompetitorCheck, checkWatch, compareVersions, competitorPaths, competitorRunRecord, failCompetitorRun, maxVersion, queueCompetitorRun, redactUrlSecrets, watchHostAllowed, type CompetitorWatch, type Db, type ResearchDelta } from "@scout/core";
import { versionFromTag } from "./competitor-git.ts";

export type WatchFetcher = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;
export interface WatchCheck { version: string | null; prerelease: string | null; commit: string | null; error: string | null; excerpt: string }

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;
const EXCERPT = 6_000;
// "v2.4.1", "version 2.4", "Version: 3.0.0-beta.2". A site whose pages say it differently sets its own versionPattern.
const DEFAULT_VERSION = String.raw`\bv(?:ersion)?[\s.:]*v?(\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)`;

function plainError(error: unknown, fallback: string): string {
  return redactUrlSecrets(error instanceof Error ? error.message : fallback).replace(/\s+/g, " ").trim().slice(0, 300) || fallback;
}

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'" };

/** Page text without scripts, styles, comments, and tags, so a hash moves when the words move and not when the markup does. */
export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES[entity] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function jsonVersion(text: string, path: string): string | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  for (const part of path.split(".")) {
    if (Array.isArray(value)) value = /^\d+$/.test(part) ? value[Number(part)] : undefined;
    else if (value && typeof value === "object") value = (value as Record<string, unknown>)[part];
    else value = undefined;
  }
  return typeof value === "string" || typeof value === "number" ? versionFromTag(String(value)) : null;
}

export function textVersion(text: string, pattern?: string): string | null {
  let expression: RegExp;
  try { expression = new RegExp(pattern ?? DEFAULT_VERSION, "gi"); } catch { return null; }
  const found: string[] = [];
  for (const match of text.matchAll(expression)) {
    const version = match[1] ? versionFromTag(match[1]) : null;
    if (version) found.push(version);
    if (found.length >= 500) break;
  }
  return maxVersion(found);
}

export function pageToken(text: string): string {
  return `page:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, MAX_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= MAX_BYTES) { await reader.cancel(); break; }
  }
  return (text + decoder.decode()).slice(0, MAX_BYTES);
}

/** Fetches a public https page. A redirect is followed only to another public https address. */
export async function fetchWatchSource(url: string, fetcher: WatchFetcher = fetch as unknown as WatchFetcher): Promise<{ text: string } | { error: string }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let target = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    if (!URL.canParse(target)) return { error: "the watch address is not a web address" };
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || !watchHostAllowed(parsed.hostname)) return { error: "the watch address is not a public https address" };
    let response: Response;
    try {
      response = await fetcher(parsed.toString(), { signal, redirect: "manual", headers: { "user-agent": "Scout competitor watch", accept: "application/json, text/html, text/plain;q=0.8" } });
    } catch (error) {
      return { error: plainError(error, "the watch address could not be reached") };
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next || !URL.canParse(next, parsed)) return { error: "the watch address redirected without a usable location" };
      target = new URL(next, parsed).toString();
      continue;
    }
    if (!response.ok) return { error: `the watch address answered ${response.status}` };
    try { return { text: await readCapped(response) }; } catch (error) { return { error: plainError(error, "the watch address could not be read") }; }
  }
  return { error: "the watch address redirected too many times" };
}

/** Reads the watched source once. A `json` or `page` watch reports a version; a `hash` watch reports a page token in the commit slot. */
export async function checkWatchSource(watch: CompetitorWatch, fetcher?: WatchFetcher): Promise<WatchCheck> {
  const checked = checkWatch(watch);
  if (!checked.ok) return { version: null, prerelease: null, commit: null, error: checked.error, excerpt: "" };
  const fetched = await fetchWatchSource(checked.watch.url, fetcher);
  if ("error" in fetched) return { version: null, prerelease: null, commit: null, error: fetched.error, excerpt: "" };
  if (checked.watch.kind === "json") {
    const version = jsonVersion(fetched.text, checked.watch.versionPath ?? "");
    return { version, prerelease: null, commit: null, error: version ? null : "no version at the watched path", excerpt: fetched.text.slice(0, EXCERPT) };
  }
  const text = pageText(fetched.text);
  if (checked.watch.kind === "page") {
    const version = textVersion(text, checked.watch.versionPattern);
    return { version, prerelease: null, commit: null, error: version ? null : "no version found on the page", excerpt: text.slice(0, EXCERPT) };
  }
  if (text === "") return { version: null, prerelease: null, commit: null, error: "the watched page has no text", excerpt: "" };
  return { version: null, prerelease: null, commit: pageToken(text), error: null, excerpt: text.slice(0, EXCERPT) };
}

/** The shape the schedule's check expects. */
export async function checkWatchForSchedule(watch: CompetitorWatch, fetcher?: WatchFetcher): Promise<{ version: string | null; prerelease: string | null; commit: string | null; error: string | null }> {
  const { version, prerelease, commit, error } = await checkWatchSource(watch, fetcher);
  return { version, prerelease, commit, error };
}

export async function researchForWatch(db: Db, id: string, options: { now: string; fetcher?: WatchFetcher }): Promise<{ request: Record<string, unknown>; delta: ResearchDelta; toVersion: string | null; toCommit: string | null } | { error: string }> {
  const paths = competitorPaths(db, id);
  if (!paths?.watch) return { error: "competitor has no watch source" };
  const seen = await checkWatchSource(paths.watch, options.fetcher);
  if (seen.error !== null) return { error: seen.error };
  const watch = paths.watch;
  const competitor = { id, name: paths.name, org: paths.org, packageUrl: paths.packageUrl, remoteUrl: null, flags: paths.flags };
  const request = {
    competitor,
    from: { version: paths.baselineVersion, commit: paths.baselineCommit },
    to: { version: seen.version, commit: seen.commit },
    mirrorPath: null,
    dossierDir: paths.dossierDir,
    watch: { kind: watch.kind, url: watch.url, ...(watch.versionPath ? { versionPath: watch.versionPath } : {}), ...(watch.versionPattern ? { versionPattern: watch.versionPattern } : {}) },
    commitCount: 0,
    commits: [],
    changedFiles: [],
    notes: seen.excerpt,
    pricingFiles: [],
    analysis: { source: "watch", note: "No repository to diff. The watched source reported the version or page change.", flags: { reaRecommended: false } },
  };
  const newer = paths.baselineVersion !== null && seen.version !== null && compareVersions(seen.version, paths.baselineVersion) === 1;
  const delta: ResearchDelta = {
    commits: 0,
    sourceFilesChanged: 0,
    newStableTag: newer,
    docsOnly: false,
    dependencyBumpOnly: false,
    lastCommitAt: null,
    pageChanged: !newer && watch.kind === "hash" && seen.commit !== null && paths.baselineCommit !== null && seen.commit !== paths.baselineCommit,
  };
  return { request, delta, toVersion: seen.version, toCommit: seen.commit };
}

/** The Update button for a competitor with a watch source: read the source now, record it, and queue research. */
export async function runWatchUpdate(db: Db, runId: number, options: { now: string; fetcher?: WatchFetcher }): Promise<void> {
  const record = competitorRunRecord(db, runId, options.now);
  if (!record || record.state !== "pulling") return;
  try {
    const prepared = await researchForWatch(db, record.competitorId, options);
    if ("error" in prepared) {
      failCompetitorRun(db, runId, prepared.error, options.now);
      return;
    }
    applyCompetitorCheck(db, record.competitorId, { version: prepared.toVersion, prerelease: null, commit: prepared.toCommit, error: null }, options.now);
    queueCompetitorRun(db, runId, { toVersion: prepared.toVersion, toCommit: prepared.toCommit, request: prepared.request }, options.now);
  } catch (error) {
    try { failCompetitorRun(db, runId, plainError(error, "update failed"), options.now); } catch { /* the run already left the active states */ }
  }
}
