// Pure helpers for the Competitors view: order, filters, and the words for each status and run state.

export const NOT_CONFIGURED = "Competitor watch is not set up. Run the seed command described in the setup guide.";
export const UPDATE_CONFIRM = "Pull the mirror and queue research now, ignoring the usual wait. Nothing is installed and no research runs until a Claude session picks it up.";
export const NO_MIRROR = "No local mirror";
export const WATCH_UPDATE_CONFIRM = "Read the watched page now and queue research. Nothing is installed and no research runs until a Claude session picks it up.";

export const GATE_FIELDS = [
  { key: "enabled", label: "Queue research automatically", kind: "flag", help: "When this is off, nothing is queued on its own. The Update button still queues research." },
  { key: "minCommits", label: "Commits needed", kind: "number", min: 0, help: "New commits since the last analysis needed to queue research." },
  { key: "minSourceFilesChanged", label: "Source files needed", kind: "number", min: 0, help: "Changed source files that queue research when there are fewer commits than needed." },
  { key: "onNewTag", label: "Queue on a new release", kind: "flag", help: "A new stable tag or version queues research right away." },
  { key: "quietHours", label: "Wait after the last commit", kind: "number", min: 0, help: "Hours since the newest commit before research queues, so a push still in progress is not researched." },
  { key: "ignoreDocsOnly", label: "Ignore docs-only changes", kind: "flag", help: "Changes that touch only documentation never queue research." },
  { key: "ignoreDependencyBumpOnly", label: "Ignore dependency bumps", kind: "flag", help: "Changes that only bump dependencies never queue research." },
  { key: "maxQueued", label: "Queue limit", kind: "number", min: 1, help: "New research waits while this many runs are queued or in progress." },
];

export const WATCH_KINDS = [
  { value: "json", label: "JSON version feed", help: "A URL that returns JSON. Give the dotted path to the version, such as latest.version." },
  { value: "page", label: "Page with a version number", help: "A page that shows the current version. Give a pattern with one capture group, or leave it empty to read the highest version on the page." },
  { value: "hash", label: "Page, any change", help: "The competitor is marked New when the page text changes. A page with dates, counters, or rotating banners reports changes that are not releases." },
];

const STATUS_RANK = { new: 0, current: 1, unknown: 2 };
const ACTIVE = new Set(["pulling", "queued", "claimed"]);

function nameKey(row) { return String(row?.name || "").toLowerCase(); }

/** New rows first, then name. A copy, so the caller's list stays as it arrived. */
export function sortCompetitors(rows) {
  return [...(rows || [])].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (nameKey(a) < nameKey(b) ? -1 : nameKey(a) > nameKey(b) ? 1 : 0));
}

