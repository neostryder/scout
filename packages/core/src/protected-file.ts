import { readFileSync, statSync } from "node:fs";
import { PROTECTED_GROUPS, type ProtectedConfig } from "./protected.ts";

export interface ProtectedFile { config: ProtectedConfig; fileError: string | null }

export function protectedFileReader(path: string): () => ProtectedFile {
  let stamp: string | null = null;
  let cached: ProtectedFile = { config: { disable: [], names: [] }, fileError: null };
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      const next = `${stat.mtimeMs}:${stat.size}`;
      observed = next;
      if (stamp === next) return cached;
      stamp = next;
      const data = JSON.parse(readFileSync(path, "utf8")) as Partial<ProtectedConfig> | null;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid protected file");
      const disable = data.disable === undefined ? [] : data.disable;
      const names = data.names === undefined ? [] : data.names;
      if (!Array.isArray(disable) || !disable.every((v) => typeof v === "string") || !Array.isArray(names) || !names.every((v) => v && typeof v.machine === "string" && v.machine.length > 0 && v.machine.length <= 200 && typeof v.match === "string" && v.match.length > 0 && v.match.length <= 500 && typeof v.reason === "string" && v.reason.length > 0 && v.reason.length <= 500)) throw new Error("invalid protected file");
      cached = { config: { disable, names }, fileError: null };
    } catch {
      stamp = observed;
      cached = { config: { disable: [], names: [] }, fileError: "The protected file is missing or malformed; built-in protection remains enabled." };
    }
    return cached;
  };
}

export function protectedResponse(file: ProtectedFile, at = new Date().toISOString()): unknown {
  return { groups: PROTECTED_GROUPS.map((row) => ({ ...row, builtIn: true, enabled: row.alwaysOn || !file.config.disable.includes(row.id) })), custom: file.config.names, file: ".scout-data/protected.json", fileError: file.fileError, generatedAt: at };
}
