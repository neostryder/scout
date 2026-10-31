import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** One process from the machine's process table. `startedAt` is ISO or null when the table does not say. */
export interface ProcessRow { pid: number; parentPid: number; memBytes: number; startedAt: string | null; command: string }

export type ClaudeState = "waiting" | "running" | "idle";
/** Why a session has its state. `ask` and `plan` are a question or a plan waiting on a person; `survey` is a question set that was never answered. */
export type ClaudeReason = "ask" | "plan" | "survey" | "tool" | "prompt" | "thinking" | "turn-ended" | "interrupted" | "empty";

export interface ClaudeSession {
  /** The Claude Code session id: the transcript's file name. */
  id: string;
  title: string;
  cwd: string | null;
  state: ClaudeState;
  reason: ClaudeReason;
  /** The tool in flight when the state is running or waiting on a tool. */
  tool: string | null;
  /** Unanswered question sets the session left for a person, even while it is working on something else. */
  openSurveys: number;
  pid: number;
  startedAt: string | null;
  /** When the transcript last grew. */
  lastActivityAt: string | null;
  memBytes: number;
  /** The session's own process plus every process it started. */
  treeBytes: number;
}

export interface ClaudeSessionsResponse {
  available: boolean;
  at: string;
  sessions: ClaudeSession[];
  counts: Record<ClaudeState, number>;
}

export interface TailState { state: ClaudeState; reason: ClaudeReason; tool: string | null; title: string | null; cwd: string | null }

/** Tools that stop the session until a person answers. */
const ASK_TOOLS = new Map<string, ClaudeReason>([["AskUserQuestion", "ask"], ["ExitPlanMode", "plan"]]);
const SESSION_ARG = /--(?:resume|session-id)[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const TAIL_BYTES = 256 * 1024;
const WIDE_TAIL_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 3000;
const STATUS_EMOJI = /^(?:[⚙\u{1F64B}\u{1F9F5}\u{1F6D1}]️?\s*)+/u;

/** The session id in a Claude Code command line, or null when the process is not a session. */
export function sessionIdOf(command: string): string | null {
  if (!/claude(?:\.exe)?["']?\s/i.test(command) || !command.includes("--output-format")) return null;
  return SESSION_ARG.exec(command)?.[1] ?? null;
}

/** A session title without the status emoji the Claude app puts in front of it. */
export function plainTitle(title: string): string { return title.replace(STATUS_EMOJI, "").trim(); }

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; text?: string };
interface Entry { type?: string; isSidechain?: boolean; isMeta?: boolean; cwd?: string; customTitle?: string; message?: { content?: string | Block[] } }

const blocksOf = (entry: Entry): Block[] => {
  const content = entry.message?.content;
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
};

/**
 * Decides what a session is doing from the tail of its transcript, oldest line first. A tool call with no result yet is the signal: an
 * AskUserQuestion or ExitPlanMode in flight means a person is wanted, any other tool means the session is working. With nothing in flight,
 * the last message decides: the assistant's own text ends a turn, anything else means the next step is the model's.
 */
export function classifyTail(lines: string[]): TailState | null {
  const open = new Map<string, string>();
  let last: "assistant-text" | "assistant-thinking" | "user" | "interrupted" | null = null;
  let title: string | null = null;
  let cwd: string | null = null;
  for (const line of lines) {
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; } catch { continue; }
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") title = entry.customTitle;
    if (entry.isSidechain || entry.isMeta || (entry.type !== "assistant" && entry.type !== "user")) continue;
    if (typeof entry.cwd === "string") cwd = entry.cwd;
    const blocks = blocksOf(entry);
    if (entry.type === "assistant") {
      for (const block of blocks) if (block.type === "tool_use" && block.id) open.set(block.id, block.name ?? "tool");
      const tail = blocks[blocks.length - 1];
      if (!tail) continue;
      last = tail.type === "tool_use" ? last : tail.type === "text" ? "assistant-text" : "assistant-thinking";
    } else {
      for (const block of blocks) if (block.type === "tool_result" && block.tool_use_id) open.delete(block.tool_use_id);
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      last = text.startsWith("[Request interrupted by user") ? "interrupted" : "user";
    }
  }
  if (last === null && open.size === 0) return title === null && cwd === null ? null : { state: "idle", reason: "empty", tool: null, title, cwd };
  const names = [...open.values()];
  const ask = names.find((name) => ASK_TOOLS.has(name));
  if (ask) return { state: "waiting", reason: ASK_TOOLS.get(ask)!, tool: ask, title, cwd };
  if (names.length) return { state: "running", reason: "tool", tool: names[names.length - 1]!, title, cwd };
  if (last === "assistant-text") return { state: "idle", reason: "turn-ended", tool: null, title, cwd };
  if (last === "interrupted") return { state: "idle", reason: "interrupted", tool: null, title, cwd };
  return { state: "running", reason: last === "assistant-thinking" ? "thinking" : "prompt", tool: null, title, cwd };
}

/** Each process's own memory plus the memory of everything below it. */
export function treeMemory(rows: ProcessRow[]): Map<number, number> {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.parentPid, [...(children.get(row.parentPid) ?? []), row]);
  const total = new Map<number, number>();
  const sum = (row: ProcessRow, seen: Set<number>): number => {
    if (seen.has(row.pid)) return 0;
    seen.add(row.pid);
    let bytes = row.memBytes;
    for (const child of children.get(row.pid) ?? []) bytes += sum(child, seen);
    return bytes;
  };
  for (const row of rows) total.set(row.pid, sum(row, new Set()));
  return total;
}

const ORDER: Record<ClaudeState, number> = { waiting: 0, running: 1, idle: 2 };

