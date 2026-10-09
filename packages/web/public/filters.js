export const FILTER_PARAMS = {
  catalog: ["machine", "source", "ecosystem", "kind", "category", "publisher", "scope", "descriptionSource", "categorySource", "q", "path", "hasDescription", "hasHomepage", "versionKnown", "constrained", "libs", "newSince", "seenBefore", "seenSince", "installedBefore", "usedWithinDays", "neverUsed", "unknownUse", "running", "autostart", "ai", "presence", "sort", "dir"],
  updates: ["q", "machine", "ecosystem", "source", "category", "publisher", "status", "bump", "hasBeta", "hasUpstream", "usedWithinDays", "neverUsed", "unknownUse", "running", "safe", "sort", "dir"],
};

export function filterName(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("Filter names cannot contain control characters.");
  const name = value.trim();
  if (name.length < 1 || name.length > 60) throw new Error("Filter names must have 1 to 60 characters.");
  return name;
}

export function filterQuery(view, query) {
  return Object.fromEntries(FILTER_PARAMS[view].filter((key) => query.has(key)).map((key) => [key, query.get(key)]));
}

export function matchesFilter(filter, view, query) {
  if (filter.view !== view) return false;
  const params = filterQuery(view, query);
  const keys = Object.keys(filter.spec);
  return keys.length === Object.keys(params).length && keys.every((key) => Object.hasOwn(params, key) && params[key] === filter.spec[key]);
}
