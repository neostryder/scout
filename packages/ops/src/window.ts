import { dependencyGroups, dependencyPairs, orderByDependencies, quietWindow, updatesView, type Db, type QuietWindow, type UpdateBump } from "@scout/core";
import { previewUpdate, type MachineConfig } from "./runner.ts";

export interface WindowItem {
  installId: number; name: string; ecosystem: string; from: string | null; to: string | null; bump: UpdateBump | null;
  running: boolean; warnings: string[];
}
export type HeldKind = "blocked" | "admin" | "confirm";
export interface HeldItem extends WindowItem { kind: HeldKind; reason: string }
export interface MachineWindow {
  machineId: string;
  /** Safe to start now, in the order they should run. */
  now: WindowItem[];
  /** Each of these closes or restarts something, or shares a dependency with something that does, so they wait for the quiet window. */
  atQuietHour: WindowItem[];
  /** Updates a person has to look at or approve first. */
  held: HeldItem[];
}
export interface UpdateWindows { generatedAt: string; quiet: QuietWindow; machines: MachineWindow[] }

/** Splits each machine's pending updates into a batch that is safe to start now, a batch for the quiet window, and what needs a person, and orders both batches so what an install uses goes first. */
export function planWindows(db: Db, machines: MachineConfig[], now = new Date(), offsetMinutes = -now.getTimezoneOffset()): UpdateWindows {
  const rows = updatesView(db).filter((row) => row.job === null && (row.statuses.includes("updatable") || row.statuses.includes("blocked")));
  const byMachine = new Map<string, typeof rows>();
  for (const row of rows) byMachine.set(row.machineId, [...(byMachine.get(row.machineId) ?? []), row]);
  const out: MachineWindow[] = [];
  for (const [machineId, list] of [...byMachine].sort(([a], [b]) => a.localeCompare(b))) {
    const item = (row: (typeof rows)[number], extra: { running?: boolean; warnings?: string[] } = {}): WindowItem => ({ installId: row.installId, name: row.name, ecosystem: row.ecosystem, from: row.installed, to: row.available, bump: row.bump, running: extra.running ?? row.usage.running, warnings: extra.warnings ?? [] });
    const held: HeldItem[] = [];
    let candidates = list.filter((row) => row.updatable);
    for (const row of list.filter((entry) => !entry.updatable)) held.push({ ...item(row), kind: "blocked", reason: row.blockedBy ?? "no installable update is available" });
    // A refused partner cannot excuse a break for an install that stays in the batch, so settle the set before ordering it.
    const previews = new Map<number, NonNullable<ReturnType<typeof previewUpdate>>["preview"]>();
    for (let changed = true; changed;) {
      changed = false;
      const alsoUpdating = candidates.map((row) => row.installId);
      candidates = candidates.filter((row) => {
        const preview = previewUpdate(db, row.installId, machines, { alsoUpdating })?.preview;
        if (preview) previews.set(row.installId, preview);
        if (preview?.allowed && !preview.needsAdmin && !preview.softConfirmation) return true;
        const kind: HeldKind = !preview || !preview.allowed ? "blocked" : preview.needsAdmin ? "admin" : "confirm";
        const reason = !preview || !preview.allowed ? preview?.refusal ?? "no such install or update"
          : preview.needsAdmin ? "needs the Windows administrator prompt"
          : `needs a check first: ${[...(preview.softConfirmation?.projects ?? []), ...(preview.softConfirmation?.dependents ?? [])].join(", ")}`;
        held.push({ ...item(row, { running: preview?.running ?? row.usage.running, warnings: preview?.warnings ?? [] }), kind, reason });
        changed = true;
        return false;
      });
    }
    const ids = candidates.map((row) => row.installId);
    const pairs = dependencyPairs(db, ids);
    const quietIds = new Set<number>();
    for (const group of dependencyGroups(ids, pairs)) if (group.some((id) => previews.get(id)?.disruptive)) for (const id of group) quietIds.add(id);
    const ordered = orderByDependencies(ids, pairs);
    const pick = (wanted: boolean): WindowItem[] => ordered.filter((id) => quietIds.has(id) === wanted).map((id) => {
      const row = candidates.find((entry) => entry.installId === id)!;
      const preview = previews.get(id);
      return item(row, { running: preview?.running ?? row.usage.running, warnings: preview?.warnings ?? [] });
    });
    out.push({ machineId, now: pick(false), atQuietHour: pick(true), held: held.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return { generatedAt: now.toISOString(), quiet: quietWindow(now, offsetMinutes), machines: out };
}
