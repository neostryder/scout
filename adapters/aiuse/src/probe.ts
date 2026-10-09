import { toolName, commandWords, commandTools, transcriptTools } from "./commands.ts";
import { cleanCheckpoint, aggregateDays } from "./state.ts";

const READER = `
let raw = globalThis.__SCOUT_STATE__ ?? "";
if (raw === "") for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw); } catch { input = {}; }
const state = cleanCheckpoint(input);
const agent = process.argv.at(-1);
const root = join(homedir(), agent === "claude" ? ".claude/projects" : ".codex/sessions");
const hash = (text, length = 24) => createHash("sha256").update(text).digest("hex").slice(0, length);
let partial = false;
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") partial = true; return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && (agent === "claude" || entry.name.startsWith("rollout-"))) read(path);
  }
}
function read(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const pathHash = hash(relative(root, path).split(sep).join("/"));
    const id = hash(pathHash + ":" + stat.dev + ":" + stat.ino);
    const prefix = Buffer.alloc(Math.min(64, stat.size));
    readSync(fd, prefix, 0, prefix.length, 0);
    const old = state.files[id];
    const resume = old && stat.size >= old.size && hash(prefix.subarray(0, old.prefixLength), 64) === old.prefixHash;
    const days = resume ? old.days.map((day) => ({ ...day })) : [];
    let offset = resume ? old.offset : 0;
    let pending = Buffer.alloc(0);
    let position = offset;
    while (position < stat.size) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size - position));
      const got = readSync(fd, buffer, 0, buffer.length, position);
      if (got === 0) break;
      position += got;
      pending = Buffer.concat([pending, buffer.subarray(0, got)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const parsed = transcriptTools(pending.subarray(0, end).toString("utf8"), agent);
        if (parsed) for (const rawTool of parsed.tools) {
          const tool = rawTool.toLowerCase();
          const date = parsed.timestamp.slice(0, 10);
          const day = days.find((d) => d.tool === tool && d.date === date);
          if (day) { day.count++; if (parsed.timestamp > day.lastSeen) day.lastSeen = parsed.timestamp; }
          else days.push({ tool, date, count: 1, lastSeen: parsed.timestamp });
        }
        offset += end + 1;
        pending = pending.subarray(end + 1);
      }
      // A corrupt line cannot require an unbounded allocation.
      if (pending.length > 8 * 1024 * 1024) { partial = true; return; }
    }
    for (const [other, file] of Object.entries(state.files)) if (other !== id && file.pathHash === pathHash) delete state.files[other];
    state.files[id] = { pathHash, size: stat.size, offset, prefixLength: prefix.length, prefixHash: hash(prefix, 64), days };
  } catch { partial = true; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { partial = true; } }
}
walk(root);
const now = new Date().toISOString();
const cutoff = new Date(Date.parse(now.slice(0, 10) + "T00:00:00Z") - 29 * 86400000).toISOString().slice(0, 10);
for (const file of Object.values(state.files)) {
  const latest = new Map();
  for (const day of file.days) if (!latest.has(day.tool) || latest.get(day.tool).date < day.date) latest.set(day.tool, day);
  file.days = file.days.filter((day) => day.date >= cutoff || latest.get(day.tool) === day);
}
for (const row of aggregateDays(state, now)) {
  console.log([row.tool, row.count7, row.count30, row.lastSeen, agent].join("\\t"));
  for (const day of row.days) console.log(["#day", day.tool, day.date, day.count, day.lastSeen, agent].join("\\t"));
}
if (partial) console.log("#partial");
console.log("#checkpoint " + JSON.stringify(state));
`;

// The runtime strips types before serializing these same functions for the remote probe.
export const PROBE_SCRIPT = [
  'import { readdirSync, openSync, readSync, fstatSync, closeSync } from "node:fs";',
  'import { homedir } from "node:os";',
  'import { join, relative, sep } from "node:path";',
  'import { createHash } from "node:crypto";',
  ...[toolName, commandWords, commandTools, transcriptTools, cleanCheckpoint, aggregateDays].map((fn) => fn.toString()),
  READER,
].join("\n");
