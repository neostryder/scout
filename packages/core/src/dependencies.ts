import type { Db } from "./db.ts";
import type { Probe, ProbeContext, ProbeOutputs, ScanStatus } from "./adapter.ts";
import { satisfiesDependencyRange } from "./semver-range.ts";

export type DependencySource = "brew-deps" | "npm-engines" | "pyvenv" | "winget-deps" | "ai-reviewed";
export type DependencyKind = "library" | "runtime";

export interface DependencyFact {
  from: { ecosystem: string; key: string };
  to: { ecosystem: string; key: string; name?: string };
  kind: DependencyKind;
  constraint: string | null;
  builtAgainst: string | null;
  evidence: string;
}

export interface DependencyResult {
  origin: DependencySource;
  status: ScanStatus;
  facts: DependencyFact[];
  message?: string;
}

export interface DependencyAdapter {
  origin: DependencySource;
  os: ReadonlyArray<"macos" | "windows" | "linux">;
  probes(ctx: ProbeContext): Probe[];
  parse(outputs: ProbeOutputs): DependencyResult;
}

export interface DependencyInstall {
  id: number;
  ecosystem: string;
  key: string;
  name: string;
  machine: string;
  version: string | null;
}

interface Target extends DependencyInstall {
  sourceId: number;
}

const RUNTIME_ALIASES = [
  { key: "node", ecosystems: ["brew", "winget", "binary"], names: ["node", "nodejs", "node.js", "openjs.nodejs", "openjs.nodejs.lts"] },
];

function resolveTarget(all: Target[], fact: DependencyFact, from: Target): Target | undefined {
  let matches = all.filter((install) => install.ecosystem === fact.to.ecosystem && install.key === fact.to.key);
  if (fact.to.ecosystem === "runtime") {
    if (fact.to.key === "python") {
      const minor = /^v?(\d+\.\d+)(?:\.|$)/.exec(fact.builtAgainst ?? "")?.[1];
      matches = minor ? all.filter((install) => install.ecosystem === "python" && /^v?(\d+\.\d+)(?:\.|$)/.exec(install.version ?? "")?.[1] === minor) : [];
    } else {
      const alias = RUNTIME_ALIASES.find((entry) => entry.key === fact.to.key);
      matches = alias ? all.filter((install) => alias.ecosystems.includes(install.ecosystem) && [install.key, install.name].some((name) => alias.names.includes(name.toLowerCase()))) : [];
    }
  }
  // Identity can occur in several source locations; the observed version and owning source narrow the choice.
  return matches.sort((a, b) => Number(b.version?.replace(/^v/, "") === fact.builtAgainst?.replace(/^v/, "")) - Number(a.version?.replace(/^v/, "") === fact.builtAgainst?.replace(/^v/, "")) || Number(b.sourceId === from.sourceId) - Number(a.sourceId === from.sourceId) || a.id - b.id)[0];
}

