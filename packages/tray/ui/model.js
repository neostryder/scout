// The panel's logic with no DOM in it, so it can be tested on its own.

export const STATE_ORDER = ["down", "changed", "up", "stopped", "unknown"];

export function fill(template, vars = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/** "3m ago" style text for a past ISO time; the panel only needs coarse steps. */
export function ago(iso, now = Date.now()) {
  const then = Date.parse(iso ?? "");
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Header counts: how many rows are down and how many changed, across every tab. */
export function totals(snapshot) {
  const sum = { down: 0, changed: 0 };
  for (const machine of snapshot?.machines ?? []) {
    sum.down += machine.counts?.down ?? 0;
    sum.changed += machine.counts?.changed ?? 0;
  }
  return sum;
}

export function hiddenTotal(snapshot) {
  return (snapshot?.machines ?? []).reduce((n, m) => n + (m.hidden ?? 0), 0);
}

/** Tabs in the order the hub sent them, the Stacks tab last, and a tab that is unreachable keeps its place. */
export function tabs(snapshot) {
  const list = [...(snapshot?.machines ?? [])];
  return list.sort((a, b) => (a.id === "stacks") - (b.id === "stacks"));
}

export function pickTab(snapshot, wanted) {
  const list = tabs(snapshot);
  if (list.some((m) => m.id === wanted)) return wanted;
  // First open: the tab that most needs a look, or the first one.
  const worst = list.find((m) => m.worst === "down") ?? list.find((m) => m.worst === "changed") ?? list[0];
  return worst?.id ?? null;
}

export const CHIPS = ["all", "down", "mine"];

export function visibleRows(machine, { query = "", chip = "all" } = {}) {
  const needle = query.trim().toLowerCase();
  return (machine?.rows ?? []).filter((row) => {
    if (chip === "down" && row.state !== "down" && row.state !== "changed") return false;
    if (chip === "mine" && !row.mine) return false;
    if (!needle) return true;
    return `${row.label} ${row.name} ${row.detail ?? ""} ${row.port ?? ""}`.toLowerCase().includes(needle);
  });
}

/** What a row offers: Start when it is stopped, Stop and Restart when it runs, each only when the hub says it is available. */
export function rowActions(row) {
  const byName = new Map((row.actions ?? []).map((a) => [a.action, a]));
  const shown = row.state === "up" || row.state === "changed" ? ["restart", "stop"] : ["start"];
  return shown.map((name) => ({ action: name, available: byName.get(name)?.available === true, reason: byName.get(name)?.reason ?? null }));
}

/** Stop, Restart, and Disable ask first; Start and Enable do not. */
export const needsConfirm = (action) => action === "stop" || action === "restart" || action === "disable";

/** The body for POST /api/services/actions/plan. */
export function planBody(row, action) {
  if (row.target === "stack") return { target: "stack", name: row.name, action };
  return { target: row.target, id: row.id, action };
}

/** A sparkline as separate polyline point strings, one per run of samples, so a missed check leaves a gap. Values are response times; lower is drawn lower. */
export function sparkRuns(values, width = 46, height = 14) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const numbers = values.filter((v) => typeof v === "number");
  if (numbers.length < 2) return [];
  const lo = Math.min(...numbers);
  const hi = Math.max(...numbers);
  const span = hi - lo || 1;
  const step = width / (values.length - 1);
  const runs = [];
  let run = [];
  values.forEach((v, i) => {
    if (typeof v !== "number") {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    const y = hi === lo ? height / 2 : height - 1 - ((v - lo) / span) * (height - 2);
    run.push(`${(i * step).toFixed(1)},${y.toFixed(1)}`);
  });
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1).map((r) => r.join(" "));
}

/** Right-click entries for a row. */
export function contextEntries(row) {
  const entries = [];
  // Disable or Enable shows only when the hub says the row supports it and it is available right now.
  for (const name of ["disable", "enable"]) if ((row.actions ?? []).some((a) => a.action === name && a.available === true)) entries.push({ id: name, scope: "startup", action: name });
  entries.push({ id: "hide", scope: "row" });
  if (row.kind && row.kind !== "stack") entries.push({ id: "hide-kind", scope: "kind", value: row.kind });
  if (row.vendor && row.vendor !== "other") entries.push({ id: "hide-vendor", scope: "vendor", value: row.vendor });
  entries.push({ id: row.pinned ? "unpin" : "pin", scope: "pin" });
  entries.push({ id: "open", scope: "portal" });
  return entries;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Applies a rules change for a context-menu choice to a rules document and returns the new document. Hiding never touches pins of other rows. */
export function applyRule(rules, entry, row) {
  const next = clone(rules ?? { hide: {}, pins: [] });
  next.hide ??= {};
  for (const key of ["kinds", "classes", "machines", "vendors", "names"]) next.hide[key] ??= [];
  next.pins ??= [];
  const add = (list, value) => { if (!list.includes(value)) list.push(value); };
  if (entry.scope === "kind") add(next.hide.kinds, entry.value);
  else if (entry.scope === "vendor") add(next.hide.vendors, entry.value);
  else if (entry.scope === "row") {
    if (!next.hide.names.some((n) => n.machine === row.machineId && n.match === row.name)) next.hide.names.push({ machine: row.machineId, match: row.name });
    next.pins = next.pins.filter((p) => !(p.machine === row.machineId && p.key === row.key));
  } else if (entry.scope === "pin") {
    const has = next.pins.some((p) => p.machine === row.machineId && p.key === row.key);
    if (entry.id === "pin" && !has) next.pins.push({ machine: row.machineId, key: row.key });
    if (entry.id === "unpin") next.pins = next.pins.filter((p) => !(p.machine === row.machineId && p.key === row.key));
  }
  return next;
}

/** Turns an action record from GET /api/services/actions into what the panel shows. "waiting" is a sudo command the person still has to run. */
export function actionOutcome(record) {
  if (!record) return { done: false, state: "running" };
  const state = record.state;
  if (state === "running" || state === "waiting" || state === "confirmed") return { done: false, state };
  if (state === "done") return { done: true, ok: true };
  return { done: true, ok: false, reason: record.message || state || "unknown" };
}
