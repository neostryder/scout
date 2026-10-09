import { assessUpdate, projectSelectorNotes, satisfiesDependencyRange, type Break, type Db } from "@scout/core";

export type UpdateBreak = Omit<Break, "dependent"> & {
  dependent: Omit<Break["dependent"], "id" | "version"> & { id: number | null; version?: string | null };
};
export interface UpdateBreaks { hard: UpdateBreak[]; soft: UpdateBreak[] }
export interface SoftConfirmation { projects: string[]; dependents: string[] }

export function dependencyRefusal(target: string, names: string[], reasons: string[] = []): string {
  return `${target} is used by ${[...new Set(names)].join(", ")}; update them together or leave this one${reasons.length ? `. ${[...new Set(reasons)].join(" ")}` : ""}`;
}

export function updateBreaks(db: Db, installId: number, target: string | null, machine: string, alsoUpdating: number[] = []): UpdateBreaks {
  if (target === null) return { hard: [], soft: [] };
  const partners = new Set((db.prepare("SELECT id FROM installs WHERE machine_id = ? AND removed_at IS NULL").all(machine) as { id: number }[]).map((row) => row.id).filter((id) => id !== installId && alsoUpdating.includes(id)));
  const assessment = assessUpdate(db, installId, target, { alsoUpdating: [...partners] });
  const breaks: UpdateBreaks = { hard: assessment.hard.filter((entry) => !partners.has(entry.dependent.id)), soft: [...assessment.soft] };
  const notes = projectSelectorNotes(db)(installId, target);
  const constraints = db.prepare(
    "SELECT type, spec, origin, detail_json AS detail FROM constraints WHERE install_id = ? AND type IN ('project_selector', 'compat_range') ORDER BY origin, id",
  ).all(installId) as unknown as { type: string; spec: string; origin: string; detail: string }[];
  for (const constraint of constraints) {
    const detail = JSON.parse(constraint.detail) as { project?: string; tool?: string };
    const project = detail.project ?? constraint.origin.slice(0, constraint.origin.lastIndexOf("/"));
    const folder = project.split("/").filter(Boolean).at(-1) ?? project;
    const file = constraint.origin.split("/").at(-1)?.replace(/^\./, "") ?? "selector";
    const reason = constraint.type === "project_selector" ? `${file} in ${project} wants ${detail.tool ?? "runtime"} ${constraint.spec}` : `engines.${detail.tool ?? "runtime"} ${constraint.spec} in ${project} excludes ${target}`;
    if (!notes.includes(reason) || constraint.type === "project_selector" && satisfiesDependencyRange(target, constraint.spec) !== false) continue;
    breaks.soft.push({ dependent: { id: null, ecosystem: "project", key: folder, name: folder, machine }, kind: "runtime", constraint: constraint.spec, reason });
  }
  return breaks;
}

export function softConfirmation(breaks: UpdateBreaks): SoftConfirmation | null {
  if (breaks.soft.length === 0) return null;
  return {
    projects: [...new Set(breaks.soft.filter((entry) => entry.dependent.ecosystem === "project").map((entry) => entry.dependent.name))],
    dependents: [...new Set(breaks.soft.filter((entry) => entry.dependent.ecosystem !== "project").map((entry) => entry.dependent.name))],
  };
}
