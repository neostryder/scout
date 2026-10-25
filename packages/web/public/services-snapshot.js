// The last Services map the page drew, kept in the browser so a cold start paints it at once while the hub answers.
// The snapshot is only a first paint: a live read replaces it as soon as the overview arrives.

export const SNAPSHOT_KEY = "scout.services.snapshot";
export const SNAPSHOT_ROUTES = ["overview", "descriptionOverview", "edgeOverview", "routes", "atlas"];
export const SNAPSHOT_SAVE_EVERY_MS = 60_000;
const VERSION = 1;
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_CHARS = 1_500_000;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The text to store, or null when the reads are incomplete or too large for the browser's storage. */
export function packSnapshot(raw, now) {
  if (!raw || !Array.isArray(raw.overview?.machines) || !Array.isArray(raw.routes?.rows) || !Array.isArray(raw.atlas?.rows) || !object(raw.edgeOverview)) return null;
  const text = JSON.stringify({ version: VERSION, at: new Date(now).toISOString(), overview: raw.overview, descriptionOverview: raw.descriptionOverview ?? null, edgeOverview: raw.edgeOverview, routes: raw.routes, atlas: raw.atlas });
  return text.length > MAX_CHARS ? null : text;
}

/** The saved reads, or null when there is none, it is corrupt, it is from another version, or it is a week old. */
export function unpackSnapshot(text, now) {
  if (typeof text !== "string" || text === "") return null;
  let saved;
  try { saved = JSON.parse(text); } catch { return null; }
  if (!object(saved) || saved.version !== VERSION) return null;
  const at = Date.parse(saved.at);
  if (!Number.isFinite(at) || now - at > MAX_AGE_MS || at - now > 300_000) return null;
  if (!object(saved.overview) || !Array.isArray(saved.overview.machines) || !object(saved.routes) || !Array.isArray(saved.routes.rows) || !object(saved.atlas) || !Array.isArray(saved.atlas.rows) || !object(saved.edgeOverview)) return null;
  if (!saved.overview.machines.every((machine) => object(machine) && typeof machine.id === "string" && object(machine.services) && object(machine.listeners) && object(machine.live))) return null;
  return { at: saved.at, overview: saved.overview, descriptionOverview: object(saved.descriptionOverview) ? saved.descriptionOverview : null, edgeOverview: saved.edgeOverview, routes: saved.routes, atlas: saved.atlas };
}

/** The line shown beside the counts while the saved view is on screen. */
export function snapshotNote(at, now) {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  const age = minutes < 1 ? "less than a minute" : minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return `saved view from ${age} ago, refreshing`;
}
