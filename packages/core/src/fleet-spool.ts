import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePacket, type IncidentPacket } from "./fleet-packet.ts";

export const SPOOL_FILE = "packets.jsonl";

export interface Spool {
  append(packet: IncidentPacket): void;
  drain(send: (packet: IncidentPacket) => Promise<void>): Promise<{ sent: number; skipped: number; error: string | null }>;
  size(): number;
}

interface SpoolMeta { dropped: number; corrupt: number }

function encode(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function splitLines(raw: string): string[] {
  if (raw === "") return [];
  const lines = raw.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Node on Windows refuses to rename over a file that already exists.
function replaceFile(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
}

export function createSpool(options: { dir: string; maxBytes?: number; now?: () => Date }): Spool {
  const dir = options.dir;
  const maxBytes = options.maxBytes ?? 5_000_000;
  const now = options.now ?? ((): Date => new Date());
  const file = join(dir, SPOOL_FILE);
  const metaPath = join(dir, "spool-meta.json");
  mkdirSync(dir, { recursive: true });

  const readMeta = (): SpoolMeta => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
      if (!parsed || typeof parsed !== "object") return { dropped: 0, corrupt: 0 };
      const row = parsed as { dropped?: unknown; corrupt?: unknown };
      return {
        dropped: typeof row.dropped === "number" && row.dropped > 0 ? Math.floor(row.dropped) : 0,
        corrupt: typeof row.corrupt === "number" && row.corrupt > 0 ? Math.floor(row.corrupt) : 0,
      };
    } catch {
      return { dropped: 0, corrupt: 0 };
    }
  };

  const writeMeta = (meta: SpoolMeta): void => {
    replaceFile(metaPath, JSON.stringify({ ...meta, at: now().toISOString() }));
  };

  const readRaw = (): string => {
    try { return readFileSync(file, "utf8"); } catch { return ""; }
  };

  return {
    size(): number {
      try { return statSync(file).size; } catch { return 0; }
    },
    append(packet: IncidentPacket): void {
      const meta = readMeta();
      let next = packet;
      if (meta.dropped > 0) {
        next = { ...packet, evidence: { ...packet.evidence, snapshot: { ...packet.evidence.snapshot, spoolDropped: meta.dropped } } };
        meta.dropped = 0;
      }
      const lines = splitLines(readRaw());
      lines.push(JSON.stringify(next));
      while (Buffer.byteLength(encode(lines)) > maxBytes && lines.length > 1) {
        lines.shift();
        meta.dropped += 1;
      }
      replaceFile(file, encode(lines));
      writeMeta(meta);
    },
    async drain(send: (packet: IncidentPacket) => Promise<void>): Promise<{ sent: number; skipped: number; error: string | null }> {
      const original = readRaw();
      const lines = splitLines(original);
      const pending: string[] = [];
      let sent = 0;
      let skipped = 0;
      let error: string | null = null;
      let index = 0;
      for (; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.trim() === "") continue;
        let packet: IncidentPacket;
        try {
          const parsed: unknown = JSON.parse(line);
          const result = parsePacket(parsed);
          if (!result.ok) throw new Error(result.error);
          packet = result.packet;
        } catch {
          skipped += 1;
          continue;
        }
        try {
          await send(packet);
          sent += 1;
        } catch (err) {
          error = err instanceof Error ? err.message : "send failed";
          pending.push(line);
          for (let rest = index + 1; rest < lines.length; rest += 1) pending.push(lines[rest] ?? "");
          break;
        }
      }
      const current = readRaw();
      const extra = current.startsWith(original) ? splitLines(current.slice(original.length)) : [];
      replaceFile(file, encode([...pending, ...extra]));
      if (skipped > 0) {
        const meta = readMeta();
        meta.corrupt += skipped;
        writeMeta(meta);
      }
      return { sent, skipped, error };
    },
  };
}
