import type { Db } from "./db.ts";
import { compareVersions } from "./version.ts";

/** One shared filter for the catalog view, the updates view, the CLI and the API. Every field is optional and they combine with AND. */
export interface Filter {
  machines?: string[];
  /** Also include installs inside guests of the listed machines (`mini` matches `mini/colima`). Default true. */
  includeGuests?: boolean;
  sources?: string[]; // sourceKind: brew, app, registry, ...
  ecosystems?: string[];
  kinds?: string[]; // package | app | binary | service | image | runtime | vm
  categories?: string[];
  publishers?: string[];
  scopes?: string[];
  descriptionSources?: string[];
  categorySources?: string[];
  /** Free text over name, key, description, publisher (full text) and the install path (substring). */
  text?: string;
  pathPrefix?: string;
  hasDescription?: boolean;
  hasHomepage?: boolean;
  versionKnown?: boolean;
  constrained?: boolean;
  /** Hide dependencies that were never asked for and system components. On by default in the views. */
  hideLibraries?: boolean;
  /** First seen on or after this ISO time. */
  newSince?: string;
  seenBefore?: string;
  seenSince?: string;
  installedBefore?: string;
  /** Usage. `usedWithinDays` and `neverUsed` read `last_used` signals; `unknownUse` means no readable signal exists. */
  usedWithinDays?: number;
  neverUsed?: boolean;
  unknownUse?: boolean;
  running?: boolean;
  autostart?: boolean;
  aiUsed?: boolean;
  /** Presence across machines: `all` (every host that has any install), `one` (exactly one machine), `some`. */
  presence?: "all" | "one" | "some";
  includeRemoved?: boolean;
  sort?: "name" | "path" | "machine" | "source" | "kind" | "ecosystem" | "version" | "category" | "publisher" | "lastUsed" | "firstSeen" | "lastSeen" | "useCount";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  /** ISO time used to evaluate `usedWithinDays`; defaults to now. */
  now?: string;
}

export type CatalogFilter = Omit<Filter, "sort"> & { sort?: Filter["sort"] | "aiUse" };

export interface Row {
  installId: number;
  machineId: string;
  sourceKind: string;
  ecosystem: string;
  key: string;
  name: string;
  kind: string;
  version: string | null;
  location: string;
  category: string | null;
  description: string | null;
  publisher: string | null;
  homepage: string | null;
  firstSeen: string;
  lastSeen: string;
  lastUsed: string | null;
  useCount: number | null;
  aiUse7: number | null;
  aiUse30: number | null;
}

export type FacetDimension = "machine" | "source" | "ecosystem" | "kind" | "category" | "publisher" | "scope" | "descriptionSource";

const FTS_SPECIAL = /[^\p{L}\p{N}_]+/gu;

/** A safe FTS5 prefix query: every word must match a word beginning. Returns null when the text has no usable word. */
export function ftsQuery(text: string): string | null {
  const words = text.split(FTS_SPECIAL).filter((w) => w !== "");
  return words.length === 0 ? null : words.map((w) => `"${w}"*`).join(" ");
}

interface Built {
  where: string[];
  params: (string | number)[];
}

const LAST_USED = `(SELECT MAX(u.value) FROM usage_signals u WHERE u.install_id = i.id AND u.kind IN ('last_used', 'ai_last_used') AND u.available = 1)`;
const USE_COUNT = `(SELECT MAX(CAST(u.value AS INTEGER)) FROM usage_signals u WHERE u.install_id = i.id AND u.kind = 'use_count' AND u.available = 1 AND u.value IS NOT NULL)`;
const AI_USE_7 = `(SELECT MAX(CAST(u.value AS INTEGER)) FROM usage_signals u WHERE u.install_id = i.id AND u.kind = 'ai_use_7d' AND u.available = 1 AND u.value IS NOT NULL)`;
const AI_USE_30 = `(SELECT MAX(CAST(u.value AS INTEGER)) FROM usage_signals u WHERE u.install_id = i.id AND u.kind = 'ai_use_30d' AND u.available = 1 AND u.value IS NOT NULL)`;
const SCOPE = "json_extract(i.details_json, '$.scope')";

