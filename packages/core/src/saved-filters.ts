import type { Db } from "./db.ts";

export type FilterView = "catalog" | "updates";
export interface SavedFilter { name: string; view: FilterView; spec: Record<string, string> }

export const SAVED_FILTER_PARAMS: Record<FilterView, readonly string[]> = {
  catalog: ["machine", "source", "ecosystem", "kind", "category", "publisher", "scope", "descriptionSource", "categorySource", "q", "path", "hasDescription", "hasHomepage", "versionKnown", "constrained", "libs", "newSince", "seenBefore", "seenSince", "installedBefore", "usedWithinDays", "neverUsed", "unknownUse", "running", "autostart", "ai", "presence", "sort", "dir"],
  updates: ["q", "machine", "ecosystem", "source", "category", "publisher", "status", "bump", "hasBeta", "hasUpstream", "usedWithinDays", "neverUsed", "unknownUse", "running", "safe", "sort", "dir"],
};

export function filterView(value: unknown): FilterView {
  if (value !== "catalog" && value !== "updates") throw new Error("view must be catalog or updates");
  return value;
}

export function filterName(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("filter name must be text without control characters");
  const name = value.trim();
  if (name.length < 1 || name.length > 60) throw new Error("filter name must have 1 to 60 characters");
  return name;
}

function filterParams(view: FilterView, value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("params must be an object");
  const params: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!SAVED_FILTER_PARAMS[view].includes(key)) continue;
    if (typeof val !== "string" || val.length > 500) throw new Error("filter values must be text with at most 500 characters");
    params[key] = val;
  }
  return params;
}

// A control separator keeps view keys distinct from every valid legacy name without changing the table.
const storageKey = (view: FilterView, name: string): string => `${view}\u0000${name}`;

function storedFilters(db: Db): (SavedFilter & { key: string })[] {
  return (db.prepare("SELECT name, spec_json FROM saved_filters ORDER BY name").all() as { name: string; spec_json: string }[]).map((row) => {
    const value = JSON.parse(row.spec_json) as Record<string, unknown>;
    const wrapped = Object.hasOwn(value, "view") && Object.hasOwn(value, "params");
    const view = wrapped ? filterView(value.view) : "catalog";
    const prefix = `${view}\u0000`;
    const name = row.name.startsWith(prefix) ? row.name.slice(prefix.length) : row.name;
    return { key: row.name, name, view, spec: filterParams(view, wrapped ? value.params : value) };
  });
}

export function listSavedFilters(db: Db): SavedFilter[] {
  return storedFilters(db).map(({ name, view, spec }) => ({ name, view, spec })).sort((a, b) => a.name.localeCompare(b.name) || a.view.localeCompare(b.view));
}

export function saveFilter(db: Db, input: { name: string; view: FilterView; spec: Record<string, string> }): SavedFilter {
  const name = filterName(input.name);
  const view = filterView(input.view);
  const spec = filterParams(view, input.spec);
  const rows = storedFilters(db);
  const existing = rows.find((row) => row.view === view && row.name === name);
  if (!existing && rows.length >= 100) throw new Error("at most 100 filters can be saved");
  db.prepare("INSERT INTO saved_filters (name, spec_json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET spec_json = excluded.spec_json").run(existing?.key ?? storageKey(view, name), JSON.stringify({ view, params: spec }));
  return { name, view, spec };
}

export function renameFilter(db: Db, from: string, to: string, view: FilterView = "catalog"): SavedFilter {
  from = filterName(from); to = filterName(to); view = filterView(view);
  const rows = storedFilters(db);
  const existing = rows.find((row) => row.view === view && row.name === from);
  if (!existing) throw new Error("filter was not found");
  if (from !== to && rows.some((row) => row.view === view && row.name === to)) throw new Error("a filter with that name already exists");
  // A renamed legacy row gains its envelope so its view remains explicit.
  db.prepare("UPDATE saved_filters SET name = ?, spec_json = ? WHERE name = ?").run(storageKey(view, to), JSON.stringify({ view, params: existing.spec }), existing.key);
  return { name: to, view, spec: existing.spec };
}

export function deleteFilter(db: Db, name: string, view: FilterView = "catalog"): void {
  name = filterName(name); view = filterView(view);
  const existing = storedFilters(db).find((row) => row.view === view && row.name === name);
  if (!existing) throw new Error("filter was not found");
  db.prepare("DELETE FROM saved_filters WHERE name = ?").run(existing.key);
}
