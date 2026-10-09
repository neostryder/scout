import { hubMachineId } from "./hub.ts";
import { readFileSync, statSync } from "node:fs";
import type { Db } from "./db.ts";
import { listListeners, type Listener } from "./listeners.ts";
import { recipesResponse, type LaunchRecipe } from "./recipes.ts";

export interface PortRange { name: string; from: number; to: number; note?: string }
export interface ReservedPort { port: number; name: string; match?: string; note?: string }
export interface PortRegistry { ranges: PortRange[]; reserved: ReservedPort[] }
export interface RegistryFile<T> { config: T; exists: boolean; fileError: string | null }
export interface PortClash { key: string; kind: "reserved-taken" | "recipe-port-taken" | "recipe-port-shared"; port: number; detail: string }

export const registryObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const registryPort = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const noteValid = (value: unknown): boolean => value === undefined || typeof value === "string" && value.length <= 200;

export function registryFileReader<T>(path: string, empty: () => T, validate: (data: unknown) => { config: T; fileError: string | null }): () => RegistryFile<T> {
  let stamp: string | null = null;
  let cached: RegistryFile<T> = { config: empty(), exists: false, fileError: null };
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      observed = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === observed) return cached;
      cached = { ...validate(JSON.parse(readFileSync(path, "utf8"))), exists: true };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      cached = missing ? { config: empty(), exists: false, fileError: null } : { ...cached, exists: true, fileError: "The registry file is malformed or unreadable; the last good copy remains in use." };
    }
    stamp = observed;
    return cached;
  };
}

export function validatePorts(data: unknown): { config: PortRegistry; fileError: string | null } {
  if (!registryObject(data) || data.ranges !== undefined && !Array.isArray(data.ranges) || data.reserved !== undefined && !Array.isArray(data.reserved)) throw new Error("The port registry must contain arrays.");
  const ranges: PortRange[] = [];
  const reserved: ReservedPort[] = [];
  const errors: string[] = [];
  for (const [index, row] of ((data.ranges ?? []) as unknown[]).entries()) {
    let reason: string | null = null;
    if (!registryObject(row)) reason = "the entry must be an object";
    else if (typeof row.name !== "string" || !/^[a-z0-9-]{1,32}$/.test(row.name)) reason = "the name must contain 1 to 32 lowercase letters, digits or hyphens";
    else if (!registryPort(row.from) || !registryPort(row.to) || row.from > row.to) reason = "the bounds must be integers from 1 to 65535 in ascending order";
    else if (!noteValid(row.note)) reason = "the note must be text up to 200 characters";
    else if (ranges.some((range) => range.name === row.name)) reason = "the name is duplicated";
    else if (ranges.some((range) => Number(row.from) <= range.to && Number(row.to) >= range.from)) reason = "the range overlaps an earlier range";
    else if (ranges.length >= 32) reason = "the registry already contains 32 ranges";
    if (reason) errors.push(`Range ${index + 1} was dropped because ${reason}.`);
    else if (registryObject(row)) ranges.push({ name: row.name as string, from: row.from as number, to: row.to as number, ...(row.note !== undefined ? { note: row.note as string } : {}) });
  }
  for (const [index, row] of ((data.reserved ?? []) as unknown[]).entries()) {
    let reason: string | null = null;
    if (!registryObject(row)) reason = "the entry must be an object";
    else if (!registryPort(row.port)) reason = "the port must be an integer from 1 to 65535";
    else if (typeof row.name !== "string" || !row.name.length) reason = "the name must be nonempty text";
    else if (row.match !== undefined && typeof row.match !== "string") reason = "the match must be text";
    else if (!noteValid(row.note)) reason = "the note must be text up to 200 characters";
    else if (reserved.some((entry) => entry.port === row.port)) reason = "the port is duplicated";
    else if (reserved.length >= 256) reason = "the registry already contains 256 reserved ports";
    if (reason) errors.push(`Reserved entry ${index + 1} was dropped because ${reason}.`);
    else if (registryObject(row)) reserved.push({ port: row.port as number, name: row.name as string, ...(row.match !== undefined ? { match: row.match as string } : {}), ...(row.note !== undefined ? { note: row.note as string } : {}) });
  }
  return { config: { ranges, reserved }, fileError: errors.length ? errors.join(" ") : null };
}

export const portsFileReader = (path = ".scout-data/ports.json") => registryFileReader(path, () => ({ ranges: [], reserved: [] } as PortRegistry), validatePorts);
const owner = (listener: Listener): string => listener.processName ?? listener.containerName ?? "Unknown process";
const matches = (listener: Listener, match: string): boolean => [listener.processName, listener.containerName].some((name) => name?.toLowerCase().includes(match.toLowerCase()));

export function portClashes(registry: PortRegistry, listeners: Listener[], recipes: LaunchRecipe[]): PortClash[] {
  const present = listeners.filter((row) => row.machineId === hubMachineId() && row.goneAt === null);
  const clashes: PortClash[] = [];
  for (const entry of registry.reserved) {
    const taken = present.find((listener) => listener.port === entry.port && entry.match !== undefined && !matches(listener, entry.match));
    if (taken) clashes.push({ key: `reserved:${entry.port}`, kind: "reserved-taken", port: entry.port, detail: `Port ${entry.port} is reserved for ${entry.name} but ${owner(taken)} is listening on it` });
  }
  const active = recipes.filter((recipe) => recipe.machineId === hubMachineId() && !recipe.gone && recipe.state !== "rejected" && recipe.port !== null);
  for (const recipe of active.filter((recipe) => recipe.state === "approved")) {
    const executable = (recipe.argv[0] ?? "").replace(/^.*[/\\]/, "").replace(/\.(exe|cmd|bat)$/i, "");
    const taken = present.find((listener) => listener.port === recipe.port && !matches(listener, executable) && !matches(listener, recipe.project));
    if (taken) clashes.push({ key: `recipe:${recipe.id}:${recipe.port}`, kind: "recipe-port-taken", port: recipe.port!, detail: `Port ${recipe.port} belongs to ${recipe.project} ${recipe.name} but ${owner(taken)} is listening on it` });
  }
  for (const port of [...new Set(active.map((recipe) => recipe.port!))].sort((a, b) => a - b)) {
    const shared = active.filter((recipe) => recipe.port === port);
    if (shared.length > 1) clashes.push({ key: `shared:${port}`, kind: "recipe-port-shared", port, detail: `Port ${port} is declared by ${shared.map((recipe) => `${recipe.project} ${recipe.name}`).join(", ")}` });
  }
  return clashes;
}

export function nextFreePort(range: PortRange, registry: PortRegistry, listeners: Listener[], recipes: LaunchRecipe[]): number | null {
  const unavailable = new Set([...listeners.filter((row) => row.machineId === hubMachineId() && row.goneAt === null).map((row) => row.port), ...registry.reserved.map((row) => row.port), ...recipes.filter((row) => row.machineId === hubMachineId() && !row.gone && (row.state === "approved" || row.state === "proposed")).map((row) => row.port)]);
  for (let port = range.from; port <= range.to; port++) if (!unavailable.has(port)) return port;
  return null;
}

export function portsResponse(db: Db, file: RegistryFile<PortRegistry>, at = new Date().toISOString()) {
  const listeners = listListeners(db, { machine: hubMachineId(), state: "present" });
  const recipes = recipesResponse(db).recipes;
  const clashes = portClashes(file.config, listeners, recipes);
  return {
    ranges: file.config.ranges.map((range) => {
      const used = [...new Set(listeners.filter((row) => row.port >= range.from && row.port <= range.to).map((row) => row.port))].sort((a, b) => a - b);
      const size = range.to - range.from + 1;
      return { ...range, size, usedCount: used.length, freeCount: size - used.length, used, next: nextFreePort(range, file.config, listeners, recipes) };
    }),
    reserved: file.config.reserved.map((entry) => {
      const rows = listeners.filter((row) => row.port === entry.port);
      const taken = rows.find((row) => entry.match !== undefined && !matches(row, entry.match));
      return { ...entry, match: entry.match ?? null, state: taken ? "clash" as const : rows.length ? "listening" as const : "free" as const, by: rows.length ? owner(taken ?? rows[0]!) : null };
    }),
    clashes, file: { path: ".scout-data/ports.json", exists: file.exists, error: file.fileError }, generatedAt: at,
  };
}
