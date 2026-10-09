import type { Db } from "./db.ts";
import type { UpdateRow } from "./assertions.ts";
import { satisfiesDependencyRange } from "./semver-range.ts";

export function updateTarget(row: Pick<UpdateRow, "updatable" | "available" | "upstream">): string | null {
  return row.updatable ? row.available : row.upstream;
}

interface RiskEdge {
  fromId: number;
  toId: number;
  kind: string;
  constraint: string | null;
  builtAgainst: string | null;
}

/** The list shares one edge read so its cost follows the number of installs and edges. */
export function riskCounts<T extends UpdateRow>(db: Db, rows: T[]): T[] {
  const byTarget = new Map<number, RiskEdge[]>();
  const edges = db.prepare(
    `SELECT e.from_install_id AS fromId, e.to_install_id AS toId, e.kind, e."constraint", e.built_against AS builtAgainst
     FROM dependency_edges e JOIN installs i ON i.id = e.from_install_id JOIN installs t ON t.id = e.to_install_id
     WHERE i.removed_at IS NULL AND t.removed_at IS NULL`,
  ).all() as unknown as RiskEdge[];
  for (const edge of edges) {
    const group = byTarget.get(edge.toId) ?? [];
    group.push(edge);
    byTarget.set(edge.toId, group);
  }
  for (const row of rows) {
    const target = updateTarget(row);
    row.risk = target === null ? null : { hard: 0, soft: 0 };
    if (target === null || row.risk === null) continue;
    for (const edge of byTarget.get(row.installId) ?? []) {
      if (edge.kind === "runtime" && edge.constraint !== null) {
        const satisfied = satisfiesDependencyRange(target, edge.constraint);
        if (satisfied === null) row.risk.soft++;
        else if (!satisfied) row.risk.hard++;
      } else if (edge.kind === "library" && edge.builtAgainst !== null && edge.fromId !== row.installId && target.replace(/_\d+$/, "") !== edge.builtAgainst.replace(/_\d+$/, "")) row.risk.soft++;
    }
  }
  return rows;
}