function has(filterKind: string, extra = ""): string {
  return `EXISTS (SELECT 1 FROM usage_signals u WHERE u.install_id = i.id AND u.kind = '${filterKind}' AND u.available = 1 ${extra})`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function build(f: CatalogFilter, skip?: FacetDimension): Built {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!f.includeRemoved) where.push("i.removed_at IS NULL");
  if (f.machines?.length && skip !== "machine") {
    const guests = f.includeGuests !== false;
    const clauses = f.machines.map(() => (guests ? "(i.machine_id = ? OR i.machine_id LIKE ?)" : "i.machine_id = ?"));
    where.push(`(${clauses.join(" OR ")})`);
    for (const m of f.machines) {
      params.push(m);
      if (guests) params.push(`${m}/%`);
    }
  }
  if (f.sources?.length && skip !== "source") {
    where.push(`s.kind IN (${placeholders(f.sources.length)})`);
    params.push(...f.sources);
  }
  if (f.ecosystems?.length && skip !== "ecosystem") {
    where.push(`p.ecosystem IN (${placeholders(f.ecosystems.length)})`);
    params.push(...f.ecosystems);
  }
  if (f.kinds?.length && skip !== "kind") {
    where.push(`i.kind IN (${placeholders(f.kinds.length)})`);
    params.push(...f.kinds);
  }
  if (f.categories?.length && skip !== "category") {
    where.push(`p.category IN (${placeholders(f.categories.length)})`);
    params.push(...f.categories);
  }
  for (const [values, dimension, column] of [
    [f.publishers, "publisher", "p.publisher"],
    [f.scopes, "scope", SCOPE],
    [f.descriptionSources, "descriptionSource", "p.description_source"],
    [f.categorySources, "categorySource", "p.category_source"],
  ] as const) {
    if (values?.length && skip !== dimension) {
      where.push(`${column} IN (${placeholders(values.length)})`);
      params.push(...values);
    }
  }
  if (f.text) {
    const q = ftsQuery(f.text);
    const like = `%${f.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    if (q) {
      where.push("(p.id IN (SELECT rowid FROM packages_fts WHERE packages_fts MATCH ?) OR i.location LIKE ? ESCAPE '\\')");
      params.push(q, like);
    } else {
      where.push("i.location LIKE ? ESCAPE '\\'");
      params.push(like);
    }
  }
  if (f.pathPrefix) {
    where.push("substr(i.location, 1, ?) = ?");
    params.push(f.pathPrefix.length, f.pathPrefix);
  }
  if (f.hasDescription !== undefined) where.push(f.hasDescription ? "p.description IS NOT NULL" : "p.description IS NULL");
  if (f.hasHomepage !== undefined) where.push(f.hasHomepage ? "p.homepage IS NOT NULL" : "p.homepage IS NULL");
  if (f.versionKnown !== undefined) where.push(f.versionKnown ? "i.version IS NOT NULL" : "i.version IS NULL");
  if (f.constrained) where.push("EXISTS (SELECT 1 FROM constraints c WHERE c.hard = 1 AND (c.install_id = i.id OR c.package_id = p.id))");
  if (f.hideLibraries) {
    where.push("COALESCE(json_extract(i.details_json, '$.onRequest'), 1) != 0");
    where.push("COALESCE(json_extract(i.details_json, '$.systemComponent'), 0) != 1");
    where.push("(p.category IS NULL OR p.category NOT IN ('library dependency', 'runtime library'))");
  }
  if (f.newSince) {
    where.push("i.first_seen >= ?");
    params.push(f.newSince);
  }
  if (f.seenBefore) { where.push("i.last_seen < ?"); params.push(f.seenBefore); }
  if (f.seenSince) { where.push("i.last_seen >= ?"); params.push(f.seenSince); }
  if (f.installedBefore) { where.push("i.first_seen < ?"); params.push(f.installedBefore); }
  if (f.usedWithinDays !== undefined) {
    const now = f.now ? Date.parse(f.now) : Date.now();
    const cutoff = new Date(now - f.usedWithinDays * 86_400_000).toISOString();
    where.push(`${LAST_USED} >= ?`);
    params.push(cutoff);
  }
  if (f.neverUsed) {
    // Never used means a readable last-used signal source exists and reported nothing; an unreadable source is "unknown".
    where.push(`EXISTS (SELECT 1 FROM usage_signals u WHERE u.install_id = i.id AND u.kind = 'last_used' AND u.available = 1)`);
    where.push(`NOT ${has("last_used", "AND u.value IS NOT NULL")}`);
    where.push(`NOT ${has("ai_last_used", "AND u.value IS NOT NULL")}`);
  }
  if (f.unknownUse) where.push(`NOT EXISTS (SELECT 1 FROM usage_signals u WHERE u.install_id = i.id AND u.available = 1)`);
  if (f.running) where.push(has("running", "AND u.value = '1'"));
  if (f.autostart) where.push(has("autostart", "AND u.value = '1'"));
  if (f.aiUsed) where.push(has("ai_use_30d", "AND CAST(u.value AS INTEGER) > 0"));
  if (f.presence) {
    const machinesWith = `(SELECT COUNT(DISTINCT i2.machine_id) FROM installs i2 JOIN packages p2 ON p2.id = i2.package_id WHERE p2.name = p.name AND i2.removed_at IS NULL)`;
    const hosts = `(SELECT COUNT(*) FROM machines WHERE kind = 'host')`;
    if (f.presence === "one") where.push(`${machinesWith} = 1`);
    else if (f.presence === "all") where.push(`${machinesWith} >= ${hosts}`);
    else where.push(`${machinesWith} > 1 AND ${machinesWith} < ${hosts}`);
  }
  return { where, params };
}

const FROM = `FROM installs i
  JOIN packages p ON p.id = i.package_id
  JOIN sources s ON s.id = i.source_id`;

const ORDER: Record<NonNullable<CatalogFilter["sort"]>, string> = {
  name: "p.name COLLATE NOCASE",
  path: "i.location COLLATE NOCASE",
  machine: "i.machine_id COLLATE NOCASE",
  source: "s.kind COLLATE NOCASE",
  kind: "i.kind COLLATE NOCASE",
  ecosystem: "p.ecosystem COLLATE NOCASE",
  version: "i.version COLLATE NOCASE",
  category: "p.category COLLATE NOCASE",
  publisher: "p.publisher COLLATE NOCASE",
  lastUsed: LAST_USED,
  firstSeen: "i.first_seen",
  lastSeen: "i.last_seen",
  useCount: USE_COUNT,
  aiUse: AI_USE_30,
};

export function queryInstalls(db: Db, f: CatalogFilter = {}): Row[] {
  const { where, params } = build(f);
  const sort = f.sort && Object.hasOwn(ORDER, f.sort) ? f.sort : "name";
  const direction = f.dir ?? (["lastUsed", "firstSeen", "lastSeen", "useCount", "aiUse"].includes(sort) ? "desc" : "asc");
  const order = `${ORDER[sort]} ${direction.toUpperCase()} NULLS LAST, p.name COLLATE NOCASE, i.machine_id COLLATE NOCASE, i.id`;
  const sql = `SELECT i.id AS installId, i.machine_id AS machineId, s.kind AS sourceKind, p.ecosystem, p.key, p.name,
      i.kind, i.version, i.location, p.category, p.description, p.publisher, p.homepage, i.first_seen AS firstSeen,
      i.last_seen AS lastSeen, ${LAST_USED} AS lastUsed, ${USE_COUNT} AS useCount, ${AI_USE_7} AS aiUse7, ${AI_USE_30} AS aiUse30
    ${FROM}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order}${sort === "version" ? "" : " LIMIT ? OFFSET ?"}`;
  if (sort !== "version") return db.prepare(sql).all(...params, f.limit ?? 200, f.offset ?? 0) as unknown as Row[];
  const rows = db.prepare(sql).all(...params) as unknown as Row[];
  rows.sort((a, b) => {
    if (a.version === null || b.version === null) return a.version === b.version ? tie(a, b) : a.version === null ? 1 : -1;
    const order = compareVersions(a.version, b.version) ?? a.version.localeCompare(b.version);
    return order === 0 ? tie(a, b) : direction === "desc" ? -order : order;
  });
  return rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200));
}

function tie(a: Row, b: Row): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.machineId.localeCompare(b.machineId, undefined, { sensitivity: "base" }) || a.installId - b.installId;
}

export function countInstalls(db: Db, f: CatalogFilter = {}): number {
  const { where, params } = build(f);
  const sql = `SELECT COUNT(*) AS n ${FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

const FACET_COLUMN: Record<FacetDimension, string> = {
  machine: "i.machine_id",
  source: "s.kind",
  ecosystem: "p.ecosystem",
  kind: "i.kind",
  category: "COALESCE(p.category, '(none)')",
  publisher: "COALESCE(p.publisher, '(none)')",
  scope: `COALESCE(${SCOPE}, '(none)')`,
  descriptionSource: "COALESCE(p.description_source, '(none)')",
};

/** Counts per value of one dimension under every other active filter, so choosing a value never shows an empty result. */
export function facetCounts(db: Db, f: CatalogFilter, dimension: FacetDimension): { value: string; count: number }[] {
  const { where, params } = build(f, dimension);
  const col = FACET_COLUMN[dimension];
  const sql = `SELECT ${col} AS value, COUNT(*) AS count ${FROM} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY ${col} ORDER BY count DESC, value`;
  return db.prepare(sql).all(...params) as unknown as { value: string; count: number }[];
}