/** Name and organization, every word of the query, and optionally only rows with a new version. */
export function filterCompetitors(rows, { query = "", newOnly = false } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return (rows || []).filter((row) => {
    if (newOnly && row.status !== "new") return false;
    if (!terms.length) return true;
    const hay = `${row.name || ""} ${row.org || ""}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

export function defaultNewOnly(rows) { return (rows || []).some((row) => row.status === "new"); }

export function countLine(rows) {
  const list = rows || [];
  const fresh = list.filter((row) => row.status === "new").length;
  return `${fresh} of ${list.length} have a new version`;
}

export function statusText(row) {
  if (row?.status === "new") return "New version";
  if (row?.status === "current") return "Up to date";
  return "Not checked";
}

/** The list has no commit count, so a commits-basis row says "New commits" beside the chip. */
export function commitsText(row) { return row?.status === "new" && row?.newBasis === "commits" ? "New commits" : ""; }

export function runText(run) {
  if (!run) return "None";
  if (run.stale) return "Stale, queued over 14 days ago";
  if (run.state === "pulling") return "Pulling";
  if (run.state === "queued") return "Research queued";
  if (run.state === "claimed") return run.claimedBy ? `Research in progress (claimed by ${run.claimedBy})` : "Research in progress";
  if (run.state === "done") return "Done";
  if (run.state === "failed") return run.error ? `Failed: ${run.error}` : "Failed";
  return "None";
}

export function analyzedText(baseline) {
  if (!baseline?.version) return baseline?.source === "watch" && baseline.at ? `page seen ${String(baseline.at).slice(0, 10)}` : "not analyzed";
  return baseline.at ? `${baseline.version}, ${baseline.at}` : baseline.version;
}

export function baselineSource(baseline) {
  return baseline?.source === "mirror" || baseline?.source === "analysis" || baseline?.source === "watch" ? baseline.source : "none";
}

export function latestParts(latest) {
  const version = latest?.version || "";
  const prerelease = latest?.prerelease && latest.prerelease !== version ? latest.prerelease : "";
  return { version, prerelease, error: latest?.error || "" };
}

export function checkedText(checkedAt) {
  if (!checkedAt) return "No check yet";
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(checkedAt));
  return match ? `Last check ${match[1]} ${match[2]}` : `Last check ${checkedAt}`;
}

function relativeTime(at, now) {
  const age = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(age) || age < 45_000) return "just now";
  if (age < 3_600_000) {
    const minutes = Math.max(1, Math.floor(age / 60_000));
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (age < 48 * 3_600_000) {
    const hours = Math.floor(age / 3_600_000);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.max(1, Math.floor(age / 86_400_000));
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The sync line is words, including the error, so the row does not rely on color. */
export function syncedText(sync, now) {
  const at = sync && sync.at ? String(sync.at) : "";
  const error = sync && sync.error ? String(sync.error) : "";
  if (!at && !error) return "Mirror not synced yet";
  const line = at ? `Mirror synced ${relativeTime(at, now)}` : "Mirror sync failed";
  return error ? `${line}. ${error}` : line;
}

export function pendingText(pending) {
  if (!pending) return "";
  if (/page changed/.test(String(pending.reason || ""))) return "Waiting: the page changed and shows no new version";
  return `Waiting: ${pending.commits} commits below the threshold`;
}

export function triggerText(run) {
  if (run && run.trigger === "auto") return "Auto-queued";
  if (run && run.trigger === "manual") return "Manual";
  return "";
}

/** Hidden while a run is still active. Disabled, with a reason, when there is no mirror. */
export function updateAction(row) {
  if (row?.run && ACTIVE.has(row.run.state)) return { kind: "hidden" };
  if (!row?.mirrorPresent && !row?.watch) return { kind: "disabled", reason: NO_MIRROR };
  return { kind: "ready" };
}

/** A watched row has no repository, so the sync line and the confirmation talk about the page instead. */
export function isWatched(row) { return Boolean(row?.watch) && !row?.mirrorPresent; }

export function watchText(watch) {
  const kind = WATCH_KINDS.find((item) => item.value === watch?.kind);
  return kind ? `Watching: ${kind.label}` : "";
}

/** Only the fields the entered text differs on: a changed value is set, an emptied field returns to the default. */
export function gateChange(current, entered) {
  const set = {};
  const clear = [];
  for (const field of GATE_FIELDS) {
    const text = entered[field.key];
    const had = Object.hasOwn(current || {}, field.key);
    if (text === "" || text === undefined || text === null) { if (had) clear.push(field.key); continue; }
    const value = field.kind === "flag" ? text === "true" : Number(text);
    if (field.kind === "number" && (!Number.isInteger(value) || value < field.min)) throw new Error(`${field.label} must be a whole number of ${field.min} or more.`);
    if (!had || current[field.key] !== value) set[field.key] = value;
  }
  return { set, clear };
}

/** The object the hub stores for a watch, or an error sentence for the form. */
export function watchFromForm({ kind, url, versionPath, versionPattern }) {
  const address = String(url || "").trim();
  if (!WATCH_KINDS.some((item) => item.value === kind)) throw new Error("Choose what to watch for.");
  if (!address) throw new Error("Enter the address to watch.");
  const watch = { kind, url: address };
  if (kind === "json") {
    const path = String(versionPath || "").trim();
    if (!path) throw new Error("Enter the path to the version, such as latest.version.");
    watch.versionPath = path;
  }
  if (kind === "page" && String(versionPattern || "").trim()) watch.versionPattern = String(versionPattern).trim();
  return watch;
}

export const REMOVE_CONFIRM = "Remove this competitor from the list. Its research folder and any cloned repository stay on disk.";

/** The repository form to what the hub takes. A starting commit is optional and, when given, must be the full 40-character hash. */
export function repoFromForm({ remoteUrl, folder, commit, version }) {
  const address = String(remoteUrl || "").trim();
  if (!address) throw new Error("Enter the repository address.");
  const repo = { remoteUrl: address };
  const name = String(folder || "").trim();
  if (name) repo.folder = name;
  const hash = String(commit || "").trim().toLowerCase();
  if (hash) {
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error("A starting commit must be the full 40-character hash.");
    const label = String(version || "").trim();
    repo.baseline = { commit: hash, ...(label ? { version: label } : {}) };
  }
  return repo;
}

export const TRACK_CONFIRM = "Add this project to the competitor list and read its newest version now, so later checks can tell what is new. Nothing is installed.";

/** The sentence under the panel title: when the last search ran, what it found, and why it stopped early if it did. */
export function discoveryText(discovery) {
  if (!discovery) return "";
  if (discovery.running) return "Looking for new competitors now.";
  if (discovery.lastError && !discovery.lastResult) return `The last search did not run: ${discovery.lastError}`;
  if (!discovery.lastRunAt) return "No search has run yet. The first one runs on its own, or use Look for new ones.";
  const when = String(discovery.lastRunAt).replace("T", " ").slice(0, 16);
  const result = discovery.lastResult;
  const found = result ? `, read ${result.gathered}, offered ${result.offered}` : "";
  return `Last search ${when}${found}.${discovery.lastError ? ` It stopped early: ${discovery.lastError}` : ""}`;
}

/** One line of facts about a candidate: its owner, popularity, and how recently it changed. */
export function candidateFacts(candidate) {
  const parts = [];
  if (candidate?.org) parts.push(candidate.org);
  if (Number.isFinite(candidate?.stars)) parts.push(`${candidate.stars} ${candidate.stars === 1 ? "star" : "stars"}`);
  if (candidate?.pushedAt) parts.push(`updated ${String(candidate.pushedAt).slice(0, 10)}`);
  return parts.join(", ");
}

/** What the project is, in the judge's words when it has any, else the project's own description. */
export function candidateSummary(candidate) {
  return String(candidate?.judgement?.summary || candidate?.description || "").trim();
}

/** The products of ours that a candidate overlaps, or an empty string. */
export function overlapText(candidate) {
  const overlaps = Array.isArray(candidate?.judgement?.overlaps) ? candidate.judgement.overlaps.filter(Boolean) : [];
  return overlaps.length ? `Overlaps ${overlaps.join(", ")}` : "";
}

/** Strongest first, then name. A copy. */
export function sortCandidates(candidates) {
  return [...(candidates || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
}