/** Waiting sessions first, then running, then idle; the most recently active first inside each. */
export function sortSessions(sessions: ClaudeSession[]): ClaudeSession[] {
  return [...sessions].sort((a, b) => ORDER[a.state] - ORDER[b.state] || Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? "") || a.title.localeCompare(b.title));
}

const lastLines = async (path: string, bytes: number): Promise<{ lines: string[]; mtimeMs: number } | null> => {
  let handle;
  try {
    handle = await open(path, "r");
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    // A read that starts mid-file begins inside a line.
    if (size > length) lines.shift();
    return { lines: lines.filter((line) => line.trim()), mtimeMs };
  } catch { return null; } finally { await handle?.close().catch(() => undefined); }
};

export interface ClaudeMonitorOptions {
  /** The Claude configuration folder, normally ~/.claude. */
  claudeDir: string;
  /** The desktop app's per-account session records, which tie an app session to its Claude Code session id. Optional. */
  appSessionsDir?: string;
  listProcesses: () => Promise<ProcessRow[]>;
  now?: () => number;
}

interface Survey { sessionId: string; open: number }

/** Unanswered question sets, keyed by the desktop app's session id. */
async function surveys(dir: string): Promise<Survey[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const found: Survey[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      const record = JSON.parse(await readFile(join(dir, name), "utf8")) as { sessionId?: unknown; sets?: unknown };
      if (typeof record.sessionId === "string" && Array.isArray(record.sets) && record.sets.length) found.push({ sessionId: record.sessionId, open: record.sets.length });
    } catch { /* a file that is being written is read on the next pass */ }
  }
  return found;
}

/** The Claude Code session id of a desktop app session, read from the app's own record of it. */
async function cliIdOf(appDir: string, appSessionId: string): Promise<string | null> {
  const file = `${appSessionId.replace(/^local-/, "local_")}.json`;
  let accounts: string[];
  try { accounts = await readdir(appDir); } catch { return null; }
  for (const account of accounts) {
    let spaces: string[];
    try { spaces = await readdir(join(appDir, account)); } catch { continue; }
    for (const space of spaces) {
      try {
        const record = JSON.parse(await readFile(join(appDir, account, space, file), "utf8")) as { cliSessionId?: unknown };
        if (typeof record.cliSessionId === "string") return record.cliSessionId;
      } catch { /* not in this folder */ }
    }
  }
  return null;
}

/** Reads the Claude Code sessions running on this machine. Reads share one result for a few seconds, so several open pages cost one pass. */
export class ClaudeMonitor {
  private cached: { at: number; value: Promise<ClaudeSessionsResponse> } | null = null;
  private transcripts = new Map<string, string>();

  private readonly options: ClaudeMonitorOptions;

  constructor(options: ClaudeMonitorOptions) { this.options = options; }

  read(): Promise<ClaudeSessionsResponse> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    const value = this.collect(now);
    this.cached = { at: now, value };
    value.catch(() => { if (this.cached?.value === value) this.cached = null; });
    return value;
  }

  private async transcriptPath(id: string): Promise<string | null> {
    const known = this.transcripts.get(id);
    if (known) return known;
    const projects = join(this.options.claudeDir, "projects");
    let folders: string[];
    try { folders = await readdir(projects); } catch { return null; }
    for (const folder of folders) {
      const path = join(projects, folder, `${id}.jsonl`);
      try { await stat(path); this.transcripts.set(id, path); return path; } catch { /* not here */ }
    }
    return null;
  }

  private async collect(now: number): Promise<ClaudeSessionsResponse> {
    const rows = await this.options.listProcesses();
    const memory = treeMemory(rows);
    const processes = new Map<string, ProcessRow>();
    for (const row of rows) {
      const id = sessionIdOf(row.command);
      if (id && !processes.has(id)) processes.set(id, row);
    }
    const open = new Map<string, number>();
    const appDir = this.options.appSessionsDir;
    for (const survey of await surveys(join(this.options.claudeDir, "state", "pending-asks"))) {
      const cli = appDir ? await cliIdOf(appDir, survey.sessionId) : null;
      if (cli) open.set(cli, (open.get(cli) ?? 0) + survey.open);
    }
    const sessions: ClaudeSession[] = [];
    for (const [id, row] of processes) {
      const path = await this.transcriptPath(id);
      let tail = path ? await lastLines(path, TAIL_BYTES) : null;
      let state = tail ? classifyTail(tail.lines) : null;
      if (path && tail && !state) { tail = await lastLines(path, WIDE_TAIL_BYTES); state = tail ? classifyTail(tail.lines) : null; }
      const surveysOpen = open.get(id) ?? 0;
      const base: TailState = state ?? { state: "idle", reason: "empty", tool: null, title: null, cwd: null };
      const waitingOnSurvey = base.state === "idle" && surveysOpen > 0;
      sessions.push({
        id,
        title: plainTitle(base.title ?? "") || `Session ${id.slice(0, 8)}`,
        cwd: base.cwd,
        state: waitingOnSurvey ? "waiting" : base.state,
        reason: waitingOnSurvey ? "survey" : base.reason,
        tool: base.tool,
        openSurveys: surveysOpen,
        pid: row.pid,
        startedAt: row.startedAt,
        lastActivityAt: tail ? new Date(tail.mtimeMs).toISOString() : null,
        memBytes: row.memBytes,
        treeBytes: memory.get(row.pid) ?? row.memBytes,
      });
    }
    const sorted = sortSessions(sessions);
    return {
      available: true,
      at: new Date(now).toISOString(),
      sessions: sorted,
      counts: { waiting: sorted.filter((s) => s.state === "waiting").length, running: sorted.filter((s) => s.state === "running").length, idle: sorted.filter((s) => s.state === "idle").length },
    };
  }
}
