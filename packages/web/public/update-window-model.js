// What the update-window panel says, kept apart from the page so it can be tested without a browser.

const pad = (value) => String(value).padStart(2, "0");

const clock = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** "03:30 to 05:30". */
export function windowRange(quiet) {
  return `${clock(quiet.startMinute)} to ${clock(quiet.startMinute + quiet.lengthMinutes)}`;
}

/** "now", "today at 3:30 AM", "tomorrow at 3:30 AM", or a weekday, in the viewer's clock. */
export function startLabel(quiet, now = new Date()) {
  if (quiet.inWindow) return "now";
  const start = new Date(quiet.startsAt);
  const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(start) - midnight(now)) / 86_400_000);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : start.toLocaleDateString(undefined, { weekday: "long" });
  return `${day} at ${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function quietWindowNote(quiet, now = new Date()) {
  return `The quiet window is ${windowRange(quiet)}. ${quiet.inWindow ? "It is under way." : `It next starts ${startLabel(quiet, now)}.`}`;
}

/** What the automatic switch does and when it last did it. */
export function autoRunNote(autoRun, quiet) {
  if (!autoRun) return "";
  if (!autoRun.enabled && autoRun.pausedReason) return `Automatic running paused itself after a failure: ${autoRun.pausedReason}. Look at the Jobs page, then turn it back on to resume.`;
  if (!autoRun.enabled) return `Automatic running is off. Turn it on and Scout queues the first two lists at the start of the quiet window, ${windowRange(quiet)}.`;
  const last = autoRun.lastRunAt ? ` The last run queued ${autoRun.lastQueued} ${autoRun.lastQueued === 1 ? "update" : "updates"} on ${new Date(autoRun.lastRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` : " It has not run yet.";
  const left = autoRun.lastDeferred > 0 ? ` ${autoRun.lastDeferred} ${autoRun.lastDeferred === 1 ? "update was" : "updates were"} left for the next window because a machine had more than ${autoRun.cap ?? 15} to run.` : "";
  return `Automatic running is on. At the start of the quiet window Scout queues up to ${autoRun.cap ?? 15} updates per machine from the first two lists, which includes updates that close or restart a running program. A failed update switches it off.${last}${left}`;
}

export function itemLine(item) {
  return `${item.name}: ${item.from || "unknown"} to ${item.to || "unknown"}`;
}

const HELD_WORDS = { blocked: "Blocked", admin: "Needs the administrator prompt", confirm: "Needs a check" };
export function heldLine(item) {
  return `${itemLine(item)} (${HELD_WORDS[item.kind] || "Held"}: ${item.reason})`;
}

/** The groups one machine's panel shows, each with the install ids its button reviews. Empty groups are left out. */
export function machineGroups(machine, quiet, now = new Date()) {
  const groups = [];
  if (machine.now.length) {
    groups.push({ key: "now", heading: `Safe to start now (${machine.now.length})`, note: "They run in this order, so what a program uses is updated before the program.", items: machine.now.map(itemLine), ids: machine.now.map((item) => item.installId), button: `Review ${machine.now.length} ${machine.now.length === 1 ? "update" : "updates"}` });
  }
  if (machine.atQuietHour.length) {
    const under = quiet.inWindow;
    groups.push({ key: "quiet", heading: `${under ? "The quiet window is under way" : `Better in the quiet window, ${startLabel(quiet, now)}`} (${machine.atQuietHour.length})`, note: "These close or restart a running program, or share a library with one, so they go together.", items: machine.atQuietHour.map((item) => `${itemLine(item)}${item.running ? " (running now)" : ""}`), ids: machine.atQuietHour.map((item) => item.installId), button: under ? `Review ${machine.atQuietHour.length} ${machine.atQuietHour.length === 1 ? "update" : "updates"}` : "Review them now anyway" });
  }
  if (machine.held.length) {
    groups.push({ key: "held", heading: `Needs you first (${machine.held.length})`, note: "Scout leaves these out of both batches.", items: machine.held.map(heldLine), ids: [], button: null });
  }
  return groups;
}

/** How many updates across all machines can start now, for the button label. */
export function safeNowCount(windows) {
  return (windows?.machines || []).reduce((sum, machine) => sum + machine.now.length, 0);
}
