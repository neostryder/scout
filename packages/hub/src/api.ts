import type { CatalogFilter, Db, FacetDimension } from "@scout/core";
import { emptyProvenance, installFlags, type Flag, type ProvenanceContext } from "@scout/core";
import { changelogSummaryFor, countInstalls, decideProposal, dependentsOf, facetCounts, needsOf, openProposals, queryInstalls, queryUpdates, supportWindowsOf, updatesView, type UpdateBump, type UpdateSort, type UpdateStatus } from "@scout/core";
import { confirmDependencyProposal, rejectDependencyProposal, type DependencyProposalSubject } from "@scout/core";

// The read API. Every route reads the catalog and never scans. Filters arrive as query parameters and become the
// shared Filter, so the page, the CLI and this API cannot disagree about what a filter means.

const list = (v: string | null): string[] | undefined => {
  const items = v?.split(",").map((s) => s.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
};

export function filterFromQuery(q: URLSearchParams): CatalogFilter {
  const f: CatalogFilter = {};
  const set = <K extends keyof CatalogFilter>(k: K, v: CatalogFilter[K] | undefined): void => {
    if (v !== undefined) f[k] = v;
  };
  set("machines", list(q.get("machine")));
  set("sources", list(q.get("source")));
  set("ecosystems", list(q.get("ecosystem")));
  set("kinds", list(q.get("kind")));
  set("categories", list(q.get("category")));
  set("publishers", list(q.get("publisher")));
  set("scopes", list(q.get("scope"))?.filter((s) => s === "user" || s === "machine"));
  set("descriptionSources", list(q.get("descriptionSource")));
  set("categorySources", list(q.get("categorySource")));
  const text = q.get("q")?.trim();
  if (text) f.text = text;
  const path = q.get("path")?.trim();
  if (path) f.pathPrefix = path;
  if (q.get("hasDescription") === "1") f.hasDescription = true;
  if (q.get("hasDescription") === "0") f.hasDescription = false;
  if (q.get("hasHomepage") === "1") f.hasHomepage = true;
  if (q.get("hasHomepage") === "0") f.hasHomepage = false;
  if (q.get("versionKnown") === "1") f.versionKnown = true;
  if (q.get("versionKnown") === "0") f.versionKnown = false;
  if (q.get("constrained") === "1") f.constrained = true;
  if (q.get("libs") !== "1") f.hideLibraries = true; // dependencies and system components are hidden unless asked for
  const since = q.get("newSince");
  if (since && !Number.isNaN(Date.parse(since))) f.newSince = since;
  for (const [parameter, field] of [["seenBefore", "seenBefore"], ["seenSince", "seenSince"], ["installedBefore", "installedBefore"]] as const) {
    const value = q.get(parameter);
    if (value && !Number.isNaN(Date.parse(value))) f[field] = new Date(value).toISOString();
  }
  const days = Number(q.get("usedWithinDays"));
  if (q.get("usedWithinDays") && Number.isFinite(days) && days > 0) f.usedWithinDays = days;
  if (q.get("neverUsed") === "1") f.neverUsed = true;
  if (q.get("unknownUse") === "1") f.unknownUse = true;
  if (q.get("running") === "1") f.running = true;
  if (q.get("autostart") === "1") f.autostart = true;
  if (q.get("ai") === "1" || q.get("aiUsed") === "1") f.aiUsed = true;
  const presence = q.get("presence");
  if (presence === "one" || presence === "all" || presence === "some") f.presence = presence;
  const sort = q.get("sort");
  if (sort === "name" || sort === "path" || sort === "machine" || sort === "source" || sort === "kind" || sort === "ecosystem" || sort === "version" || sort === "category" || sort === "publisher" || sort === "lastUsed" || sort === "firstSeen" || sort === "lastSeen" || sort === "useCount" || sort === "aiUse") f.sort = sort;
  if (q.get("dir") === "asc" || q.get("dir") === "desc") f.dir = q.get("dir") as "asc" | "desc";
  const limit = Number(q.get("limit"));
  const offset = Number(q.get("offset"));
  f.limit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100;
  f.offset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  return f;
}

const FACETS: FacetDimension[] = ["machine", "source", "kind", "category", "ecosystem", "publisher", "scope", "descriptionSource"];

/** Flags for one install. The stored details matter only for Windows uninstall entries and Store packages, so they are parsed for those alone. */
function flagsOf(row: { machineId: string; ecosystem: string; location: string; publisher: string | null; homepage: string | null }, details: unknown, context: ProvenanceContext): Flag[] {
  return installFlags({ ...row, details: details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : null }, context);
}

export function installsResponse(db: Db, q: URLSearchParams, context: ProvenanceContext = emptyProvenance()): unknown {
  const filter = filterFromQuery(q);
  const rows = queryInstalls(db, filter);
  const needDetails = rows.filter((row) => row.ecosystem === "arp" || row.ecosystem === "appx").map((row) => row.installId);
  const stored = new Map<number, unknown>();
  if (needDetails.length) for (const found of db.prepare(`SELECT id, details_json AS details FROM installs WHERE id IN (${needDetails.map(() => "?").join(",")})`).all(...needDetails) as { id: number; details: string }[]) {
    try { stored.set(found.id, JSON.parse(found.details)); } catch { /* A malformed details column simply yields no detail-based flag. */ }
  }
  return {
    total: countInstalls(db, filter),
    rows: rows.map((row) => ({ ...row, flags: flagsOf(row, stored.get(row.installId), context) })),
    facets: Object.fromEntries(FACETS.map((d) => [d, facetCounts(db, filter, d)])),
  };
}

export function updatesResponse(db: Db, q: URLSearchParams): unknown {
  const sorts: UpdateSort[] = ["name", "machine", "ecosystem", "source", "installed", "available", "status", "bump", "checked", "lastUsed", "category", "publisher", "firstSeen", "priority"];
  const statuses: UpdateStatus[] = ["updatable", "blocked", "upstream", "advisory", "current"];
  const bumps: UpdateBump[] = ["major", "minor", "patch", "other"];
  const valid = <T extends string>(values: string[] | undefined, allowed: T[]): T[] | undefined => values?.filter((v): v is T => allowed.includes(v as T));
  const sort = q.get("sort");
  const status = q.has("status") ? valid(list(q.get("status")), statuses) ?? [] : undefined;
  const defaultStatus = status === undefined || status.length === 4 && ["updatable", "blocked", "upstream", "advisory"].every((value) => status.includes(value as UpdateStatus));
  const dir = q.get("dir");
  const days = Number(q.get("usedWithinDays"));
  const limit = Number(q.get("limit"));
  const offset = Number(q.get("offset"));
  return queryUpdates(db, {
    safe: q.get("safe") === "1",
    q: q.get("q")?.trim(),
    machine: list(q.get("machine")), ecosystem: list(q.get("ecosystem")), source: list(q.get("source")),
    category: list(q.get("category")), publisher: list(q.get("publisher")),
    status,
    bump: q.has("bump") ? valid(list(q.get("bump")), bumps) ?? [] : undefined,
    hasBeta: q.get("hasBeta") === "1", hasUpstream: q.get("hasUpstream") === "1",
    usedWithinDays: q.get("usedWithinDays") && Number.isFinite(days) && days > 0 ? days : undefined,
    neverUsed: q.get("neverUsed") === "1", unknownUse: q.get("unknownUse") === "1", running: q.get("running") === "1",
    sort: sorts.includes(sort as UpdateSort) ? sort as UpdateSort : sort === null && defaultStatus ? "priority" : undefined,
    dir: dir === "asc" || dir === "desc" ? dir : undefined,
    limit: q.has("limit") && Number.isFinite(limit) ? limit : 200,
    offset: q.has("offset") && Number.isFinite(offset) ? offset : 0,
  });
}

export function summaryResponse(db: Db): unknown {
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    machines: db.prepare("SELECT id, name, os, kind, parent_id AS parentId, state, last_scan AS lastScan FROM machines ORDER BY kind, id").all(),
    installs: n("SELECT COUNT(*) AS n FROM installs WHERE removed_at IS NULL"),
    items: n("SELECT COUNT(*) AS n FROM items"),
    packages: n("SELECT COUNT(*) AS n FROM packages"),
    described: n("SELECT COUNT(*) AS n FROM packages WHERE description IS NOT NULL"),
    updatable: queryUpdates(db).updatable,
    openProposals: n("SELECT COUNT(*) AS n FROM findings WHERE kind IN ('merge_proposal', 'dependency_proposal') AND state = 'open'"),
  };
}

