import { h } from "./lib.js";
import { folderText, groups, isQuiet, memoryText, openText, pollMs, reasonText, sinceText, stateWord, summaryText } from "./claude-model.js";

/** The Claude view: every Claude Code session running on the hub machine, grouped by whether it waits on you, is working, or is idle. */
export function createClaudeView(root) {
  let reply = null;
  let error = "";
  let timer = null;
  let controller = null;
  let visible = false;
  const status = h("p", { class: "claude-status", role: "status" }, "Reading the sessions.");
  const summary = h("p", { class: "claude-summary", "aria-live": "polite" });
  const list = h("div", { class: "claude-groups" });
  root.classList.add("claude");
  root.replaceChildren(h("header", { class: "claude-head" }, h("h1", {}, "Claude"), summary), status, list);

  function row(session, now) {
    const quiet = isQuiet(session, now);
    return h("li", { class: `claude-row state-${session.state}`, "data-id": session.id },
      h("span", { class: "claude-chip" }, h("span", { class: "claude-dot", "aria-hidden": "true" }), stateWord(session.state)),
      h("span", { class: "claude-name" },
        h("span", { class: "claude-title" }, session.title),
        h("span", { class: "claude-reason" }, reasonText(session)),
        // A session waiting on its own question has that question as its open set, so only a working or idle one gets the second line.
        session.openSurveys && !["survey", "ask", "plan"].includes(session.reason) ? h("span", { class: "claude-note" }, session.openSurveys === 1 ? "Also left a question set unanswered" : `Also left ${session.openSurveys} question sets unanswered`) : [],
        quiet ? h("span", { class: "claude-note quiet" }, "Running with no output for a while. It may be stuck.") : [],
        session.cwd ? h("span", { class: "claude-folder", title: session.cwd }, folderText(session.cwd)) : []),
      h("span", { class: `claude-since${quiet ? " quiet" : ""}` }, sinceText(session, now)),
      h("span", { class: "claude-open" }, openText(session, now)),
      h("span", { class: "claude-mem" }, memoryText(session)));
  }

  function paint() {
    const now = Date.now();
    status.hidden = !!reply && !error;
    status.textContent = error || "Reading the sessions.";
    summary.textContent = reply ? summaryText(reply) : "";
    list.replaceChildren(...(reply ? groups(reply.sessions) : []).map((group) =>
      h("section", { class: `claude-group state-${group.state}`, "aria-label": group.word },
        h("header", {}, h("h2", {}, group.word), h("span", { class: "claude-count" }, String(group.sessions.length)), h("p", {}, group.help)),
        h("ul", {}, group.sessions.map((session) => row(session, now))))));
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    try {
      const response = await fetch("/api/claude", { signal: mine.signal });
      if (!response.ok) throw new Error(response.status === 404 ? "This hub does not report Claude sessions. Update the hub, or start it without --no-claude." : ((await response.json().catch(() => ({}))).error ?? `The hub answered ${response.status}.`));
      reply = await response.json();
      error = "";
    } catch (cause) {
      if (cause?.name === "AbortError") return;
      error = cause instanceof Error && cause.message ? cause.message : "The hub could not be reached.";
    }
    paint();
  }

  function schedule() {
    clearTimeout(timer);
    if (!visible) return;
    timer = setTimeout(async () => { if (!document.hidden) await load(); schedule(); }, pollMs());
  }

  document.addEventListener("visibilitychange", () => { if (visible && !document.hidden) load().then(schedule); });

  return {
    show() { visible = true; root.hidden = false; paint(); load().then(schedule); },
    hide() { visible = false; clearTimeout(timer); controller?.abort(); root.hidden = true; },
  };
}
