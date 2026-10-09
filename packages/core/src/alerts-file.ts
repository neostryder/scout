import { readFileSync, statSync } from "node:fs";
import type { AlertFile } from "./alerts.ts";

export function alertsFileReader(path: string): () => AlertFile {
  let stamp: string | null = null;
  let cached: AlertFile = { ungatedHosts: [], mute: [], at: null, fileError: null };
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      observed = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === observed) return cached;
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid alerts file");
      const { ungatedHosts = [], mute = [] } = data as Record<string, unknown>;
      if (!Array.isArray(ungatedHosts) || !ungatedHosts.every((host) => typeof host === "string" && host.length > 0 && host.length <= 253) || !Array.isArray(mute) || !mute.every((row) => row && typeof row.match === "string" && row.match.length > 0 && row.match.length <= 500 && typeof row.reason === "string" && row.reason.length <= 500)) throw new Error("invalid alerts file");
      cached = { ungatedHosts: ungatedHosts.map((host: string) => host.toLowerCase()), mute, at: stat.mtime.toISOString(), fileError: null };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      cached = { ungatedHosts: [], mute: [], at: null, fileError: missing ? null : "The alerts file is malformed or unreadable; file mutes were ignored." };
    }
    stamp = observed;
    return cached;
  };
}
