// Pure helpers for the Claude view: the words for a session's state, the lines under its title, and the groups the page draws.
import { bytesText } from "./resources-model.js";

/** A running session that has written nothing for this many minutes is called out, since a working session writes often. */
export const QUIET_MINUTES = 15;

const STATE_WORD = { waiting: "Waiting on you", running: "Running", idle: "Idle" };
const GROUP_HELP = {
  waiting: "These stopped to ask you something and will not move until you answer.",
  running: "These are working now.",
  idle: "These finished their last turn and are waiting for a new message.",
};

export const stateWord = (state) => STATE_WORD[state] ?? "Unknown";

/** What the session is doing, in a short plain line. */
export function reasonText(session) {
  switch (session.reason) {
    case "ask": return "Asking you a question";
    case "plan": return "A plan is waiting for your approval";
    case "survey": return session.openSurveys === 1 ? "Left a question set unanswered" : `Left ${session.openSurveys} question sets unanswered`;
    case "tool": return session.tool ? `Running ${session.tool}` : "Running a tool";
    case "prompt": return "Working on your last message";
    case "thinking": return "Thinking";
    case "interrupted": return "Stopped before it finished";
    case "turn-ended": return "Finished its turn";
    default: return "No transcript yet";
  }
}

function span(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} days`;
}

/** How long ago the transcript last grew. */
export function sinceText(session, now) {
  const at = Date.parse(session.lastActivityAt ?? "");
  if (!Number.isFinite(at)) return "No output yet";
  const ms = Math.max(0, now - at);
  return ms < 60_000 ? "Output just now" : `Last output ${span(ms)} ago`;
}

/** How long the session's process has been up. */
export function openText(session, now) {
  const at = Date.parse(session.startedAt ?? "");
  return Number.isFinite(at) ? `Open ${span(Math.max(0, now - at))}` : "Open time unknown";
}

export function isQuiet(session, now) {
  const at = Date.parse(session.lastActivityAt ?? "");
  return session.state === "running" && Number.isFinite(at) && now - at >= QUIET_MINUTES * 60_000;
}

/** The memory of the session and the tools it started, with the session's own share when the two differ much. */
export function memoryText(session) {
  const whole = bytesText(session.treeBytes);
  return session.treeBytes - session.memBytes >= 100 * 1_048_576 ? `${whole} (${bytesText(session.memBytes)} itself)` : whole;
}

/** The non-empty groups in display order. */
export function groups(sessions) {
  return ["waiting", "running", "idle"]
    .map((state) => ({ state, word: STATE_WORD[state], help: GROUP_HELP[state], sessions: sessions.filter((session) => session.state === state) }))
    .filter((group) => group.sessions.length);
}

export function summaryText(reply) {
  const { waiting, running, idle } = reply.counts;
  if (!reply.sessions.length) return "No Claude Code session is running on this machine.";
  const total = reply.sessions.reduce((sum, session) => sum + session.treeBytes, 0);
  return `${waiting} waiting on you, ${running} running, ${idle} idle. ${bytesText(total)} in use.`;
}

export const pollMs = () => 10_000;

/** The folder name of a working directory, for the small line under a title. */
export function folderText(cwd) {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}
