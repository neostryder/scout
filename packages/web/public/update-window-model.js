// What the update-window panel says, kept apart from the page so it can be tested without a browser.

const pad = (value) => String(value).padStart(2, "0");

export function hourRange(quiet) {
  return `${pad(quiet.hour)}:00 to ${pad((quiet.hour + quiet.length) % 24)}:00`;
}

/** "now", "today at 3:00 AM", "tomorrow at 3:00 AM", or a weekday, in the viewer's clock. */
export function startLabel(quiet, now = new Date()) {
  if (quiet.inWindow) return "now";
  const start = new Date(quiet.startsAt);
  const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(start) - midnight(now)) / 86_400_000);
  const day = days <= 0 ? "today" : days === 1 ? "tomorrow" : start.toLocaleDateString(undefined, { weekday: "long" });
  return `${day} at ${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function quietHourNote(quiet, now = new Date()) {
  const basis = quiet.basis === "measured"
    ? `the least busy stretch in the last 7 days, averaging ${quiet.meanCpuPct}% CPU`
    : "a night-time default, because there is not enough load history to measure yet";
  return `Quiet hours ${hourRange(quiet)}: ${basis}. ${quiet.inWindow ? "They are under way." : `Next start ${startLabel(quiet, now)}.`}`;
}

export function itemLine(item) {
  return `${item.name}: ${item.from || "unknown"} to ${item.to || "unknown"}`;
}

const HELD_WORDS = { blocked: "Blocked", admin: "Needs the administrator prompt", confirm: "Needs a check" };
export function heldLine(item) {
  return `${itemLine(item)} (${HELD_WORDS[item.kind] || "Held"}: ${item.reason})`;
}

/** The groups one machine's panel shows, each with the install ids its button reviews. Empty groups are left out. */
export function machineGroups(machine, now = new Date()) {
  const groups = [];
  if (machine.now.length) {
    groups.push({ key: "now", heading: `Safe to start now (${machine.now.length})`, note: "They run in this order, so what a program uses is updated before the program.", items: machine.now.map(itemLine), ids: machine.now.map((item) => item.installId), button: `Review ${machine.now.length} ${machine.now.length === 1 ? "update" : "updates"}` });
  }
  if (machine.atQuietHour.length) {
    const under = machine.quietHour.inWindow;
    groups.push({ key: "quiet", heading: `${under ? "Quiet hours are under way" : `Better in the quiet hours, ${startLabel(machine.quietHour, now)}`} (${machine.atQuietHour.length})`, note: "These close or restart a running program, or share a library with one, so they go together.", items: machine.atQuietHour.map((item) => `${itemLine(item)}${item.running ? " (running now)" : ""}`), ids: machine.atQuietHour.map((item) => item.installId), button: under ? `Review ${machine.atQuietHour.length} ${machine.atQuietHour.length === 1 ? "update" : "updates"}` : "Review them now anyway" });
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
