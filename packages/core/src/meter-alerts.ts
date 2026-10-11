import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MeterSample } from "./meters.ts";
import type { OutageNotice } from "./outages.ts";

// `.scout-data/meter-alerts.json` holds the three quiet meter alerts: a disk getting full, memory under pressure, and video memory nearly used up.
// A missing file means the defaults. The Resources page writes this file; it can be edited by hand too.

export type MeterAlertKind = "disk" | "memory" | "vram";

export interface MeterAlertRule {
  enabled: boolean;
  /** The meter must reach this percentage. */
  pct: number;
  /** ...and stay there for this many minutes before anything is sent. */
  minutes: number;
}

export interface MeterAlertSettings {
  disk: MeterAlertRule;
  memory: MeterAlertRule;
  vram: MeterAlertRule;
  fileError: string | null;
}

/** An alert clears once the meter drops this many points under its threshold, so a reading that hovers does not send a notice each time. */
export const CLEAR_MARGIN_PCT = 5;

export const DEFAULT_METER_ALERTS: MeterAlertSettings = {
  disk: { enabled: true, pct: 90, minutes: 5 },
  memory: { enabled: true, pct: 92, minutes: 10 },
  vram: { enabled: true, pct: 95, minutes: 10 },
  fileError: null,
};

export function defaultMeterAlerts(): MeterAlertSettings {
  return { disk: { ...DEFAULT_METER_ALERTS.disk }, memory: { ...DEFAULT_METER_ALERTS.memory }, vram: { ...DEFAULT_METER_ALERTS.vram }, fileError: null };
}

const KINDS: MeterAlertKind[] = ["disk", "memory", "vram"];

function parseRule(value: unknown, name: MeterAlertKind, base: MeterAlertRule): MeterAlertRule {
  if (value === undefined) return { ...base };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const { enabled = base.enabled, pct = base.pct, minutes = base.minutes, ...rest } = value as Record<string, unknown>;
  for (const key of Object.keys(rest)) throw new Error(`unknown field ${name}.${key}`);
  if (typeof enabled !== "boolean") throw new Error(`${name}.enabled must be true or false`);
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 50 || pct > 100) throw new Error(`${name}.pct must be a number from 50 to 100`);
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error(`${name}.minutes must be a whole number from 0 to 1440`);
  return { enabled, pct, minutes };
}

/** Checks a parsed file or a page edit, filling anything missing from `base`; throws on anything malformed. */
export function parseMeterAlerts(data: unknown, base: MeterAlertSettings = DEFAULT_METER_ALERTS): MeterAlertSettings {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid meter alerts file");
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!KINDS.includes(key as MeterAlertKind)) throw new Error(`unknown field ${key}`);
  return { disk: parseRule(record["disk"], "disk", base.disk), memory: parseRule(record["memory"], "memory", base.memory), vram: parseRule(record["vram"], "vram", base.vram), fileError: null };
}

export function meterAlertsFileReader(path: string): () => MeterAlertSettings {
  let stamp: string | null = null;
  let cached = defaultMeterAlerts();
  return () => {
    let observed: string | null = null;
    try {
      const stat = statSync(path);
      observed = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === observed) return cached;
      cached = parseMeterAlerts(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      cached = { ...defaultMeterAlerts(), fileError: missing ? null : "The meter alerts file is malformed or unreadable; the defaults apply until it is fixed." };
    }
    stamp = observed;
    return cached;
  };
}

/** Applies a page edit to the file and returns the new settings. The edit may name only the rules it changes. Writes atomically. */
export function updateMeterAlertsFile(path: string, current: MeterAlertSettings, body: unknown): MeterAlertSettings {
  const next = parseMeterAlerts(body, current);
  const out = { disk: next.disk, memory: next.memory, vram: next.vram };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return next;
}

export interface ActiveMeterAlert { key: string; machineId: string; kind: MeterAlertKind; label: string; pct: number; since: string }

interface Track { since: number | null; raised: boolean; raisedAt: number | null; pct: number; label: string; machineId: string; kind: MeterAlertKind }

const percent = (used: number | null, total: number | null): number | null => (used === null || total === null || total <= 0 ? null : Math.min(100, Math.max(0, used / total * 100)));

