import { hubMachineId } from "./hub.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db } from "./db.ts";
import type { Project } from "./project-files.ts";

export const RECIPE_STATES = ["proposed", "approved", "rejected", "unsupported"] as const;
export type RecipeState = typeof RECIPE_STATES[number];
export interface DetectedRecipe {
  machineId: string; root: string; source: "package-json" | "launch-json" | "compose"; name: string;
  argv: string[]; port: number | null; hash: string; reason: string | null; detail: string | null;
}
export interface LaunchRecipe extends DetectedRecipe {
  id: number; project: string; command: string; cwd: string; state: RecipeState;
  proposedAt: string; decidedAt: string | null; lastSeenAt: string; gone: boolean; running: boolean | null;
}
export interface RecipeEvent { recipe: LaunchRecipe; change: "proposed" | "approved" | "rejected" | "updated" | "gone" }

const EXECUTABLES = new Set(["node", "npm", "npx", "pnpm", "yarn", "python", "python3", "py", "uv", "docker", "deno", "bun", "dotnet"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const regular = (path: string): boolean => { try { return lstatSync(path).isFile(); } catch { return false; } };
function readJson(root: string, file: string): Record<string, unknown> | null {
  if (!regular(join(root, file))) return null;
  try { const value: unknown = JSON.parse(readFileSync(join(root, file), "utf8")); return record(value) ? value : null; } catch { return null; }
}

export function validateRecipe(name: string, argv: readonly string[]): string | null {
  if (!/^[A-Za-z0-9._:-]+$/.test(name)) return "The recipe name contains unsupported characters.";
  const exe = argv[0] ?? "";
  if (/[/\\:]/.test(exe) || !EXECUTABLES.has(exe.toLowerCase().replace(/\.(exe|cmd|bat)$/, ""))) return "The executable must be a supported bare name.";
  if (argv.length - 1 > 12) return "The recipe has more than 12 arguments.";
  for (const arg of argv.slice(1)) {
    if (arg.length > 200) return "An argument is longer than 200 characters.";
    if (!/^[A-Za-z0-9._:/=@+,-]+$/.test(arg)) return "An argument contains unsupported characters.";
    if (arg.split(/[/:=]/).includes("..")) return "An argument contains a parent directory segment.";
  }
  return null;
}

export function detectRecipes(project: Project): DetectedRecipe[] {
  if (project.machineId !== hubMachineId()) return [];
  const root = project.root.replace(/\\/g, "/");
  const recipes: DetectedRecipe[] = [];
  const add = (source: DetectedRecipe["source"], name: string, argv: string[], port: number | null = null, detail: string | null = null, reason: string | null = null): void => {
    const hash = createHash("sha256").update(JSON.stringify({ argv, cwd: root })).digest("hex");
    recipes.push({ machineId: project.machineId, root, source, name, argv, port, hash, detail, reason: reason ?? validateRecipe(name, argv) });
  };
  const pkg = readJson(root, "package.json");
  if (record(pkg?.scripts)) {
    const manager = regular(join(root, "pnpm-lock.yaml")) ? "pnpm" : regular(join(root, "yarn.lock")) ? "yarn" : "npm";
    for (const name of ["start", "dev", "serve"]) if (typeof pkg.scripts[name] === "string") add("package-json", name, [manager, "run", name], null, pkg.scripts[name]);
  }
  // A linked configuration directory could escape the project boundary.
  let launch: Record<string, unknown> | null = null;
  try { if (lstatSync(join(root, ".claude")).isDirectory()) launch = readJson(root, ".claude/launch.json"); } catch {}
  if (Array.isArray(launch?.configurations)) for (const [index, config] of launch.configurations.entries()) {
    if (!record(config)) { add("launch-json", `configuration-${index + 1}`, [], null, null, "The launch configuration must be an object."); continue; }
    const name = typeof config.name === "string" ? config.name : `configuration-${index + 1}`;
    const args = config.runtimeArgs ?? [];
    const valid = typeof config.runtimeExecutable === "string" && Array.isArray(args) && args.every((arg) => typeof arg === "string") && typeof config.name === "string";
    const argv = [typeof config.runtimeExecutable === "string" ? config.runtimeExecutable : "", ...(Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [])];
    const port = Number.isInteger(config.port) && Number(config.port) >= 1 && Number(config.port) <= 65535 ? Number(config.port) : null;
    add("launch-json", name, argv, port, null, valid ? null : "The launch name, executable and arguments must be text.");
  }
  const compose = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].find((file) => regular(join(root, file)));
  if (compose) add("compose", compose, ["docker", "compose", "-f", compose, "up", "-d"]);
  return recipes;
}

const SELECT = `SELECT id, machine_id AS machineId, root, source, name, argv_json AS argvJson, port, hash, state, reason, detail, proposed_at AS proposedAt, decided_at AS decidedAt, last_seen_at AS lastSeenAt, gone_at AS goneAt FROM launch_recipes`;
type StoredRecipe = Omit<LaunchRecipe, "argv" | "project" | "command" | "cwd" | "gone" | "running"> & { argvJson: string; goneAt: string | null };
function fromRow(db: Db, row: StoredRecipe): LaunchRecipe {
  const { argvJson, goneAt, ...fields } = row;
  const argv = JSON.parse(argvJson) as string[];
  const running = row.port === null ? null : db.prepare("SELECT 1 FROM listeners WHERE machine_id = ? AND port = ? AND gone_at IS NULL LIMIT 1").get(row.machineId, row.port) !== undefined;
  return { ...fields, argv, project: basename(row.root), command: argv.join(" "), cwd: row.root, gone: goneAt !== null, running };
}
export function recipeById(db: Db, id: number): LaunchRecipe | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as StoredRecipe | undefined;
  return row ? fromRow(db, row) : null;
}
export function recipesResponse(db: Db, state = "all", at = new Date().toISOString()) {
  if (state !== "all" && !RECIPE_STATES.includes(state as RecipeState)) throw new Error("state must be proposed, approved, rejected, unsupported or all");
  const rows = db.prepare(`${SELECT} ORDER BY proposed_at DESC, id DESC`).all() as StoredRecipe[];
  const counts = { proposed: 0, approved: 0, rejected: 0, unsupported: 0 };
  for (const row of rows) counts[row.state]++;
  return { recipes: rows.filter((row) => state === "all" || row.state === state).map((row) => fromRow(db, row)), counts, generatedAt: at };
}
export function scanRecipes(db: Db, projects: readonly Project[], at = new Date().toISOString(), publish: (event: RecipeEvent) => void = () => undefined): { found: number; proposed: number } {
  const detected = projects.flatMap(detectRecipes);
  const seen = new Set<number>();
  const events: RecipeEvent[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const recipe of detected) {
      const old = db.prepare(`${SELECT} WHERE machine_id = ? AND root = ? AND source = ? AND name = ?`).get(recipe.machineId, recipe.root, recipe.source, recipe.name) as StoredRecipe | undefined;
      // A package script body is not part of the hash, so an edited body must also send the recipe back for review.
      const changed = old?.hash !== recipe.hash || old.source === "package-json" && old.detail !== recipe.detail;
      const state = recipe.reason ? "unsupported" : changed || old?.state === "unsupported" ? "proposed" : old!.state;
      const proposedAt = changed ? at : old!.proposedAt;
      const decidedAt = changed || state === "unsupported" || old?.state === "unsupported" ? null : old?.decidedAt ?? null;
      const id = Number(db.prepare(`INSERT INTO launch_recipes (machine_id, root, source, name, argv_json, port, hash, state, reason, detail, proposed_at, decided_at, last_seen_at, gone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(machine_id, root, source, name) DO UPDATE SET argv_json = excluded.argv_json, port = excluded.port, hash = excluded.hash, state = excluded.state, reason = excluded.reason, detail = excluded.detail, proposed_at = excluded.proposed_at, decided_at = excluded.decided_at, last_seen_at = excluded.last_seen_at, gone_at = NULL RETURNING id`).get(recipe.machineId, recipe.root, recipe.source, recipe.name, JSON.stringify(recipe.argv), recipe.port, recipe.hash, state, recipe.reason, recipe.detail, proposedAt, decidedAt, at)!.id);
      seen.add(id);
      if (!old || changed || old.goneAt !== null || old.state !== state || old.port !== recipe.port || old.detail !== recipe.detail) events.push({ recipe: recipeById(db, id)!, change: state === "proposed" && (!old || changed) ? "proposed" : "updated" });
    }
    for (const row of db.prepare(`${SELECT} WHERE machine_id = ? AND gone_at IS NULL`).all(hubMachineId()) as StoredRecipe[]) if (!seen.has(row.id)) {
      db.prepare("UPDATE launch_recipes SET gone_at = ? WHERE id = ?").run(at, row.id);
      events.push({ recipe: recipeById(db, row.id)!, change: "gone" });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  for (const event of events) publish(event);
  return { found: seen.size, proposed: [...seen].filter((id) => recipeById(db, id)!.state === "proposed").length };
}
export class RecipeError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export function decideRecipe(db: Db, body: Record<string, unknown>, at = new Date().toISOString(), publish: (event: RecipeEvent) => void = () => undefined): LaunchRecipe {
  if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0 || typeof body.hash !== "string" || !/^[a-f0-9]{64}$/.test(body.hash) || body.confirm !== true || body.decision !== "approve" && body.decision !== "reject") throw new RecipeError(400, "id, hash, decision and confirm: true are required");
  const recipe = recipeById(db, Number(body.id));
  if (!recipe) throw new RecipeError(404, "not found");
  if (recipe.hash !== body.hash) throw new RecipeError(409, "changed since you looked");
  if (recipe.gone || recipe.state === "unsupported") throw new RecipeError(409, recipe.reason ?? "The recipe source is gone.");
  const state = body.decision === "approve" ? "approved" : "rejected";
  db.prepare("UPDATE launch_recipes SET state = ?, decided_at = ? WHERE id = ?").run(state, at, recipe.id);
  const result = recipeById(db, recipe.id)!;
  publish({ recipe: result, change: state });
  return result;
}
