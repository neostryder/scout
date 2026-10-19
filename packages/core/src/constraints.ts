import type { Db } from "./db.ts";
import type { ScanResult } from "./adapter.ts";

// Constraints stated by the installs themselves. Each is bound to the install it governs and states where it comes
// from, so the updates view can show the ceiling and never offer a version above a hard one.

export interface ConstraintSummary {
  freezes: number;
  gatedRanges: number;
}

export function deriveConstraints(db: Db, now = new Date().toISOString()): ConstraintSummary {
  const rows = db
    .prepare(
      `SELECT i.id, i.package_id, i.version, i.location, p.ecosystem, i.details_json
       FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.removed_at IS NULL AND p.ecosystem IN ('brew', 'image')`,
    )
    .all() as unknown as { id: number; package_id: number; version: string | null; location: string; ecosystem: string; details_json: string }[];
  const summary: ConstraintSummary = { freezes: 0, gatedRanges: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM constraints WHERE json_extract(detail_json, '$.derived') = 1");
    const insert = db.prepare(
      "INSERT INTO constraints (install_id, package_id, type, hard, spec, origin, detail_json, observed_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      const d = JSON.parse(r.details_json) as Record<string, unknown>;
      if (r.ecosystem === "brew" && d["pinned"] === true && r.version) {
        insert.run(r.id, r.package_id, "freeze", r.version, "brew pin", JSON.stringify({ derived: 1 }), now);
        summary.freezes++;
      }
      if (r.ecosystem === "image" && d["tagKind"] === "exact" && r.version) {
        // The compose file names this exact tag. Moving past it means editing that file, so the tag is a gate.
        insert.run(r.id, r.package_id, "gated_range", r.version, r.location, JSON.stringify({ derived: 1, tag: r.version }), now);
        summary.gatedRanges++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}

type ProjectSelector = NonNullable<ScanResult["selectors"]>[number];

interface SelectorInstall {
  id: number;
  packageId: number;
  key: string;
  ecosystem: string;
  sourceKind: string;
  kind: string;
  location: string;
  details: string;
}

function selectorMatches(selector: ProjectSelector, install: SelectorInstall): boolean {
  if (!["runtime", "package", "binary"].includes(install.kind)) return false;
  const tool = selector.tool === "nodejs" ? "node" : selector.tool === "golang" ? "go" : selector.tool;
  const key = install.key.toLowerCase().replace(/@\d.*$/, "");
  const aliases: Record<string, string[]> = {
    node: ["node", "nodejs", "openjs.nodejs", "openjs.nodejs.lts"],
    python: ["python", "python3", "python2"], rust: ["rust", "rustup", "rustc", "rustlang.rustup"],
    go: ["go", "golang", "golang.go"], ruby: ["ruby"], pnpm: ["pnpm", "pnpm.pnpm", "@pnpm/exe"], yarn: ["yarn", "yarn.yarn"], npm: ["npm"],
  };
  if (aliases[tool]?.includes(key)) return true;
  if (tool === "python" && install.kind === "runtime" && install.ecosystem === "python") return true;
  if (tool === "python" && /^python\.python\.\d/.test(key)) return true;
  if (tool === "node" && install.kind === "runtime" && ["node", "nodejs", "nvm", "fnm"].includes(install.sourceKind)) return true;
  const details = JSON.parse(install.details) as Record<string, unknown>;
  if (install.kind === "runtime" && ["nvm", "fnm", "volta", "asdf", "mise", "pyenv", "rustup"].includes(install.sourceKind) && (details["tool"] === tool || details["runtime"] === tool)) return true;
  const binary = install.location.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.exe$/, "");
  return ["binary", "runtime"].includes(install.kind) && binary !== undefined && (aliases[tool]?.includes(binary) ?? false);
}

function homePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+|\/root)(?=\/|$)/i, "~");
}

/** The caller owns the scan transaction, so selector rows and coverage have the same outcome. */
export function recordProjectSelectors(db: Db, machineId: string, sourceId: number, selectors: ProjectSelector[], complete: boolean, now: string): void {
  const remove = db.prepare("DELETE FROM constraints WHERE json_extract(detail_json, '$.projectselSource') = ?");
  if (complete) remove.run(sourceId);
  const installs = db.prepare(
    `SELECT i.id, i.package_id AS packageId, p.key, p.ecosystem, s.kind AS sourceKind, i.kind, i.location, i.details_json AS details
     FROM installs i JOIN packages p ON p.id = i.package_id JOIN sources s ON s.id = i.source_id
     WHERE i.machine_id = ? AND i.removed_at IS NULL`,
  ).all(machineId) as unknown as SelectorInstall[];
  const insert = db.prepare("INSERT INTO constraints (install_id, package_id, type, hard, spec, origin, detail_json, observed_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)");
  const seen = new Set<string>();
  const replaced = new Set<string>();
  for (const selector of selectors) {
    const identity = JSON.stringify([selector.file, selector.kind, selector.tool, selector.spec]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    // A partial scan replaces only selectors it read; an unreadable file cannot prove absence.
    const group = JSON.stringify([selector.file, selector.kind, selector.tool]);
    if (!complete && !replaced.has(group)) {
      db.prepare(
        "DELETE FROM constraints WHERE json_extract(detail_json, '$.projectselSource') = ? AND json_extract(detail_json, '$.file') = ? AND json_extract(detail_json, '$.kind') = ? AND json_extract(detail_json, '$.tool') = ?",
      ).run(sourceId, homePath(selector.file), selector.kind, selector.tool);
      replaced.add(group);
    }
    const matches = installs.filter((install) => selectorMatches(selector, install));
    const detail = JSON.stringify({ projectselSource: sourceId, machineId, file: homePath(selector.file), project: homePath(selector.project), kind: selector.kind, tool: selector.tool });
    for (const install of matches.length ? matches : [null]) {
      insert.run(install?.id ?? null, install?.packageId ?? null, selector.kind === "engines" ? "compat_range" : "project_selector", selector.spec, homePath(selector.file), detail, now);
    }
  }
}

type NumericVersion = [number, number, number];

function numericVersion(text: string): { parts: NumericVersion; count: number; prerelease: boolean } | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)], count: match[3] ? 3 : match[2] ? 2 : 1, prerelease: match[4] !== undefined };
}

