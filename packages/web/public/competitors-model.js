// Pure helpers for the Competitors view: order, filters, and the words for each status and run state.

export const NOT_CONFIGURED = "Competitor watch is not set up. Run the seed command described in the setup guide.";
export const UPDATE_CONFIRM = "Pull the local mirror and queue a research request. Nothing is installed and no research runs until a Claude session picks it up.";
export const NO_MIRROR = "No local mirror";

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
  if (!baseline?.version) return "not analyzed";
  return baseline.at ? `${baseline.version}, ${baseline.at}` : baseline.version;
}

export function baselineSource(baseline) {
  return baseline?.source === "mirror" || baseline?.source === "analysis" ? baseline.source : "none";
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

/** Hidden while a run is still active. Disabled, with a reason, when there is no mirror. */
export function updateAction(row) {
  if (row?.run && ACTIVE.has(row.run.state)) return { kind: "hidden" };
  if (!row?.mirrorPresent) return { kind: "disabled", reason: NO_MIRROR };
  return { kind: "ready" };
}