/** The meters an alert watches in one sample: each disk by mount, memory, and each graphics card's video memory. */
function watched(sample: MeterSample): { key: string; kind: MeterAlertKind; label: string; pct: number }[] {
  const out: { key: string; kind: MeterAlertKind; label: string; pct: number }[] = [];
  for (const disk of sample.disks) {
    const pct = percent(disk.usedBytes, disk.totalBytes);
    if (pct !== null) out.push({ key: `disk:${disk.mount}`, kind: "disk", label: `disk ${disk.mount}`, pct });
  }
  const memory = percent(sample.memUsedBytes, sample.memTotalBytes);
  if (memory !== null) out.push({ key: "memory", kind: "memory", label: "memory", pct: memory });
  sample.gpus.forEach((gpu, index) => {
    const pct = percent(gpu.vramUsedBytes, gpu.vramTotalBytes);
    if (pct !== null) out.push({ key: `vram:${index}`, kind: "vram", label: sample.gpus.length > 1 ? `video memory on ${gpu.name}` : "video memory", pct });
  });
  return out;
}

const minutesText = (ms: number): string => { const minutes = Math.max(1, Math.round(ms / 60_000)); return minutes === 1 ? "1 minute" : minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`; };

/**
 * Turns meter readings into quiet notices: one when a meter has stayed at or over its threshold for the rule's minutes, and one when it falls
 * back under. State is kept in memory, so a hub restart starts the count again and a meter that is still over its threshold alerts a second time.
 */
export class MeterAlertTracker {
  private tracks = new Map<string, Track>();

  evaluate(samples: MeterSample[], names: ReadonlyMap<string, string>, settings: MeterAlertSettings, nowMs: number, staleAfterMs = 150_000): OutageNotice[] {
    const notices: OutageNotice[] = [];
    const seen = new Set<string>();
    for (const sample of samples) {
      if (nowMs - Date.parse(sample.at) > staleAfterMs) continue;
      const machine = names.get(sample.machineId) ?? sample.machineId;
      for (const meter of watched(sample)) {
        const key = `${sample.machineId}|${meter.key}`;
        const rule = settings[meter.kind];
        seen.add(key);
        const track = this.tracks.get(key) ?? { since: null, raised: false, raisedAt: null, pct: meter.pct, label: meter.label, machineId: sample.machineId, kind: meter.kind };
        this.tracks.set(key, track);
        track.pct = meter.pct;
        track.label = meter.label;
        if (!rule.enabled) { if (track.raised) notices.push(this.clear(track, machine, rule, nowMs, true)); this.reset(track); continue; }
        if (meter.pct >= rule.pct) {
          track.since ??= nowMs;
          if (!track.raised && nowMs - track.since >= rule.minutes * 60_000) {
            track.raised = true;
            track.raisedAt = nowMs;
            notices.push({ title: `${machine}: ${meter.label} is at ${Math.round(meter.pct)}%`, body: `${capital(meter.label)} on ${machine} has been at or over ${rule.pct}% for ${minutesText(nowMs - track.since)}.`, severity: "high" });
          }
        } else if (meter.pct <= rule.pct - CLEAR_MARGIN_PCT) {
          if (track.raised) notices.push(this.clear(track, machine, rule, nowMs, false));
          this.reset(track);
        } else if (!track.raised) {
          track.since = null;
        }
      }
    }
    // A meter that is no longer reported (a disk that was unmounted) drops its state without a notice.
    for (const key of [...this.tracks.keys()]) if (!seen.has(key) && !this.tracks.get(key)!.raised) this.tracks.delete(key);
    return notices;
  }

  /** The alerts raised now and not yet cleared, for the page. */
  active(): ActiveMeterAlert[] {
    return [...this.tracks.entries()].filter(([, track]) => track.raised).map(([key, track]) => ({ key, machineId: track.machineId, kind: track.kind, label: track.label, pct: Math.round(track.pct), since: new Date(track.raisedAt ?? 0).toISOString() }));
  }

  private reset(track: Track): void { track.since = null; track.raised = false; track.raisedAt = null; }

  private clear(track: Track, machine: string, rule: MeterAlertRule, nowMs: number, turnedOff: boolean): OutageNotice {
    const length = minutesText(nowMs - (track.raisedAt ?? nowMs));
    return { title: `${machine}: ${track.label} is back to normal`, body: turnedOff ? `${capital(track.label)} on ${machine} is no longer watched, after ${length} over ${rule.pct}%.` : `${capital(track.label)} on ${machine} is at ${Math.round(track.pct)}%, after ${length} at or over ${rule.pct}%.`, severity: "info" };
  }
}

function capital(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }
