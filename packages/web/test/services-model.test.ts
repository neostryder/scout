import { test } from "node:test";
import assert from "node:assert/strict";

const { workspaceKindLabel, phoneDefaultMachine, servicesQuery, routesQuery, routeRow, routeStateLabel, routeViaLabel, routeChain, routeConfidence, routeChipOrder, edgePillText, edgeProgressReducer, lensQuery, exposureLabel, stateLabel, serviceRow, listenerRow, toggleSort, elapsedTime, probeReducer, probeElapsed, mergeFacets, isExposed, descriptionSourceLabel, descriptionLine, descriptionFilter, descriptionFacet, descriptionEditorState, describeProgress, actionButtons, protectedLabel, planDialogModel, actionLine, actionState, actionEventReducer, controlDialogReducer, ALERT_KINDS, alertSeverityLabel, alertSeverityTone, alertKindLabel, alertTitle, groupAlerts, alertEventReducer, badgeModel, alertEndpointMissing, muteCoverage, alertFilter, countAlerts, healthLabel, healthTone, latencyText, tlsText, sparkPoints, healthCounts, healthFilter, healthEventReducer, rangeFill, portsSummary, clashText, stackStateLabel, stackMemberText, planStepsText, stackFilter, stackEventReducer } = await import(new URL("../public/services-model.js", import.meta.url).href);

test("alert labels, tones, titles and sorting cover contract values", () => {
  assert.deepEqual(["info", "warn", "high"].map(alertSeverityLabel), ["Info", "Warning", "High"]);
  assert.deepEqual(["info", "warn", "high"].map(alertSeverityTone), ["info", "warn", "high"]);
  assert.deepEqual(ALERT_KINDS.map(alertKindLabel), ["New listener", "New daemon", "Service down", "Domain origin down", "Exposure change", "Unhealthy target", "Certificate expiring", "Crash loop", "Port clash", "Backup unhealthy"]);
  assert.equal(alertTitle({ title: "New listener on Hub" }), "New listener on Hub");
  const items = groupAlerts([{ id: 1, severity: "info", at: "2026-10-07T02:00:00Z" }, { id: 2, severity: "high", at: "2026-10-07T00:00:00Z" }, { id: 3, severity: "high", at: "2026-10-07T01:00:00Z" }]);
  assert.deepEqual(items.map((item: any) => item.id), [3, 2, 1]);
});

test("health labels, tones, latency and certificate text cover every state", () => {
  assert.deepEqual(["up", "slow", "failing", "down", "not-http", "unknown"].map(healthLabel), ["Up", "Slow", "Failing", "Down", "Not a web service", "Not checked"]);
  assert.deepEqual(["up", "slow", "failing", "down", "not-http", "unknown"].map(healthTone), ["ok", "warn", "warn", "danger", "quiet", "quiet"]);
  assert.equal(latencyText(48), "48 ms");
  assert.equal(latencyText(1200), "1.2 s");
  assert.equal(tlsText(41), "Certificate ends in 41 days");
  assert.equal(tlsText(0), "Certificate ends today");
  assert.equal(tlsText(-1), "Certificate expired");
});

test("health sparkline gaps failures and health events update counts and progress", () => {
  const segments = sparkPoints([{ ok: true, latencyMs: 12 }, { ok: false }, { ok: true, latencyMs: 24 }]);
  assert.equal(segments.length, 2);
  assert.match(segments[0], /0\.0,/);
  assert.match(segments[1], /240\.0,/);
  const targets = [{ key: "a", kind: "domain", label: "a", state: "down" }, { key: "b", kind: "listener", label: "b", state: "up" }];
  assert.deepEqual(healthCounts(targets), { up: 1, slow: 0, failing: 0, down: 1, "not-http": 0, unknown: 0 });
  assert.deepEqual(healthFilter(targets).map((row: any) => row.key), ["a", "b"]);
  assert.deepEqual(healthFilter(targets, "all", "listener").map((row: any) => row.key), ["b"]);
  let health = healthEventReducer(undefined, { targets, counts: healthCounts(targets) });
  health = healthEventReducer(health, { target: { ...targets[1], state: "slow" }, change: "state" });
  assert.equal(health.counts.slow, 1);
  health = healthEventReducer(health, { running: true, done: 3, total: 17 });
  assert.deepEqual(health.probe, { running: true, done: 3, total: 17 });
  health = healthEventReducer(health, { health: { down: 1, failing: 2, expiring: 0 } });
  assert.equal(health.hello.failing, 2);
});