export function recordDependencies(db: Db, machineId: string, result: DependencyResult, now: string): { edges: number; skipped: number } {
  const summary = { edges: 0, skipped: 0 };
  if (result.status === "failed" || result.status === "skipped") return summary;
  db.exec("BEGIN IMMEDIATE");
  try {
    const all = db.prepare(
      `SELECT i.id, p.ecosystem, p.key, p.name, i.machine_id AS machine, i.version, i.source_id AS sourceId
       FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.machine_id = ? AND i.removed_at IS NULL ORDER BY i.id`,
    ).all(machineId) as unknown as Target[];
    db.prepare("DELETE FROM dependency_edges WHERE machine_id = ? AND source = ?").run(machineId, result.origin);
    const put = db.prepare(
      `INSERT INTO dependency_edges (machine_id, from_install_id, to_install_id, to_ecosystem, to_key, to_name, kind, "constraint", built_against, source, evidence, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_install_id, to_ecosystem, to_key, kind, source) DO UPDATE SET
         to_install_id = excluded.to_install_id, to_name = excluded.to_name, "constraint" = excluded."constraint",
         built_against = excluded.built_against, evidence = excluded.evidence, observed_at = excluded.observed_at`,
    );
    const seen = new Set<string>();
    for (const fact of result.facts) {
      const dependents = all.filter((install) => install.ecosystem === fact.from.ecosystem && install.key === fact.from.key);
      if (dependents.length === 0) summary.skipped++;
      for (const from of dependents) {
        const to = resolveTarget(all, fact, from);
        const evidence = fact.evidence.replaceAll("\\", "/").replace(/(?:[A-Za-z]:\/Users\/[^/\r\n]+|\/Users\/[^/\r\n]+|\/home\/[^/\r\n]+)/gi, "~");
        put.run(machineId, from.id, to?.id ?? null, fact.to.ecosystem, fact.to.key, fact.to.name ?? to?.name ?? fact.to.key, fact.kind, fact.constraint, fact.builtAgainst, result.origin, evidence, now);
        seen.add(JSON.stringify([from.id, fact.to.ecosystem, fact.to.key, fact.kind, result.origin]));
      }
    }
    summary.edges = seen.size;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}

export interface DependencyEdge {
  id: number;
  from: DependencyInstall;
  to: { id: number | null; ecosystem: string; key: string; name: string; version: string | null };
  kind: DependencyKind;
  constraint: string | null;
  builtAgainst: string | null;
  source: DependencySource;
  evidence: string;
  observedAt: string;
}

interface EdgeRow {
  id: number; fromId: number; ecosystem: string; key: string; name: string; machine: string; version: string | null;
  toId: number | null; toEcosystem: string; toKey: string; toName: string; toVersion: string | null;
  kind: DependencyKind; constraint: string | null; builtAgainst: string | null; source: DependencySource; evidence: string; observedAt: string;
}

function edges(db: Db, column: "from_install_id" | "to_install_id", installId: number): DependencyEdge[] {
  const rows = db.prepare(
    `SELECT e.id, i.id AS fromId, p.ecosystem, p.key, p.name, i.machine_id AS machine, i.version,
       t.id AS toId, e.to_ecosystem AS toEcosystem, e.to_key AS toKey, e.to_name AS toName, t.version AS toVersion,
       e.kind, e."constraint", e.built_against AS builtAgainst, e.source, e.evidence, e.observed_at AS observedAt
     FROM dependency_edges e JOIN installs i ON i.id = e.from_install_id JOIN packages p ON p.id = i.package_id
       LEFT JOIN installs t ON t.id = e.to_install_id AND t.removed_at IS NULL
     WHERE e.${column} = ? AND i.removed_at IS NULL ${column === "to_install_id" ? "AND t.id IS NOT NULL" : ""} ORDER BY i.id, e.id`,
  ).all(installId) as unknown as EdgeRow[];
  return rows.map((row) => ({
    id: row.id,
    from: { id: row.fromId, ecosystem: row.ecosystem, key: row.key, name: row.name, machine: row.machine, version: row.version },
    to: { id: row.toId, ecosystem: row.toEcosystem, key: row.toKey, name: row.toName, version: row.toVersion },
    kind: row.kind, constraint: row.constraint, builtAgainst: row.builtAgainst, source: row.source, evidence: row.evidence, observedAt: row.observedAt,
  }));
}

export function dependentsOf(db: Db, installId: number): DependencyEdge[] {
  return edges(db, "to_install_id", installId);
}

export function needsOf(db: Db, installId: number): DependencyEdge[] {
  return edges(db, "from_install_id", installId);
}

export interface Break {
  dependent: DependencyInstall;
  kind: DependencyKind;
  constraint: string | null;
  reason: string;
}

export function assessUpdate(db: Db, installId: number, targetVersion: string, options: { alsoUpdating?: number[] } = {}): { hard: Break[]; soft: Break[] } {
  const result: { hard: Break[]; soft: Break[] } = { hard: [], soft: [] };
  for (const edge of dependentsOf(db, installId)) {
    const entry = { dependent: edge.from, kind: edge.kind, constraint: edge.constraint };
    if (edge.kind === "runtime" && edge.constraint !== null) {
      const satisfied = satisfiesDependencyRange(targetVersion, edge.constraint);
      if (satisfied === null) result.soft.push({ ...entry, reason: "the range could not be read" });
      else if (!satisfied) result.hard.push({ ...entry, reason: `${edge.from.name} requires ${edge.to.name} ${edge.constraint}, which excludes ${targetVersion}.` });
    } else if (edge.kind === "library" && edge.builtAgainst !== null && edge.from.id !== installId && !options.alsoUpdating?.includes(edge.from.id)) {
      if (targetVersion.replace(/_\d+$/, "") !== edge.builtAgainst.replace(/_\d+$/, "")) result.soft.push({ ...entry, reason: `${edge.from.name} was built against ${edge.to.name} ${edge.builtAgainst}, which differs from ${targetVersion}.` });
    }
  }
  return result;
}