export function coverageResponse(db: Db): unknown {
  return db
    .prepare(
      `SELECT c.machine_id AS machineId, c.source_kind AS source, c.location, c.ran_at AS ranAt, c.status, c.found, c.message FROM coverage c
       WHERE c.id = (SELECT MAX(id) FROM coverage WHERE machine_id = c.machine_id AND source_kind = c.source_kind AND location = c.location)
       ORDER BY c.machine_id, c.source_kind, c.location`,
    )
    .all();
}

export function installDetail(db: Db, id: number, context: ProvenanceContext = emptyProvenance()): unknown | null {
  const row = db
    .prepare(
      `SELECT i.id, i.machine_id AS machineId, s.kind AS sourceKind, s.location AS sourceRoot, p.id AS packageId, p.ecosystem, p.key, p.name,
              p.publisher, p.homepage, p.category, p.category_source AS categorySource, p.description, p.description_source AS descriptionSource,
              p.description_confidence AS descriptionConfidence, i.kind, i.version, i.digest, i.location, i.details_json AS details,
              i.first_seen AS firstSeen, i.last_seen AS lastSeen
       FROM installs i JOIN packages p ON p.id = i.package_id JOIN sources s ON s.id = i.source_id WHERE i.id = ?`,
    )
    .get(id) as (Record<string, unknown> & { details: string; packageId: number }) | undefined;
  if (!row) return null;
  const usage = db
    .prepare("SELECT kind, value, available, origin, observed_at AS observedAt FROM usage_signals WHERE install_id = ? ORDER BY kind, origin")
    .all(id);
  const constraints = db
    .prepare("SELECT type, hard, spec, origin FROM constraints WHERE install_id = ? OR package_id = ?")
    .all(id, row.packageId);
  const relations = db
    .prepare(
      `SELECT r.relation, r.rule, 'out' AS direction, j.id AS otherId, q.name AS otherName, q.ecosystem AS otherEcosystem FROM install_relations r
         JOIN installs j ON j.id = r.related_id JOIN packages q ON q.id = j.package_id WHERE r.install_id = ?
       UNION ALL
       SELECT r.relation, r.rule, 'in', j.id, q.name, q.ecosystem FROM install_relations r
         JOIN installs j ON j.id = r.install_id JOIN packages q ON q.id = j.package_id WHERE r.related_id = ?`,
    )
    .all(id, id);
  // The same software elsewhere: every install whose package shares this package's item.
  const sameSoftware = db
    .prepare(
      `SELECT i2.id, i2.machine_id AS machineId, p2.ecosystem, p2.name, i2.version, i2.location FROM item_links l
         JOIN item_links l2 ON l2.item_id = l.item_id JOIN packages p2 ON p2.id = l2.package_id
         JOIN installs i2 ON i2.package_id = p2.id AND i2.removed_at IS NULL
       WHERE l.package_id = ? AND i2.id != ? ORDER BY i2.machine_id, p2.ecosystem`,
    )
    .all(row.packageId, id);
  const update = updatesView(db).find((install) => install.installId === id);
  const target = update?.updatable ? update.available : update?.upstream;
  const summary = target ? changelogSummaryFor(db, row.packageId, target) : null;
  const changelog = summary ? { summary: summary.summary, sourceUrl: summary.sourceUrl, model: summary.model, createdAt: summary.createdAt } : null;
  const details = JSON.parse(row.details) as unknown;
  const flags = flagsOf(row as unknown as Parameters<typeof flagsOf>[0], details, context);
  return { ...row, details, flags, usage, constraints, relations, sameSoftware, dependencies: { needs: needsOf(db, id), neededBy: dependentsOf(db, id) }, supportWindows: supportWindowsOf(db, row.packageId), changelog };
}

/** Review evidence includes the live installs because identities can have several copies. */
export function proposalsResponse(db: Db): unknown {
  const installs = db.prepare(
    `SELECT i.id, i.machine_id AS machineId, s.kind AS sourceKind, i.version, i.location FROM installs i JOIN sources s ON s.id = i.source_id
     WHERE i.package_id = ? AND i.removed_at IS NULL ORDER BY i.machine_id`,
  );
  const pkg = db.prepare("SELECT id, ecosystem, key, name, publisher, description, homepage FROM packages WHERE id = ?");
  const merges = openProposals(db).slice(0, 200).map((p) => ({
    id: p.id,
    kind: "merge_proposal",
    rule: p.rule,
    packages: p.packageIds.map((id) => ({ ...(pkg.get(id) as object), installs: installs.all(id) })),
  }));
  const identity = db.prepare("SELECT id FROM packages WHERE ecosystem = ? AND key = ?");
  const dependencies = (db.prepare("SELECT id, subject_json FROM findings WHERE kind = 'dependency_proposal' AND state = 'open' ORDER BY id LIMIT 200").all() as { id: number; subject_json: string }[]).map((finding) => {
    const subject = JSON.parse(finding.subject_json) as DependencyProposalSubject;
    const packages = [subject.from, subject.to].map((key) => {
      const row = identity.get(key.ecosystem, key.key) as { id: number } | undefined;
      return row ? { ...(pkg.get(row.id) as object), installs: installs.all(row.id) } : { ...key, name: key.key, installs: [] };
    });
    return { id: finding.id, kind: "dependency_proposal", subject, packages };
  });
  return [...merges, ...dependencies];
}

export function decideProposalRequest(db: Db, id: number, body: unknown): { ok: true } {
  const accept = (body as { accept?: unknown } | null)?.accept;
  if (typeof accept !== "boolean") throw new Error("body must be {\"accept\": true|false}");
  const finding = db.prepare("SELECT kind FROM findings WHERE id = ?").get(id) as { kind: string } | undefined;
  if (finding?.kind === "dependency_proposal") {
    if (accept) confirmDependencyProposal(db, id);
    else rejectDependencyProposal(db, id);
  } else decideProposal(db, id, accept);
  return { ok: true };
}