test("alert reducer merges events, counts open items and badge hides zero", () => {
  const alert = { id: 1, at: "2026-10-07T00:00:00Z", severity: "high", state: "open", muted: false };
  const created = alertEventReducer([], { alert, change: "created" });
  assert.deepEqual(created.counts, { open: 1, high: 1, acknowledged: 0, resolved: 0 });
  const ack = alertEventReducer(created.alerts, { alert: { ...alert, state: "acknowledged", acknowledgedAt: "2026-10-07T01:00:00Z" }, change: "acknowledged" });
  assert.equal(ack.alerts.length, 1);
  assert.equal(ack.counts.acknowledged, 1);
  assert.deepEqual(badgeModel({ open: 0, high: 0 }), { hidden: true, text: "", tone: "quiet" });
  assert.deepEqual(badgeModel({ open: 1, high: 0 }), { hidden: false, text: "1 alert", tone: "quiet" });
  assert.deepEqual(badgeModel({ open: 3, high: 1 }), { hidden: false, text: "3 alerts", tone: "high" });
  assert.equal(alertEndpointMissing(404), true);
  assert.equal(alertEndpointMissing(500), false);
});

test("alert filters and mute globs select the intended keys", () => {
  const alerts = [{ id: 1, severity: "high", state: "open", kind: "service-down", muted: false, at: "2026-10-07T00:00:00Z" }, { id: 2, severity: "info", state: "acknowledged", kind: "new-listener", muted: false, at: "2026-10-07T01:00:00Z" }, { id: 3, severity: "warn", state: "open", kind: "new-listener", muted: true, at: "2026-10-07T02:00:00Z" }];
  assert.deepEqual(alertFilter(alerts, "open", "service-down").map((item: any) => item.id), [1]);
  assert.deepEqual(alertFilter(alerts, "muted").map((item: any) => item.id), [3]);
  assert.equal(muteCoverage("new-listener:hub:*", "new-listener:hub:8080:node"), true);
  assert.equal(muteCoverage("new-listener:hub:*", "new-listener:mini:8080:node"), false);
  assert.deepEqual(countAlerts(alerts), { open: 1, high: 1, acknowledged: 1, resolved: 0 });
});

test("control helpers preserve availability reasons and protected labels", () => {
  const buttons = actionButtons({ control: { actions: [{ action: "start", available: true }, { action: "stop", available: false, reason: "Protected: remote access" }] } });
  assert.deepEqual(buttons, [{ action: "start", label: "Start", enabled: true, reason: null }, { action: "stop", label: "Stop", enabled: false, reason: "Protected: remote access" }, { action: "restart", label: "Restart", enabled: false, reason: "Control is unavailable" }]);
  assert.deepEqual(["remote-access", "dns-network", "containers", "essential", "scout", "cloudflared", "ssh", "cogitator", "custom"].map(protectedLabel), ["Remote access", "DNS and network", "Containers", "Essential system service", "Scout", "Cloudflare tunnel", "Remote login", "Cogitator", "Custom"]);
  assert.equal(actionButtons({})[0].enabled, false);
  const startup = (mechanism: string, extra: any[]) => actionButtons({ control: { mechanism, actions: [{ action: "start", available: true }, { action: "stop", available: true }, { action: "restart", available: true }, ...extra] } }).map((b: any) => b.action);
  assert.deepEqual(startup("launchd", [{ action: "disable", available: true }, { action: "enable", available: false, reason: "Already enabled" }]), ["start", "stop", "restart", "disable"]);
  assert.deepEqual(startup("scheduled-task", [{ action: "disable", available: false, reason: "Already disabled" }, { action: "enable", available: true }]), ["start", "stop", "restart", "enable"]);
  assert.deepEqual(startup("windows-service", [{ action: "disable", available: false, reason: "Only launchd jobs and scheduled tasks can be disabled or enabled" }]), ["start", "stop", "restart"]);
  assert.deepEqual(actionButtons({ control: { mechanism: "launchd", actions: [{ action: "disable", available: false, reason: "Protected: Cogitator" }] } }).filter((b: any) => b.action === "disable"), [{ action: "disable", label: "Disable", enabled: false, reason: "Protected: Cogitator" }]);
  assert.equal(planDialogModel({ action: "disable", displayName: null, name: "com.example.worker", machineName: "Mini", command: "launchctl disable gui/501/com.example.worker", admin: "none", effects: [] }).heading, "Disable com.example.worker on Mini");
});

test("plan, audit and action event helpers model admin, refusal and live state", () => {
  const plan = { action: "stop", displayName: "DNS Client", name: "Dnscache", machineName: "Hub", command: "Stop-Service -Name Dnscache", admin: "uac", effects: ["Stops DNS"], graceful: true, waitSeconds: 20 };
  assert.deepEqual(planDialogModel(plan), { heading: "Stop DNS Client on Hub", command: plan.command, admin: "Windows will ask you to approve this on the machine that runs Scout.", effects: ["Stops DNS"], gracefulNote: "Scout waits 20 seconds for a graceful stop before reporting that it is still running.", hardWarning: "", hardStopLabel: "Stop DNS Client hard" });
  assert.match(planDialogModel({ ...plan, admin: "sudo", sudoCommand: "sudo service dns stop" }).admin, /Scout cannot use sudo/);
  assert.equal(planDialogModel({ ...plan, admin: "none" }).admin, "");
  assert.equal(actionLine({ action: "stop", name: "Dnscache", hard: true }), "Stop Dnscache hard");
  assert.deepEqual(actionState("waiting"), ["Waiting for change", "waiting"]);
  const running = { id: 4, at: "2026-10-07T00:00:00Z", state: "running", message: "Running" };
  const result = actionEventReducer([], running);
  assert.equal(result.running, 1);
  assert.equal(actionEventReducer(result.items, { ...running, state: "done", message: "Stopped" }).running, 0);
});

test("control dialog reducer covers planning, progress, result, hard follow-up and errors", () => {
  let state = controlDialogReducer({}, { type: "plan", plan: { allowed: true } });
  assert.equal(state.phase, "plan");
  state = controlDialogReducer(state, { type: "confirm", startedAt: 10 });
  assert.equal(state.phase, "progress");
  state = controlDialogReducer(state, { type: "action", row: { state: "failed", message: "Still running" } });
  assert.equal(state.phase, "result");
  state = controlDialogReducer(state, { type: "hard", plan: { hard: true } });
  assert.equal(state.plan.hard, true);
  assert.equal(controlDialogReducer(state, { type: "error", message: "The plan is out of date. Plan it again." }).phase, "error");
});

test("description labels, lines, facets and filters retain the contract sources", () => {
  assert.deepEqual(["hand", "project", "install", "public", "os", null].map((source) => descriptionSourceLabel(source, true)), ["Edited by you", "Written from the project's files", "From the installed package", "Written from public names", "From the operating system", "No description"]);
  assert.equal(descriptionLine({ description: { text: "A description that is longer than the table allows" } }, 20), "A description that...");
  assert.equal(descriptionLine({ description: null }), "");
  assert.equal(descriptionFilter(new URLSearchParams("q=cache"), "project").toString(), "q=cache&desc=project");
  assert.deepEqual(descriptionFacet([{ value: "hand", count: 2 }]).map((facet: any) => facet.value), ["hand", "project", "install", "public", "os", "none"]);
  assert.equal(descriptionFacet([], "public").find((facet: any) => facet.value === "public").count, 0);
});

test("description editor and public progress helpers model edit, cancel, error and completion", () => {
  assert.deepEqual(descriptionEditorState({}, { type: "edit" }), { editing: true, error: "" });
  assert.deepEqual(descriptionEditorState({}, { type: "error", message: "Too short" }), { editing: true, error: "Too short" });
  assert.deepEqual(descriptionEditorState({}, { type: "cancel" }), { editing: false, error: "" });
  assert.deepEqual(descriptionEditorState({}, { type: "saved" }), { editing: false, error: "" });
  assert.deepEqual(describeProgress({ state: "running", done: 3, total: 9 }), { label: "3 of 9 names", running: true, added: 0, error: "" });
  assert.equal(describeProgress({ state: "running", scope: "project", done: 1, total: 4 }).label, "1 of 4 projects");
  assert.deepEqual(describeProgress({ state: "done", applied: 2 }), { label: "Added 2 descriptions", running: false, added: 2, error: "" });
  assert.equal(describeProgress({ state: "failed", error: "Unavailable" }).label, "Unavailable");
});

test("route models label states, via values, confidence and complete each route chain", () => {
  assert.deepEqual(["ok", "origin-down", "dns-dangling", "no-origin", "unknown"].map(routeStateLabel), ["OK", "Origin down", "Dangling DNS", "No origin", "Unknown"]);
  assert.deepEqual(["tunnel", "worker", "proxied-origin", "dns-only"].map(routeViaLabel), ["Tunnel", "Worker", "Proxied origin", "DNS only"]);
  assert.deepEqual(["listener", "cloudflared", "single-host", "configured", null].map(routeConfidence), ["found by listener", "found by running cloudflared", "the only machine", "set in the tunnel hosts file", "machine not identified"]);
  const base = { hostname: "scout.example.test", path: null, state: "ok", via: "tunnel", dns: { type: "CNAME", content: "tunnel-aaaa.example.test", proxied: true }, tunnel: { name: "server" }, origin: { service: "http://localhost:4870", port: 4870 }, machineName: "Server", listener: { processName: "node" } };
  assert.match(routeChain(base), /scout.example.test resolves through a proxied CNAME record to tunnel server, which forwards to http:\/\/localhost:4870; Server has node process listening on 4870/);
  assert.match(routeChain({ ...base, via: "worker", worker: { pattern: "*.example.test/*", script: "fake-worker" } }), /matches Worker pattern/);
  assert.match(routeChain({ ...base, state: "origin-down" }), /does not know whether the service is stopped or the port changed/);
  assert.equal(routeRow(base).hostnamePath, "scout.example.test");
  for (const via of ["tunnel", "worker", "proxied-origin", "dns-only"]) assert.match(routeChain({ ...base, via }), /scout.example.test/);
  for (const state of ["ok", "origin-down", "dns-dangling", "no-origin", "unknown"]) assert.match(routeChain({ ...base, state }), /scout.example.test/);
});

test("route query, attention ordering and edge progress use stable page models", () => {
  const params = new URLSearchParams("machine=server&state=origin-down&q=scout&sort=hostname&dir=desc&lens=ignored");
  assert.deepEqual(Object.fromEntries(routesQuery(params, 900, 12)), { machine: "server", state: "origin-down", q: "scout", limit: "500", offset: "12" });
  const ordered = routeChipOrder([{ hostname: "z.example.test", state: "ok" }, { hostname: "b.example.test", state: "origin-down" }, { hostname: "a.example.test", state: "dns-dangling" }]);
  assert.deepEqual(ordered.map((row: any) => row.hostname), ["a.example.test", "b.example.test", "z.example.test"]);
  assert.equal(edgePillText({ state: "failed", error: "reader offline" }), "Cloudflare reader failed: reader offline");
  const started = edgeProgressReducer(null, { phase: "start", startedAt: "2026-01-01T00:00:00Z" }, 5);
  assert.equal(started.receivedAt, 5); assert.equal(started.expiresAt, null);
  assert.equal(edgeProgressReducer(started, { phase: "done" }, 8).expiresAt, 6008);
});

test("service query includes description filters and excludes page-only state", () => {
  const params = new URLSearchParams("view=services&tab=listeners&lens=exposed&machine=hub&kind=scheduled-task&state=running&class=optional&official=1&hasPort=1&q=backup&all=1&gone=gone&sort=ports&dir=desc&bind=lan&port=8010&unknown=bad");
  params.set("desc", "project,public");
  assert.deepEqual(Object.fromEntries(servicesQuery(params, "services", 900, 50)), { machine: "hub", kind: "scheduled-task", state: "running", class: "optional", official: "1", hasPort: "1", q: "backup", desc: "project,public", all: "1", gone: "gone", sort: "ports", dir: "desc", limit: "500", offset: "50" });
});

test("listeners and activity queries send only supported filters", () => {
  const params = new URLSearchParams("machine=mini&kind=launchd&state=running&class=third-party&official=0&hasPort=1&q=tailscale&all=1&gone=gone&sort=name&dir=desc&bind=lan&port=41641");
  assert.deepEqual(Object.fromEntries(servicesQuery(params, "listeners", 25, 10)), { machine: "mini", bind: "lan", class: "third-party", official: "0", q: "tailscale", port: "41641", all: "1", gone: "gone", limit: "25", offset: "10" });
  assert.deepEqual(Object.fromEntries(servicesQuery(params, "activity", 500)), { machine: "mini", limit: "200" });
});

test("lenses select class, official and port filters and retain search and machine", () => {
  const original = new URLSearchParams("view=services&machine=hub&q=backup&all=1");
  for (const [lens, key, value] of [["optional", "class", "optional"], ["third-party", "class", "third-party"], ["official", "official", "1"], ["exposed", "hasPort", "1"]]) {
    const selected = lensQuery(original, lens);
    assert.equal(selected.get(key), value);
    assert.equal(selected.get("machine"), "hub");
    assert.equal(selected.get("q"), "backup");
    assert.equal(selected.get("all"), "1");
    assert.equal(lensQuery(selected, lens).get(key), null);
  }
  assert.equal(original.has("lens"), false);
});

test("the daemon lens removes narrow lens filters and system visibility toggles independently", () => {
  const params = new URLSearchParams("lens=exposed&hasPort=1&class=optional&official=1&bind=lan&machine=hub");
  assert.equal(lensQuery(params, "daemons").toString(), "machine=hub");
  const hidden = lensQuery(params, "hidden");
  assert.equal(hidden.get("all"), "1");
  assert.equal(hidden.get("hasPort"), "1");
  assert.equal(lensQuery(hidden, "hidden").get("all"), null);
});

test("exposure labels distinguish every bind and only LAN and all interfaces are exposed", () => {
  assert.deepEqual(["none", "loopback", "lan", "all", "bad"].map(exposureLabel), ["No port", "Loopback", "LAN", "All interfaces", "Unknown"]);
  for (const exposure of ["none", "loopback", "lan", "all"]) assert.equal(isExposed({ exposure }), ["lan", "all"].includes(exposure));
  assert.equal(isExposed({ bind: "lan" }), true);
});

test("state labels include stopped, disabled, unknown and all live states", () => {
  assert.deepEqual(["running", "stopped", "disabled", "other", "fresh", "stale", "unreachable", "never", "bad"].map(stateLabel), ["Running", "Stopped", "Disabled", "Other", "Live", "Stale", "Unreachable", "Never read", "Unknown"]);
});

test("service view models preserve detail evidence and render null pids and joined ports", () => {
  const classification = { evidence: ["OS path"], confidence: "rule" };
  const row = serviceRow({ id: 1, kind: "scheduled-task", state: "stopped", exposure: "lan", pid: null, ports: [{ port: 80 }, { port: 443 }], classification });
  assert.equal(row.kindText, "Scheduled task");
  assert.equal(row.portsText, "80, 443");
  assert.equal(row.pidText, "None");
  assert.equal(row.classification, classification);
  assert.equal(serviceRow({ kind: "launchd", state: "running", exposure: "none", pid: 0, ports: [] }).pidText, "0");
  assert.equal(serviceRow({ kind: "windows-service", state: "other", exposure: "none", pid: 2, ports: [] }).portsText, "None");
});

test("listener view models prefer container names and describe missing service joins", () => {
  assert.equal(listenerRow({ containerName: "hooks", processName: "docker", bind: "all", serviceName: null }).name, "hooks");
  assert.equal(listenerRow({ processName: "node", bind: "loopback", serviceName: "scout-hub" }).joinedText, "scout-hub");
  assert.equal(listenerRow({ bind: "lan" }).joinedText, "No joined service");
  assert.equal(listenerRow({ bind: "lan" }).name, "Unknown process");
});

test("a listener row shows its process id, or says why there is none, and prefers the platform's name for it", () => {
  assert.equal(listenerRow({ pid: 4870, bind: "loopback" }).pidText, "4870");
  assert.equal(listenerRow({ pid: 0, bind: "loopback" }).pidText, "Unknown");
  assert.equal(listenerRow({ pid: null, bind: "all", containerName: "relay" }).pidText, "Container");
  assert.equal(listenerRow({ pid: null, bind: "all" }).pidText, "Unknown");
  assert.equal(listenerRow({ label: "svchost: Remote Desktop Services", processName: "svchost", bind: "all" }).name, "svchost: Remote Desktop Services");
});

test("sort toggling reverses the current column and gives last seen a descending default", () => {
  const original = new URLSearchParams("machine=hub");
  const machine = toggleSort(original, "machine");
  assert.equal(machine.get("dir"), "desc");
  assert.equal(toggleSort(machine, "machine").get("dir"), "asc");
  assert.equal(toggleSort(machine, "name").get("dir"), "asc");
  assert.equal(toggleSort(machine, "lastSeen").get("dir"), "desc");
  assert.equal(original.has("sort"), false);
});

test("elapsed time handles invalid, negative, second and minute durations", () => {
  assert.deepEqual([NaN, -500, 999, 2000, 60000, 125999].map(elapsedTime), ["0s", "0s", "0s", "2s", "1m 0s", "2m 5s"]);
});

test("probe progress keeps concurrent machines and unknown duration until a terminal event", () => {
  const start = { machineId: "hub", probe: "win-tasks", phase: "start", label: "Scheduled tasks", startedAt: "2026-10-06T00:00:00Z", elapsedMs: 0, message: null };
  const first = probeReducer({}, start, 100);
  assert.equal(first["hub:win-tasks"].expiresAt, null);
  const mac = probeReducer(first, { ...start, machineId: "mini" }, 200);
  assert.equal(Object.keys(mac).length, 2);
  const progress = probeReducer(mac, { ...start, elapsedMs: 2000 }, 300);
  assert.equal(progress["hub:win-tasks"].elapsedMs, 2000);
  assert.equal(first["hub:win-tasks"].elapsedMs, 0);
  const done = probeReducer(progress, { ...start, phase: "done", elapsedMs: 20000 }, 500);
  assert.equal(done["hub:win-tasks"].expiresAt, 6500);
  assert.equal(probeReducer(done, { ...start, phase: "start" }, 600), done);
});

test("probe reducer retains failures, ignores old events and permits a new refresh", () => {
  const event = { machineId: "hub", probe: "win-tasks", phase: "failed", startedAt: "2026-10-06T00:01:00Z", elapsedMs: 20000, message: "Mock read failed" };
  const failed = probeReducer({}, event, 100);
  assert.equal(failed["hub:win-tasks"].message, "Mock read failed");
  assert.equal(probeReducer(failed, { ...event, phase: "invalid" }, 200), failed);
  assert.equal(probeReducer(failed, { ...event, startedAt: "2026-10-06T00:00:00Z" }, 200), failed);
  assert.equal(probeReducer(failed, { ...event, phase: "start", startedAt: "2026-10-06T00:02:00Z" }, 300)["hub:win-tasks"].phase, "start");
});

test("probe elapsed time ticks locally while running and freezes on completion", () => {
  const now = Date.parse("2026-10-06T00:00:10Z");
  const probe = { phase: "start", startedAt: "2026-10-06T00:00:00Z", elapsedMs: 2000 };
  assert.equal(probeElapsed(probe, now), 10000);
  assert.equal(probeElapsed({ ...probe, elapsedMs: 15000 }, now), 15000);
  assert.equal(probeElapsed({ ...probe, phase: "done" }, now), 2000);
});

test("facet merging retains counts, machine names and a selected zero-count value", () => {
  const facets = [{ value: "hub", label: "Hub", count: 12 }];
  assert.deepEqual(mergeFacets(facets, "missing", [{ id: "hub", name: "Hub" }, { id: "mini", name: "Mini" }]), [{ value: "hub", label: "Hub", count: 12 }, { value: "mini", label: "Mini", count: 0 }, { value: "missing", label: "missing", count: 0 }]);
  assert.deepEqual(facets, [{ value: "hub", label: "Hub", count: 12 }]);
  assert.deepEqual(mergeFacets(), []);
});

test("port ranges split used, reserved and free segments and summarize the registry", () => {
  const range = { name: "dev", from: 4870, to: 4875, size: 6, used: [4870, 4871, 4874], usedCount: 3, freeCount: 1, reserved: [4872, 4873] };
  assert.deepEqual(rangeFill(range), { used: 3, reserved: 2, free: 1, segments: [{ type: "used", from: 4870, to: 4871, count: 2 }, { type: "reserved", from: 4872, to: 4873, count: 2 }, { type: "used", from: 4874, to: 4874, count: 1 }, { type: "free", from: 4875, to: 4875, count: 1 }] });
  assert.deepEqual(portsSummary({ ranges: [range], reserved: [{ port: 4872 }], clashes: [{ port: 4870 }] }), { ranges: 1, used: 3, free: 1, reserved: 1, clashes: 1 });
  assert.equal(clashText({ detail: "Port 4870 is reserved." }), "Port 4870 is reserved.");
});

test("stack labels, member details, plans, filters and stream events cover contract states", () => {
  assert.deepEqual(["ready", "partial", "running", "blocked"].map(stackStateLabel), ["Ready", "Partly running", "Running", "Blocked"]);
  assert.equal(stackMemberText({ label: "App", detail: "pnpm run dev", waitPort: 4876, waitSeconds: 30, running: false, available: false, reason: "The recipe needs approval." }), "App: pnpm run dev; wait for port 4876 for up to 30 seconds; Not running; The recipe needs approval.");
  assert.equal(planStepsText([{ order: 1, label: "Cogitator", command: "start", skipped: false }, { order: 2, label: "App", command: "run", skipped: true }]), "1. Cogitator: start\n2. App: Already running");
  const stacks = [{ name: "app", state: "ready" }, { name: "blocked", state: "blocked" }];
  assert.deepEqual(stackFilter(stacks, "blocked"), [stacks[1]]);
  assert.deepEqual(stackEventReducer(stacks, { name: "app", state: "running" }), [{ name: "app", state: "running" }, stacks[1]]);
});

test("an island's third line counts the listening ports and how many of them other machines can reach", async () => {
  const { listenerSummary } = await import(new URL("../public/services-model.js", import.meta.url).href);
  assert.equal(listenerSummary({ listeners: { total: 12, loopback: 7, lan: 3, all: 2 } }), "12 ports listening, 5 exposed");
  assert.equal(listenerSummary({ listeners: { total: 1, loopback: 1, lan: 0, all: 0 } }), "1 port listening, 0 exposed");
  assert.equal(listenerSummary({}), "");
});

test("on a phone the chart room opens on the hub machine unless the link or the tab says otherwise", () => {
  const machines = [{ id: "aragorn", hub: false }, { id: "eru", hub: true }];
  assert.equal(phoneDefaultMachine(new URLSearchParams(""), machines, true), "eru");
  assert.equal(phoneDefaultMachine(new URLSearchParams("tab=alerts"), machines, true), "eru");
  assert.equal(phoneDefaultMachine(new URLSearchParams("machine=aragorn"), machines, true), null);
  assert.equal(phoneDefaultMachine(new URLSearchParams("tab=ports"), machines, true), null);
  assert.equal(phoneDefaultMachine(new URLSearchParams(""), machines, false), null);
  assert.equal(phoneDefaultMachine(new URLSearchParams(""), [{ id: "aragorn", hub: false }], true), null);
});

test("workspace entry kinds read as plain labels", () => {
  assert.deepEqual(["windows-service", "scheduled-task", "run-key", "startup-folder", "launchd", "systemd", "autostart", "other"].map(workspaceKindLabel), ["Windows service", "Scheduled task", "Logon entry (registry)", "Logon entry (Startup folder)", "launchd job", "systemd unit", "Autostart entry", "other"]);
});
