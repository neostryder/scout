const DESCRIPTION_SOURCES = ["hand", "project", "install", "public", "os", "none"];

const HEALTH_LABELS = { up: "Up", slow: "Slow", failing: "Failing", down: "Down", "not-http": "Not a web service", unknown: "Not checked" };
const HEALTH_TONES = { up: "ok", slow: "warn", failing: "warn", down: "danger", "not-http": "quiet", unknown: "quiet" };
const HEALTH_ORDER = ["down", "failing", "slow", "unknown", "up", "not-http"];

export function healthLabel(state) { return HEALTH_LABELS[state] || "Not checked"; }
export function healthTone(state) { return HEALTH_TONES[state] || "quiet"; }
export function latencyText(ms) { return ms == null ? "None" : Number(ms) >= 1000 ? `${(Number(ms) / 1000).toFixed(1)} s` : `${Math.round(Number(ms))} ms`; }
export function tlsText(days) { return days == null ? "" : days < 0 ? "Certificate expired" : days === 0 ? "Certificate ends today" : `Certificate ends in ${days} days`; }
export function sparkPoints(history = [], width = 240, height = 48) {
  const samples = history.slice(-60);
  const latencies = samples.filter((sample) => sample.ok && Number.isFinite(sample.latencyMs)).map((sample) => sample.latencyMs);
  const max = Math.max(1, ...latencies);
  const segments = []; let current = [];
  samples.forEach((sample, index) => {
    if (!sample.ok || !Number.isFinite(sample.latencyMs)) { if (current.length) segments.push(current.join(" ")); current = []; return; }
    const x = samples.length < 2 ? width : index * width / (samples.length - 1);
    const y = height - sample.latencyMs / max * (height - 2) - 1;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  return segments;
}
export function healthCounts(targets = []) {
  const counts = { up: 0, slow: 0, failing: 0, down: 0, "not-http": 0, unknown: 0 };
  for (const target of targets) if (Object.hasOwn(counts, target.state)) counts[target.state]++;
  return counts;
}
export function healthFilter(targets = [], state = "all", kind = "all") {
  return [...targets].filter((target) => (state === "all" || target.state === state) && (kind === "all" || target.kind === kind)).sort((a, b) => HEALTH_ORDER.indexOf(a.state) - HEALTH_ORDER.indexOf(b.state) || a.label.localeCompare(b.label));
}
export function healthEventReducer(current = { targets: [], counts: healthCounts(), probe: { running: false, done: 0, total: 0 }, hello: null }, event = {}) {
  if (event.targets) return { ...current, ...event, targets: event.targets, counts: event.counts || healthCounts(event.targets) };
  if (event.target) {
    const previous = current.targets.find((target) => target.key === event.target.key);
    const targets = [{ ...previous, ...event.target, history: event.target.history || previous?.history || [] }, ...current.targets.filter((target) => target.key !== event.target.key)];
    return { ...current, targets: healthFilter(targets), counts: healthCounts(targets) };
  }
  if (event.running != null && event.done != null) return { ...current, probe: { ...current.probe, ...event } };
  if (event.health) return { ...current, hello: event.health };
  return current;
}

export function recipeCommand(recipe) { return recipe.argv.join(" "); }
export function recipeFilter(recipes, state = "active") { return recipes.filter((recipe) => state === "all" || (state === "active" ? ["proposed", "approved"].includes(recipe.state) : recipe.state === state)); }
export function recipeCounts(recipes) {
  const counts = { proposed: 0, approved: 0, rejected: 0, unsupported: 0 };
  for (const recipe of recipes) if (Object.hasOwn(counts, recipe.state)) counts[recipe.state]++;
  return counts;
}
export function recipeEventReducer(recipes, event) {
  if (!event?.recipe) return { recipes, counts: recipeCounts(recipes) };
  const next = [event.recipe, ...recipes.filter((recipe) => recipe.id !== event.recipe.id)].sort((a, b) => b.proposedAt.localeCompare(a.proposedAt) || b.id - a.id);
  return { recipes: next, counts: recipeCounts(next) };
}
export function recipeButtons(recipe) {
  if (recipe.gone || recipe.state === "unsupported" || recipe.state === "rejected") return [];
  return recipe.state === "approved" ? ["start"] : ["approve", "reject"];
}

export function rangeFill(range) {
  const used = new Set(range.used || []);
  const reserved = new Set((range.reserved || []).map((item) => typeof item === "number" ? item : item.port));
  const segments = [];
  for (let port = range.from; port <= range.to; port++) {
    const type = used.has(port) ? "used" : reserved.has(port) ? "reserved" : "free";
    const previous = segments.at(-1);
    if (previous?.type === type) { previous.to = port; previous.count++; }
    else segments.push({ type, from: port, to: port, count: 1 });
  }
  return { used: range.usedCount ?? used.size, reserved: [...reserved].filter((port) => port >= range.from && port <= range.to).length, free: range.freeCount ?? Math.max(0, range.to - range.from + 1 - used.size - reserved.size), segments };
}

export function portsSummary(ports = {}) {
  return { ranges: ports.ranges?.length || 0, used: (ports.ranges || []).reduce((sum, range) => sum + (range.usedCount || 0), 0), free: (ports.ranges || []).reduce((sum, range) => sum + (range.freeCount || 0), 0), reserved: ports.reserved?.length || 0, clashes: ports.clashes?.length || 0 };
}

export function clashText(clash) { return String(clash.detail || `Port ${clash.port} has a clash.`); }
export function stackStateLabel(state) { return ({ ready: "Ready", partial: "Partly running", running: "Running", blocked: "Blocked" })[state] || "Blocked"; }
export function stackMemberText(member) { return `${member.label}: ${member.detail}${member.waitPort == null ? "" : `; wait for port ${member.waitPort} for up to ${member.waitSeconds || 30} seconds`}${member.running === true ? "; Running" : member.running === false ? "; Not running" : ""}${member.available === false && member.reason ? `; ${member.reason}` : ""}`; }
export function planStepsText(steps = []) { return steps.map((step) => `${step.order}. ${step.label}: ${step.skipped ? "Already running" : step.command}`).join("\n"); }
export function stackFilter(stacks = [], state = "all") { return stacks.filter((stack) => state === "all" || stack.state === state); }
export function stackEventReducer(stacks = [], event = {}) {
  if (event.stacks) return [...event.stacks];
  if (!event.name || !event.state) return stacks;
  return stacks.map((stack) => stack.name === event.name ? { ...stack, state: event.state } : stack);
}
const SERVICE_KEYS = ["machine", "kind", "state", "class", "official", "hasPort", "q", "desc", "all", "gone", "sort", "dir"];
const LISTENER_KEYS = ["machine", "bind", "class", "official", "q", "desc", "port", "all", "gone"];

const CONTROL_ACTIONS = ["start", "stop", "restart"];
const PROTECTED_LABELS = { essential: "Essential system service", scout: "Scout", cloudflared: "Cloudflare tunnel", ssh: "Remote login", cogitator: "Cogitator", "remote-access": "Remote access", "dns-network": "DNS and network", containers: "Containers", custom: "Custom" };
const ACTION_STATES = { running: ["Running", "running"], waiting: ["Waiting for change", "waiting"], done: ["Done", "done"], failed: ["Failed", "failed"], confirmed: ["Confirmed", "done"], expired: ["Expired", "failed"], declined: ["Declined", "failed"] };

export function actionButtons(row) {
  const actions = row?.control?.actions;
  return CONTROL_ACTIONS.map((action) => {
    const item = actions?.find((entry) => entry.action === action);
    const enabled = !!item?.available;
    return { action, label: action[0].toUpperCase() + action.slice(1), enabled, reason: enabled ? null : item?.reason || "Control is unavailable" };
  });
}

export function protectedLabel(group) { return PROTECTED_LABELS[group] || "Protected"; }

export function planDialogModel(plan) {
  if (plan.target === "stack") return { heading: `Start ${plan.displayName || plan.name}`, command: plan.command, admin: plan.admin === "uac" ? "Windows will ask you to approve this on the machine that runs Scout." : "", effects: plan.effects || [], steps: plan.steps || [], gracefulNote: "", hardWarning: "", hardStopLabel: "" };
  const action = `${plan.action[0].toUpperCase()}${plan.action.slice(1)} ${plan.displayName || plan.name} on ${plan.machineName}`;
  const admin = plan.admin === "uac" ? "Windows will ask you to approve this on the machine that runs Scout." : plan.admin === "sudo" ? `Run this command yourself in a terminal on ${plan.machineName}; Scout cannot use sudo. ${plan.sudoCommand || plan.command}` : "";
  return { heading: action, command: plan.command, admin, effects: plan.effects || [], gracefulNote: plan.graceful && plan.action === "stop" ? `Scout waits ${plan.waitSeconds || 20} seconds for a graceful stop before reporting that it is still running.` : "", hardWarning: plan.hard ? "A hard stop ends the process immediately and can lose unsaved work." : "", hardStopLabel: plan.action === "stop" && !plan.hard && plan.graceful ? `Stop ${plan.displayName || plan.name} hard` : "" };
}

export function actionLine(row) { return `${row.action[0].toUpperCase()}${row.action.slice(1)} ${row.name}${row.hard ? " hard" : ""}`; }
export function actionState(state) { return ACTION_STATES[state] || ["Unknown", "quiet"]; }

export function actionEventReducer(rows, event) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  byId.set(event.id, { ...byId.get(event.id), ...event });
  const items = [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { items, running: items.filter((row) => row.state === "running").length };
}

export function controlDialogReducer(state, event) {
  if (event.type === "plan") return { phase: "plan", plan: event.plan, error: "", action: null };
  if (event.type === "confirm") return { ...state, phase: "progress", startedAt: event.startedAt, error: "" };
  if (event.type === "action") return { ...state, phase: event.row.state === "running" || event.row.state === "waiting" ? "progress" : "result", action: event.row };
  if (event.type === "error") return { ...state, phase: "error", error: event.message };
  if (event.type === "hard") return { ...state, phase: "plan", plan: event.plan, error: "" };
  return state;
}

export function descriptionSourceLabel(source, generated) {
  return ({ hand: "Edited by you", project: "Written from the project's files", install: "From the installed package", public: "Written from public names", os: "From the operating system" })[source] || "No description";
}

export function descriptionLine(row, max = 120) {
  const text = String(row?.description?.text || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...` : text;
}

export function descriptionFilter(params, source) {
  const next = new URLSearchParams(params);
  if (source) next.set("desc", source); else next.delete("desc");
  return next;
}

export function descriptionFacet(facets = [], selected = "") {
  const sourceName = (value) => (value === "none" ? "None" : descriptionSourceLabel(value));
  const byValue = new Map(facets.map((facet) => [String(facet.value), { ...facet, label: sourceName(String(facet.value)) }]));
  for (const value of DESCRIPTION_SOURCES) if (!byValue.has(value)) byValue.set(value, { value, label: sourceName(value), count: 0 });
  if (selected && !byValue.has(selected)) byValue.set(selected, { value: selected, label: selected, count: 0 });
  return [...byValue.values()].sort((a, b) => DESCRIPTION_SOURCES.indexOf(a.value) - DESCRIPTION_SOURCES.indexOf(b.value));
}

export function descriptionEditorState(state, action) {
  if (action.type === "edit") return { editing: true, error: "" };
  if (action.type === "cancel" || action.type === "saved") return { editing: false, error: "" };
  if (action.type === "error") return { editing: true, error: action.message };
  return state;
}

export function describeProgress(event) {
  if (event.state === "running") return { label: `${event.done} of ${event.total} ${event.scope === "project" ? "projects" : "names"}`, running: true, added: 0, error: "" };
  if (event.state === "done") return { label: `Added ${event.applied} descriptions`, running: false, added: event.applied, error: "" };
  if (event.state === "failed") return { label: event.error || "The description pass failed.", running: false, added: 0, error: event.error || "The description pass failed." };
  return { label: "", running: false, added: 0, error: "" };
}
const ROUTE_STATES = ["ok", "origin-down", "dns-dangling", "no-origin", "unknown"];

export function routeStateLabel(value) {
  return ({ ok: "OK", "origin-down": "Origin down", "dns-dangling": "Dangling DNS", "no-origin": "No origin", unknown: "Unknown" })[value] || "Unknown";
}

export function routeViaLabel(value) {
  return ({ tunnel: "Tunnel", worker: "Worker", "proxied-origin": "Proxied origin", "dns-only": "DNS only" })[value] || "Unknown";
}

export function routeConfidence(value) {
  return ({ listener: "found by listener", cloudflared: "found by running cloudflared", "single-host": "the only machine", configured: "set in the tunnel hosts file" })[value] || "machine not identified";
}

export function routeChain(row) {
  if (row.state === "dns-dangling") return `${row.hostname} has a DNS record that Scout cannot resolve to an existing route; the target machine and origin are unknown.`;
  if (row.state === "no-origin") return `${row.hostname} reaches ${row.tunnel?.name ? `tunnel ${row.tunnel.name}` : routeViaLabel(row.via).toLowerCase()}, which has no local origin for Scout to check.`;
  if (row.state === "unknown") return `${row.hostname} has a ${routeViaLabel(row.via).toLowerCase()} route, but Scout does not have enough information to verify its origin.`;
  const target = row.origin?.service || "no origin";
  const machine = row.machineName ? `${row.machineName} has ${row.listener?.processName || "a process"} process listening on ${row.origin?.port ?? "an unknown port"}` : "Scout could not identify the machine";
  if (row.state === "origin-down") return `${row.hostname} resolves through ${routeViaLabel(row.via).toLowerCase()} ${row.tunnel?.name ? `tunnel ${row.tunnel.name}` : "route"} to ${target}, but no listener was found on port ${row.origin?.port ?? "unknown"}; the reader does not know whether the service is stopped or the port changed.`;
  if (row.via === "worker") return `${row.hostname} matches Worker pattern ${row.worker?.pattern || "unknown"} and runs script ${row.worker?.script || "unknown"}.`;
  return `${row.hostname} resolves through ${row.dns?.proxied ? "a proxied" : "a"} ${row.dns?.type || "DNS"} record${row.tunnel?.name ? ` to tunnel ${row.tunnel.name}` : ""}, which forwards to ${target}; ${machine}.`;
}

export function routeRow(row) { return { ...row, stateLabel: routeStateLabel(row.state), viaLabel: routeViaLabel(row.via), chain: routeChain(row), confidenceText: routeConfidence(row.machineConfidence), hostnamePath: `${row.hostname}${row.path || ""}`, originText: row.origin ? `${row.origin.host}:${row.origin.port}` : "None" }; }

export function routesQuery(params, limit = 100, offset = 0) {
  const query = new URLSearchParams();
  for (const key of ["machine", "state", "q"]) if (params.get(key)) query.set(key, params.get(key));
  query.set("limit", String(Math.min(500, limit)));
  query.set("offset", String(offset));
  return query;
}

export function routeChipOrder(rows) { return [...rows].sort((a, b) => Number(["origin-down", "dns-dangling"].includes(b.state)) - Number(["origin-down", "dns-dangling"].includes(a.state)) || a.hostname.localeCompare(b.hostname)); }

export function edgePillText(edge) { return edge?.state === "fresh" ? "Cloudflare reader fresh" : edge?.state === "off" ? "Cloudflare reader off" : edge?.state === "never" ? "Cloudflare reader has not run" : edge?.state === "failed" ? `Cloudflare reader failed${edge.error ? `: ${edge.error}` : ""}` : edge?.state === "stale" ? `Cloudflare reader stale${edge.error ? `: ${edge.error}` : ""}` : "Cloudflare reader status unknown"; }

export function edgeProgressReducer(progress, event, now = Date.now()) {
  if (event.phase === "start") return { ...event, receivedAt: now, expiresAt: null };
  if (!["done", "failed"].includes(event.phase)) return progress;
  return { ...event, receivedAt: now, expiresAt: now + 6000 };
}

export function servicesQuery(params, tab = "services", limit = 100, offset = 0) {
  const query = new URLSearchParams();
  const keys = tab === "activity" ? ["machine"] : tab === "listeners" ? LISTENER_KEYS : SERVICE_KEYS;
  for (const key of keys) if (params.get(key)) query.set(key, params.get(key));
  query.set("limit", String(tab === "activity" ? Math.min(200, limit) : Math.min(500, limit)));
  if (tab !== "activity") query.set("offset", String(offset));
  return query;
}

export function lensQuery(params, lens) {
  const next = new URLSearchParams(params);
  if (lens === "hidden") {
    next.get("all") === "1" ? next.delete("all") : next.set("all", "1");
    return next;
  }
  const active = next.get("lens") === lens;
  for (const key of ["lens", "class", "official", "hasPort", "bind"]) next.delete(key);
  if (!active && lens !== "daemons") {
    next.set("lens", lens);
    if (lens === "optional" || lens === "third-party") next.set("class", lens);
    if (lens === "official") next.set("official", "1");
    if (lens === "exposed") next.set("hasPort", "1");
  }
  return next;
}

export function exposureLabel(value) {
  return ({ none: "No port", loopback: "Loopback", lan: "LAN", all: "All interfaces" })[value] || "Unknown";
}

export function stateLabel(value) {
  return ({ running: "Running", stopped: "Stopped", disabled: "Disabled", other: "Other", fresh: "Live", stale: "Stale", unreachable: "Unreachable", never: "Never read" })[value] || "Unknown";
}

export function serviceRow(row) {
  return { ...row, stateText: stateLabel(row.state), exposureText: exposureLabel(row.exposure), portsText: row.ports.map(({ port }) => port).join(", ") || "None", pidText: row.pid == null ? "None" : String(row.pid), kindText: ({ "windows-service": "Windows service", "scheduled-task": "Scheduled task", launchd: "launchd" })[row.kind] || row.kind };
}

export function listenerRow(row) {
  return { ...row, exposureText: exposureLabel(row.bind), name: row.containerName || row.label || row.processName || "Unknown process", joinedText: row.serviceName || "No joined service" };
}

export function toggleSort(params, sort) {
  const next = new URLSearchParams(params);
  const current = next.get("sort") || "machine";
  next.set("sort", sort);
  next.set("dir", current === sort ? ((next.get("dir") || "asc") === "asc" ? "desc" : "asc") : sort === "lastSeen" ? "desc" : "asc");
  return next;
}

export function elapsedTime(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function probeReducer(probes, event, now = Date.now()) {
  if (!["start", "done", "failed"].includes(event.phase)) return probes;
  const key = `${event.machineId}:${event.probe}`;
  const previous = probes[key];
  if (previous && Date.parse(event.startedAt) < Date.parse(previous.startedAt)) return probes;
  if (previous?.startedAt === event.startedAt && previous.phase !== "start" && event.phase === "start") return probes;
  return { ...probes, [key]: { ...event, receivedAt: now, expiresAt: event.phase === "start" ? null : now + 6000 } };
}

export function probeElapsed(probe, now = Date.now()) {
  return probe.phase === "start" ? Math.max(probe.elapsedMs || 0, now - Date.parse(probe.startedAt)) : probe.elapsedMs;
}

export function mergeFacets(facets = [], selected = "", machines = []) {
  const result = new Map(facets.map((facet) => [String(facet.value), { ...facet, label: facet.label || String(facet.value) }]));
  for (const machine of machines) if (!result.has(machine.id)) result.set(machine.id, { value: machine.id, label: machine.name, count: 0 });
  if (selected && !result.has(selected)) result.set(selected, { value: selected, label: selected, count: 0 });
  return [...result.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function isExposed(row) { return ["lan", "all"].includes(row.exposure || row.bind); }

export const ALERT_KINDS = ["new-listener", "new-daemon", "service-down", "domain-origin-down", "exposure-change", "unhealthy", "cert-expiring", "crash-loop", "port-clash"];
export function alertSeverityLabel(value) { return ({ info: "Info", warn: "Warning", high: "High" })[value] || "Unknown"; }
export function alertSeverityTone(value) { return ({ info: "info", warn: "warn", high: "high" })[value] || "quiet"; }
export function alertKindLabel(value) { return ({ "new-listener": "New listener", "new-daemon": "New daemon", "service-down": "Service down", "domain-origin-down": "Domain origin down", "exposure-change": "Exposure change", unhealthy: "Unhealthy target", "cert-expiring": "Certificate expiring", "crash-loop": "Crash loop", "port-clash": "Port clash" })[value] || "Unknown alert"; }
export function alertTitle(alert) { return String(alert?.title || `${alertKindLabel(alert?.kind)} on ${alert?.machineName || "unknown machine"}`); }
export function groupAlerts(alerts = []) {
  return [...alerts].sort((a, b) => ({ high: 0, warn: 1, info: 2 }[a.severity] ?? 3) - ({ high: 0, warn: 1, info: 2 }[b.severity] ?? 3) || Date.parse(b.at) - Date.parse(a.at));
}
export function alertEventReducer(alerts = [], event) {
  if (!event?.alert || !["created", "resolved", "acknowledged", "muted"].includes(event.change)) return { alerts, counts: countAlerts(alerts) };
  const byId = new Map(alerts.map((alert) => [alert.id, alert]));
  byId.set(event.alert.id, { ...byId.get(event.alert.id), ...event.alert });
  const items = groupAlerts([...byId.values()]);
  return { alerts: items, counts: countAlerts(items) };
}
export function countAlerts(alerts = []) {
  const counted = alerts.filter((alert) => !alert.muted);
  return { open: counted.filter((alert) => alert.state === "open").length, high: counted.filter((alert) => alert.state === "open" && alert.severity === "high").length, acknowledged: counted.filter((alert) => alert.state === "acknowledged").length, resolved: counted.filter((alert) => alert.state === "resolved").length };
}
export function badgeModel(summary) {
  const open = Math.max(0, Number(summary?.open) || 0);
  return { hidden: open === 0, text: open ? `${open} alert${open === 1 ? "" : "s"}` : "", tone: Number(summary?.high) > 0 ? "high" : "quiet" };
}
export function alertEndpointMissing(status) { return status === 404; }
export function muteCoverage(match, key) {
  const escaped = [...String(match || "")].map((part) => part === "*" ? ".*" : part === "?" ? "." : "\\^$+().|{}[]".includes(part) ? `\\${part}` : part).join("");
  try { return new RegExp(`^${escaped}$`).test(String(key || "")); } catch { return false; }
}
export function alertFilter(alerts, state = "open", kind = "") {
  return groupAlerts(alerts.filter((alert) => (alert.muted ? state === "muted" || state === "all" : state === "all" || alert.state === state) && (!kind || alert.kind === kind)));
}
