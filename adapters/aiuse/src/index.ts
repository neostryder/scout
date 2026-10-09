import type { Db, Probe, ProbeContext, ProbeOutputs, UsageAdapter, UsageResult, UsageSignalRecord } from "@scout/core";
import { PROBE_SCRIPT } from "./probe.ts";
import { cleanCheckpoint, type Checkpoint } from "./state.ts";

export type Agent = "claude" | "codex";
const AGENTS: Agent[] = ["claude", "codex"];
const KINDS = ["ai_use_7d", "ai_use_30d"];
const iso = (text: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text));
const count = (text: string): boolean => /^\d+$/.test(text) && Number.isSafeInteger(Number(text));

export function checkpointsFromOutputs(outputs: ProbeOutputs): Partial<Record<Agent, Checkpoint>> {
  const states: Partial<Record<Agent, Checkpoint>> = {};
  for (const agent of AGENTS) {
    const output = outputs[agent];
    if (!output || output.exitCode !== 0) continue;
    const line = output.stdout.trimEnd().split("\n").at(-1);
    if (!line?.startsWith("#checkpoint ")) continue;
    try {
      const raw = JSON.parse(line.slice(12));
      if (raw?.files && typeof raw.files === "object" && !Array.isArray(raw.files)) states[agent] = cleanCheckpoint(raw);
    } catch { continue; }
  }
  return states;
}

export function loadCheckpoints(db: Db, machineId: string): Partial<Record<Agent, Checkpoint>> {
  const states: Partial<Record<Agent, Checkpoint>> = {};
  const rows = db.prepare("SELECT agent, state_json FROM ai_use_checkpoints WHERE machine_id = ?").all(machineId) as { agent: string; state_json: string }[];
  for (const row of rows) {
    if (!AGENTS.includes(row.agent as Agent)) continue;
    try { states[row.agent as Agent] = cleanCheckpoint(JSON.parse(row.state_json)); } catch { continue; }
  }
  return states;
}

export function saveCheckpoints(db: Db, machineId: string, outputs: ProbeOutputs, now: string): void {
  const put = db.prepare("INSERT INTO ai_use_checkpoints (machine_id, agent, state_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(machine_id, agent) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at");
  for (const [agent, state] of Object.entries(checkpointsFromOutputs(outputs))) put.run(machineId, agent, JSON.stringify(state), now);
}

export function createAdapter(states: Partial<Record<Agent, Checkpoint>> = {}): UsageAdapter {
  return {
    origin: "ai-use",
    os: ["macos", "windows", "linux"],
    probes(ctx: ProbeContext): Probe[] {
      // The script is about 14 KB, and ssh from Windows fails on command lines past roughly 8 KB, so the script and the
      // checkpoint both travel on stdin and node reads the program from there.
      void ctx;
      return AGENTS.map((agent) => ({
        id: agent,
        argv: ["node", "--input-type=module", "-", agent],
        stdin: `globalThis.__SCOUT_STATE__ = ${JSON.stringify(JSON.stringify(cleanCheckpoint(states[agent])))};\n${PROBE_SCRIPT}`,
      }));
    },
    parse(outputs: ProbeOutputs): UsageResult {
      const tools = new Map<string, { count7: number; count30: number; lastSeen: string }>();
      let readable = 0;
      let partial = false;
      for (const agent of AGENTS) {
        const output = outputs[agent];
        if (!output || output.exitCode !== 0) { partial = true; continue; }
        readable++;
        for (const line of output.stdout.split("\n")) {
          if (line.trim() === "" || line.startsWith("#checkpoint ")) continue;
          const fields = line.trimEnd().split("\t");
          if (fields[0] === "#day") {
            if (fields.length !== 6 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(fields[1] ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(fields[2] ?? "") || !count(fields[3] ?? "") || !iso(fields[4] ?? "") || fields[5] !== agent) partial = true;
            continue;
          }
          if (fields.length !== 5 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(fields[0] ?? "") || !count(fields[1] ?? "") || !count(fields[2] ?? "") || Number(fields[1]) > Number(fields[2]) || !iso(fields[3] ?? "") || fields[4] !== agent) { partial = true; continue; }
          const name = fields[0]!.toLowerCase();
          const old = tools.get(name);
          const lastSeen = fields[3]!;
          tools.set(name, { count7: (old?.count7 ?? 0) + Number(fields[1]), count30: (old?.count30 ?? 0) + Number(fields[2]), lastSeen: old && old.lastSeen > lastSeen ? old.lastSeen : lastSeen });
        }
      }
      const signals: UsageSignalRecord[] = [];
      for (const [name, row] of [...tools].sort(([a], [b]) => a.localeCompare(b))) {
        for (const [kind, value] of [["ai_use_7d", String(row.count7)], ["ai_use_30d", String(row.count30)], ["ai_last_used", row.lastSeen]]) signals.push({ match: { name }, kind: kind!, value: value!, available: true });
      }
      if (readable === 0 && AGENTS.every((agent) => outputs[agent]?.exitCode === 127)) return { origin: "ai-use", status: "skipped", signals: [], message: "node is not installed on this machine" };
      if (readable === 0) return { origin: "ai-use", status: "failed", signals: [], message: "usage probes could not be read" };
      if (partial) return { origin: "ai-use", status: "partial", signals, message: "some usage output could not be read" };
      return { origin: "ai-use", status: "ok", signals, completeFor: KINDS };
    },
  };
}

export const adapter: UsageAdapter = createAdapter();
