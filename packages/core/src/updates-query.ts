import type { Db } from "./db.ts";
import { updatesView, type UpdateRow } from "./assertions.ts";
import { compareVersions } from "./version.ts";
import { projectSelectorNotes } from "./constraints.ts";
import { cachedPriorityFlags, priorityScore, type PriorityPart } from "./priority.ts";

export type UpdateStatus = "updatable" | "blocked" | "upstream" | "advisory" | "current";
export type UpdateBump = "major" | "minor" | "patch" | "other";
export type UpdateSort = "name" | "machine" | "ecosystem" | "source" | "installed" | "available" | "status" | "bump" | "checked" | "lastUsed" | "category" | "publisher" | "firstSeen" | "priority";
export type UpdateFacet = "machine" | "ecosystem" | "source" | "status" | "bump" | "category" | "publisher";

export interface UpdateQuery {
  safe?: boolean;
  q?: string;
  machine?: string[];
  ecosystem?: string[];
  source?: string[];
  status?: UpdateStatus[];
  bump?: UpdateBump[];
  category?: string[];
  publisher?: string[];
  hasBeta?: boolean;
  hasUpstream?: boolean;
  usedWithinDays?: number;
  neverUsed?: boolean;
  unknownUse?: boolean;
  running?: boolean;
  sort?: UpdateSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  now?: string;
}

const DIMENSIONS: UpdateFacet[] = ["machine", "ecosystem", "source", "status", "bump", "category", "publisher"];
const STATUS_ORDER: UpdateStatus[] = ["updatable", "blocked", "upstream", "advisory", "current"];
const BUMP_ORDER: (UpdateBump | null)[] = [null, "other", "patch", "minor", "major"];
const DEFAULT_STATUS: UpdateStatus[] = ["updatable", "blocked", "upstream", "advisory"];

export type PriorityUpdateRow = UpdateRow & { priority: number | null; priorityParts: PriorityPart[] };

function matches(row: UpdateRow, q: UpdateQuery, skip?: UpdateFacet): boolean {
  if (q.safe && (row.risk?.hard ?? 0) > 0) return false;
  if (q.machine?.length && skip !== "machine" && !q.machine.includes(row.machineId)) return false;
  if (q.ecosystem?.length && skip !== "ecosystem" && !q.ecosystem.includes(row.ecosystem)) return false;
  if (q.source?.length && skip !== "source" && !q.source.includes(row.availableSource ?? "")) return false;
  if (q.category?.length && skip !== "category" && !q.category.includes(row.category ?? "(none)")) return false;
  if (q.publisher?.length && skip !== "publisher" && !q.publisher.includes(row.publisher ?? "(none)")) return false;
  if (skip !== "status" && !(q.status ?? DEFAULT_STATUS).some((s) => row.statuses.includes(s))) return false;
  if (q.bump !== undefined && skip !== "bump" && (row.bump === null || !q.bump.includes(row.bump))) return false;
  if (q.hasBeta && row.beta === null) return false;
  if (q.hasUpstream && row.upstream === null) return false;
  if (q.usedWithinDays !== undefined) {
    const now = q.now ? Date.parse(q.now) : Date.now();
    if (row.lastUsed === null || row.lastUsed < new Date(now - q.usedWithinDays * 86_400_000).toISOString()) return false;
  }
  if (q.neverUsed && !row.usage.neverUsed) return false;
  if (q.unknownUse && row.usage.known) return false;
  if (q.running && !row.usage.running) return false;
  if (q.q) {
    const haystack = [row.name, row.key, row.description, row.publisher, row.machineId, row.ecosystem, row.category].join(" ").toLowerCase();
    if (!q.q.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term))) return false;
  }
  return true;
}

function facetValue(row: UpdateRow, d: UpdateFacet): string[] {
  if (d === "machine") return [row.machineId];
  if (d === "ecosystem") return [row.ecosystem];
  if (d === "source") return [row.availableSource ?? "(none)"];
  if (d === "status") return row.statuses;
  if (d === "bump") return [row.bump ?? "(none)"];
  if (d === "category") return [row.category ?? "(none)"];
  return [row.publisher ?? "(none)"];
}

function compareText(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function compareRows(a: PriorityUpdateRow, b: PriorityUpdateRow, sort: UpdateSort): number {
  if (sort === "priority") return (a.priority ?? 0) - (b.priority ?? 0);
  if (sort === "status") return STATUS_ORDER.indexOf(a.statuses[0] as UpdateStatus) - STATUS_ORDER.indexOf(b.statuses[0] as UpdateStatus);
  if (sort === "bump") return BUMP_ORDER.indexOf(a.bump) - BUMP_ORDER.indexOf(b.bump);
  if (sort === "installed" || sort === "available") {
    const x = sort === "installed" ? a.installed : a.available;
    const y = sort === "installed" ? b.installed : b.available;
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return compareVersions(x, y) ?? compareText(x, y);
  }
  const field = (r: UpdateRow): string | null => {
    if (sort === "machine") return r.machineId;
    if (sort === "ecosystem") return r.ecosystem;
    if (sort === "source") return r.availableSource;
    if (sort === "checked") return r.checkedAt;
    if (sort === "lastUsed") return r.lastUsed;
    if (sort === "category") return r.category;
    if (sort === "publisher") return r.publisher;
    if (sort === "firstSeen") return r.firstSeen;
    return r.name;
  };
  return compareText(field(a), field(b));
}

export function queryUpdates(db: Db, q: UpdateQuery = {}): { total: number; updatable: number; rows: (Omit<PriorityUpdateRow, "usage"> & { notes: string[] })[]; facets: Record<UpdateFacet, { value: string; count: number }[]> } {
  // Project files explain project choices without changing the update verdict.
  const notes = projectSelectorNotes(db);
  const flags = cachedPriorityFlags(db);
  const freezes = db.prepare("SELECT install_id AS installId, package_id AS packageId FROM constraints WHERE hard = 1 AND type = 'freeze'").all() as { installId: number | null; packageId: number | null }[];
  const frozenInstalls = new Set(freezes.flatMap((freeze) => freeze.installId === null ? [] : [freeze.installId]));
  const frozenPackages = new Set(freezes.flatMap((freeze) => freeze.installId === null && freeze.packageId !== null ? [freeze.packageId] : []));
  const ineligible = (row: UpdateRow): boolean => row.blockedBy !== null || row.advisoryOnly || frozenInstalls.has(row.installId) || frozenPackages.has(row.packageId);
  const now = q.now ?? new Date().toISOString();
  const all: (PriorityUpdateRow & { notes: string[] })[] = updatesView(db).map((row) => {
    const rowNotes = notes(row.installId, row.available);
    const target = row.available ?? row.upstream;
    const blocked = ineligible(row);
    if (!blocked && (target === null || row.installed === null || compareVersions(target, row.installed) === null)) return { ...row, priority: null, priorityParts: [], notes: rowNotes };
    const result = priorityScore({ installed: row.installed, available: target, now, bump: target === row.available ? row.bump : undefined, lastUsed: row.lastUsed, running: row.usage.running, kind: row.kind, category: row.category, blocked, flags: target === null ? undefined : flags.get(row.packageId)?.get(target) });
    return { ...row, priority: result.score, priorityParts: result.parts, notes: rowNotes };
  });
  const facets = {} as Record<UpdateFacet, { value: string; count: number }[]>;
  for (const d of DIMENSIONS) {
    const counts = new Map<string, number>();
    for (const row of all) if (matches(row, q, d)) for (const value of facetValue(row, d)) counts.set(value, (counts.get(value) ?? 0) + 1);
    facets[d] = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || compareText(a.value, b.value));
  }
  const filtered = all.filter((row) => matches(row, q));
  const sort = q.sort ?? "name";
  const dir = q.dir ?? (["lastUsed", "checked", "firstSeen", "bump", "priority"].includes(sort) ? "desc" : "asc");
  filtered.sort((a, b) => {
    if (sort === "priority") {
      if (a.priority === null && b.priority !== null) return 1;
      if (b.priority === null && a.priority !== null) return -1;
      const aBlocked = ineligible(a);
      const bBlocked = ineligible(b);
      if (a.priority !== null && b.priority !== null && aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    }
    if (sort !== "bump" && sort !== "status") {
      const nullable = (r: UpdateRow): string | null | undefined => {
        if (sort === "source") return r.availableSource;
        if (sort === "installed") return r.installed;
        if (sort === "available") return r.available;
        if (sort === "checked") return r.checkedAt;
        if (sort === "lastUsed") return r.lastUsed;
        if (sort === "category") return r.category;
        if (sort === "publisher") return r.publisher;
        return undefined;
      };
      const x = nullable(a);
      const y = nullable(b);
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
    }
    const primary = compareRows(a, b, sort);
    return (dir === "desc" ? -primary : primary) || compareText(a.name, b.name) || compareText(a.machineId, b.machineId) || a.installId - b.installId;
  });
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 200), 1), 1000);
  const offset = Math.max(Math.trunc(q.offset ?? 0), 0);
  return { total: filtered.length, updatable: filtered.filter((r) => r.updatable).length, rows: filtered.slice(offset, offset + limit).map(({ usage: _usage, ...row }) => row), facets };
}