function compareNumeric(a: NumericVersion, b: NumericVersion): number {
  for (let n = 0; n < 3; n++) if (a[n]! !== b[n]!) return a[n]! < b[n]! ? -1 : 1;
  return 0;
}

// Unsupported syntax stays unknown because a guessed range warning would misstate the project requirement.
function satisfiesRange(version: string, range: string): boolean | null {
  const available = numericVersion(version);
  if (!available) return null;
  let unknown = false;
  for (const alternative of range.split("||")) {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alternative);
    let tests: (boolean | null)[];
    if (hyphen) {
      const lower = numericVersion(hyphen[1]!);
      const upper = numericVersion(hyphen[2]!);
      if (!lower || !upper || lower.prerelease || upper.prerelease) tests = [null];
      else {
        const ceiling: NumericVersion = [...upper.parts];
        if (upper.count < 3) ceiling[upper.count - 1] = ceiling[upper.count - 1]! + 1;
        tests = [compareNumeric(available.parts, lower.parts) >= 0 && compareNumeric(available.parts, ceiling) < (upper.count < 3 ? 0 : 1)];
      }
    } else {
      const tokens = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").replaceAll(",", " ").split(/\s+/).filter(Boolean);
      tests = tokens.map((token): boolean | null => {
        if (token === "*" || /^x$/i.test(token)) return true;
        const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
        const operator = match[1] ?? "";
        const raw = match[2]!;
        const wildcard = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(raw);
        const bound = numericVersion(raw) ?? (wildcard ? numericVersion(raw.replace(/[x*]/gi, "0")) : null);
        if (!bound || bound.prerelease) return null;
        const cmp = compareNumeric(available.parts, bound.parts);
        const count = wildcard ? wildcard[3] && /^\d+$/.test(wildcard[3]) ? 3 : wildcard[2] && /^\d+$/.test(wildcard[2]) ? 2 : 1 : bound.count;
        const partial = count < 3;
        const upper: NumericVersion = [...bound.parts];
        upper[count - 1] = upper[count - 1]! + 1;
        if (operator === ">=") return cmp >= 0;
        if (operator === ">") return partial ? compareNumeric(available.parts, upper) >= 0 : cmp > 0;
        if (operator === "<=") return partial ? compareNumeric(available.parts, upper) < 0 : cmp <= 0;
        if (operator === "<") return cmp < 0;
        if (operator === "^" || operator === "~") {
          const index = operator === "~" ? Math.min(count - 1, 1) : bound.parts[0] > 0 || count === 1 ? 0 : bound.parts[1] > 0 || count === 2 ? 1 : 2;
          const ceiling: NumericVersion = [...bound.parts];
          ceiling[index] = ceiling[index]! + 1;
          for (let n = index + 1; n < 3; n++) ceiling[n] = 0;
          return cmp >= 0 && compareNumeric(available.parts, ceiling) < 0;
        }
        if (operator === "" || operator === "=") return partial ? cmp >= 0 && compareNumeric(available.parts, upper) < 0 : cmp === 0;
        return null;
      });
      if (tokens.length === 0) tests = [true];
    }
    if (tests.includes(false)) continue;
    if (tests.includes(null)) unknown = true;
    else if (!available.prerelease) return true;
  }
  return unknown ? null : false;
}

/** Load once per updates query so notes do not add a query for every install. */
export function projectSelectorNotes(db: Db): (installId: number, available: string | null) => string[] {
  const byInstall = new Map<number, { type: string; spec: string; origin: string; detail: string }[]>();
  for (const row of db.prepare("SELECT install_id AS installId, type, spec, origin, detail_json AS detail FROM constraints WHERE install_id IS NOT NULL AND type IN ('project_selector', 'compat_range') ORDER BY origin, id").all() as unknown as { installId: number; type: string; spec: string; origin: string; detail: string }[]) {
    const list = byInstall.get(row.installId) ?? [];
    list.push(row);
    byInstall.set(row.installId, list);
  }
  return (installId, available) => {
    const notes = new Set<string>();
    for (const constraint of byInstall.get(installId) ?? []) {
      const detail = JSON.parse(constraint.detail) as { project?: string; tool?: string };
      const project = detail.project ?? constraint.origin.slice(0, constraint.origin.lastIndexOf("/"));
      const name = constraint.origin.split("/").at(-1)?.replace(/^\./, "") ?? "selector";
      if (constraint.type === "project_selector") notes.add(`${name} in ${project} wants ${detail.tool ?? "runtime"} ${constraint.spec}`);
      else if (available !== null && satisfiesRange(available, constraint.spec) === false) notes.add(`engines.${detail.tool ?? "runtime"} ${constraint.spec} in ${project} excludes ${available}`);
    }
    return [...notes];
  };
}
