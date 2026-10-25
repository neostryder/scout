import { h, flagRow, marked } from "./lib.js";
import { servicesQuery, routesQuery, routeRow, routeChipOrder, edgePillText, edgeProgressReducer, lensQuery, serviceRow, listenerRow, toggleSort, elapsedTime, probeReducer, probeElapsed, mergeFacets, isExposed, stateLabel, exposureLabel, descriptionSourceLabel, descriptionLine, descriptionFilter, descriptionFacet, descriptionEditorState, describeProgress, actionButtons, protectedLabel, planDialogModel, actionLine, actionState, actionEventReducer, controlDialogReducer, ALERT_KINDS, alertKindLabel, alertSeverityLabel, alertSeverityTone, alertFilter, alertEventReducer, countAlerts, muteCoverage, alertEndpointMissing } from "./services-model.js";
import { phoneDefaultMachine } from "./services-model.js";
import { recipeCommand, recipeFilter, recipeCounts, recipeEventReducer, recipeButtons } from "./services-model.js";
import { workspaceKindLabel, healthLabel, healthTone, latencyText, tlsText, sparkPoints, healthCounts, healthFilter, healthEventReducer } from "./services-model.js";
import { rangeFill, portsSummary, clashText, stackStateLabel, stackMemberText, stackFilter, stackEventReducer } from "./services-model.js";
import { renderDiagram } from "./services-diagram.js";
import { createOutagesPanel } from "./outages.js";
import { SNAPSHOT_KEY, SNAPSHOT_ROUTES, SNAPSHOT_SAVE_EVERY_MS, packSnapshot, unpackSnapshot, snapshotNote } from "./services-snapshot.js";

const PAGE = 100;
const TABS = ["services", "listeners", "activity", "actions", "recipes", "domains", "alerts", "health", "outages", "ports", "stacks"];
const LENSES = [["daemons", "Daemons"], ["optional", "Could disable"], ["third-party", "Third-party"], ["official", "Official"], ["exposed", "Exposed"], ["hidden", "System hidden"]];
const title = (text) => text[0].toUpperCase() + text.slice(1);
const date = (value) => value ? new Date(value).toLocaleString() : "None";

export function createServicesView(root) {
  const portsState = { ports: null, supported: false };
  const stacksState = { stacks: [], supported: false };
  const state = { shown: false, params: new URLSearchParams(), limit: PAGE, machines: [], listeners: [], routes: [], actionRows: [], runningActions: 0, recipes: [], recipeCounts: { proposed: 0, approved: 0 }, recipeSupported: false, alerts: [], alertCounts: { open: 0, high: 0 }, mutes: [], alertFile: ".scout-data/alerts.json", alertError: "", alertSupported: true, health: { targets: [], counts: healthCounts(), probe: { running: false, done: 0, total: 0 }, hello: null }, workspaceInstalls: [], raw: {}, snapshotAt: null, snapshotSavedAt: 0, healthSupported: true, healthOff: false, healthError: "", edge: { state: "never", lastReadAt: null, error: null }, edgeOverview: { domains: 0, originDown: 0, dnsDangling: 0 }, descriptionOverview: null, describe: null, describeError: "", describeMessage: "", edgeProgress: null, data: null, dataTab: "", probes: {}, source: null, poll: null, tick: null, debounce: null, searchTimer: null, controller: null, detailController: null, sequence: 0, livePaused: false, pending: {}, loading: {}, liveMachines: new Map(), previous: new Map(), readings: new Map(), changed: new Set(), frames: new Set() };
  let effects = true;
  try { effects = localStorage.getItem("scout.services.effects") !== "off"; } catch {}
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const motion = () => effects && !reduced.matches;
  const applyEffects = () => { root.dataset.effects = motion() ? "on" : "off"; if (!motion()) { for (const frame of state.frames) cancelAnimationFrame(frame); state.frames.clear(); renderFigures(false); } };
  const tab = () => TABS.includes(state.params.get("tab")) ? state.params.get("tab") : "services";
  const query = (name) => state.params.get(name) || "";
  const status = h("span", { class: "live-pill", role: "status", "aria-live": "polite" }, "Connecting to live updates");
  const subtitle = h("p", { class: "quiet" }, "The catalog is loading.");
  const figures = h("div", { class: "overview-figures" });
  const lenses = h("div", { class: "lenses", "aria-label": "Service lenses" });
  const machineSelect = h("select", { "aria-label": "Machine", onchange: (event) => change("machine", event.target.value) });
  const search = h("input", { type: "search", placeholder: "Name, path, process or port", "aria-label": "Search services", oninput: () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => change("q", search.value.trim()), 150); } });
  const refresh = h("button", { type: "button", onclick: refreshNow }, "Refresh now");
  const refreshEdge = h("button", { type: "button", onclick: refreshCloudflare }, "Refresh Cloudflare");
  const refreshDescriptions = h("button", { type: "button", onclick: refreshPublicDescriptions }, "Describe from public names");
  const refreshProjects = h("button", { type: "button", onclick: refreshProjectDescriptions }, "Describe my projects");
  const describeStatus = h("span", { class: "quiet description-status", role: "status", "aria-live": "polite" });
  const descriptionSelect = h("select", { "aria-label": "Description", onchange: () => { state.params = descriptionFilter(state.params, descriptionSelect.value); state.limit = PAGE; syncUrl(); load({ table: true }); } });
  const effectsInput = h("input", { type: "checkbox", checked: effects, onchange: () => { effects = effectsInput.checked; try { localStorage.setItem("scout.services.effects", effects ? "on" : "off"); } catch {} applyEffects(); } });
  const progress = h("div", { class: "probe-list" });
  const announce = h("span", { class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const atlas = h("div", { class: "atlas", "aria-label": "Machine atlas" });
  const atlasError = h("p", { class: "error", role: "status", hidden: true });
  const tableStatus = h("p", { class: "table-status", role: "status" }, "The catalog is loading.");
  const table = h("table", {}, h("caption", { class: "sr-only" }, "Services"), h("thead"), h("tbody"));
  const tablePanel = h("section", { id: "services-table-panel", role: "tabpanel" }, tableStatus, h("div", { class: "data-wrap" }, table));
  const alertsPanel = h("section", { id: "services-alerts-panel", role: "tabpanel", class: "alerts-panel", hidden: true, "aria-labelledby": "services-tab-alerts" });
  const healthPanel = h("section", { id: "services-health-panel", role: "tabpanel", class: "health-panel", hidden: true, "aria-labelledby": "services-tab-health" });
  const outages = createOutagesPanel({ onCount: (count) => paintOutagesTab(count) });
  const outagesPanel = outages.panel;
  const portsPanel = h("section", { id: "services-ports-panel", role: "tabpanel", class: "ports-panel", hidden: true, "aria-labelledby": "services-tab-ports" });
  const stacksPanel = h("section", { id: "services-stacks-panel", role: "tabpanel", class: "stacks-panel", hidden: true, "aria-labelledby": "services-tab-stacks" });
  const protectedPanel = h("details", { class: "protected-panel", hidden: true, ontoggle: (event) => { if (event.currentTarget.open) loadProtected(event.currentTarget); } }, h("summary", {}, "Protected services"), h("div", {}));
  const more = h("button", { type: "button", hidden: true, onclick: () => { state.limit += PAGE; load({ table: true }); } }, "Show more");
  const tabs = h("div", { class: "table-tabs", role: "tablist", "aria-label": "Service data", onkeydown: (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visible = [...tabs.children].filter((button) => !button.hidden);
    const current = visible.indexOf(tabs.querySelector('[aria-selected="true"]'));
    const index = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : (current + (event.key === "ArrowRight" ? 1 : visible.length - 1)) % visible.length;
    const button = visible[index];
    change("tab", button.id.replace("services-tab-", "")); button.focus();
  } }, ...TABS.map((name) => h("button", { id: `services-tab-${name}`, type: "button", role: "tab", "aria-controls": ({ alerts: "services-alerts-panel", health: "services-health-panel", outages: "services-outages-panel", ports: "services-ports-panel", stacks: "services-stacks-panel" })[name] || "services-table-panel", onclick: () => change("tab", name) }, name === "alerts" ? "Alerts" : title(name))));
  tabs.children[TABS.indexOf("recipes")].hidden = true;
  tabs.children[TABS.indexOf("outages")].hidden = true;
  const recipeDialog = h("dialog", { class: "action-dialog", "aria-labelledby": "recipe-title", onclose: () => { if (recipeOpener?.isConnected) recipeOpener.focus(); else tabs.querySelector('[aria-selected="true"]')?.focus(); } });
  let recipeOpener = null;
  const detail = h("dialog", { class: "service-detail", "aria-labelledby": "services-detail-title", onclose: restoreFocus, onkeydown: trapFocus });
  const actionDialog = h("dialog", { class: "action-dialog", "aria-labelledby": "action-title", onclose: () => { if (stackOpenerName) setTimeout(() => [...root.querySelectorAll("[data-stack-name]")].find((button) => button.dataset.stackName === stackOpenerName)?.focus(), 0); else if (actionDialogState.plan?.target === "recipe") setTimeout(() => tabs.querySelector('[aria-selected="true"]')?.focus(), 0); }, oncancel: (event) => { if (!stackOpenerName) return; event.preventDefault(); actionDialog.close(); setTimeout(() => [...root.querySelectorAll("[data-stack-name]")].find((button) => button.dataset.stackName === stackOpenerName)?.focus(), 0); }, onkeydown: trapActionFocus });
  let actionDialogState = { phase: "", plan: null, error: "", action: null, startedAt: 0 };
  let stackProgress = [];
  let opener = null;
  let actionOpener = null;
  let stackOpenerName = "";
  let focusKey = null;
  let detailRow = null;
  let detailKind = null;
  let descriptionEditing = false;
  let descriptionError = "";
  let descriptionDraft = null;
  function transitionDescription(action) {
    const next = descriptionEditorState({ editing: descriptionEditing, error: descriptionError }, action);
    descriptionEditing = next.editing; descriptionError = next.error;
  }
  root.replaceChildren(h("header", { class: "chart-header" }, h("div", {}, h("h1", {}, "The chart room"), subtitle), status, h("details", { class: "chart-menu" }, h("summary", {}, "View options"), h("label", {}, effectsInput, "Effects"))), figures, lenses, h("div", { class: "chart-filters" }, h("label", { class: "chart-search" }, "Search", search), h("label", {}, "Machine", machineSelect), h("label", {}, "Description", descriptionSelect), refresh, refreshEdge, h("div", { class: "describe-controls" }, refreshDescriptions, h("small", { class: "quiet" }, "Sends only names, never paths, users, hosts or ports."), refreshProjects, h("small", { class: "quiet" }, "Reads each project's README and notes on this computer and sends them only to the local Cogitator host."), describeStatus), h("button", { type: "button", onclick: () => { state.params = new URLSearchParams("view=services"); state.limit = PAGE; syncUrl(); syncControls(); load(); } }, "Clear filters")), announce, progress, h("div", { class: "chart-content" }, h("section", { class: "atlas-panel" }, atlasError, atlas), h("section", { class: "tables-panel" }, tabs, tablePanel, alertsPanel, healthPanel, outagesPanel, portsPanel, stacksPanel, protectedPanel, h("div", { class: "more-services" }, more))), detail, actionDialog, recipeDialog);
  reduced.addEventListener("change", applyEffects);
  applyEffects();

  function syncUrl() { history.replaceState(null, "", `?${state.params}`); }
  function paintRecipeTab() {
    const button = tabs.children[TABS.indexOf("recipes")];
    button.hidden = !state.recipeSupported;
    button.replaceChildren("Recipes", state.recipeCounts.proposed ? h("span", { class: "tab-count" }, String(state.recipeCounts.proposed)) : []);
  }
  function paintAlertTab() {
    const button = tabs.children[TABS.indexOf("alerts")];
    if (button) button.replaceChildren("Alerts", state.alertCounts.open ? h("span", { class: "tab-count" }, String(state.alertCounts.open)) : []);
  }
  function paintHealthTab() {
    const button = tabs.children[TABS.indexOf("health")];
    if (button) button.replaceChildren("Health", state.health.counts.down + state.health.counts.failing > 0 ? h("span", { class: "tab-count" }, String(state.health.counts.down + state.health.counts.failing)) : []);
  }
  function paintOutagesTab(count) {
    const button = tabs.children[TABS.indexOf("outages")];
    if (button) button.replaceChildren("Outages", count > 0 ? h("span", { class: "tab-count" }, String(count)) : []);
  }
  function syncControls() {
    search.value = query("q");
    search.setAttribute("aria-label", tab() === "domains" ? "Search domains" : "Search services"); search.placeholder = tab() === "domains" ? "Hostname, tunnel or service" : "Name, path, process or port";
    descriptionSelect.hidden = !["services", "listeners"].includes(tab());
    search.closest("label").hidden = ["recipes", "outages", "ports", "stacks"].includes(tab());
    machineSelect.closest("label").hidden = ["recipes", "outages", "ports", "stacks"].includes(tab());
    descriptionSelect.closest("label").hidden = ["recipes", "outages", "ports", "stacks"].includes(tab());
    renderLenses(); renderMachines(); renderDescriptionFacet();
    for (const [index, button] of [...tabs.children].entries()) { button.setAttribute("aria-selected", String(TABS[index] === tab())); button.tabIndex = TABS[index] === tab() ? 0 : -1; }
    tablePanel.setAttribute("aria-labelledby", `services-tab-${tab()}`);
    tablePanel.hidden = ["alerts", "health", "outages", "ports", "stacks"].includes(tab());
    alertsPanel.hidden = tab() !== "alerts" || !state.alertSupported;
    healthPanel.hidden = tab() !== "health" || !state.healthSupported;
    outagesPanel.hidden = tab() !== "outages" || !outages.supported();
    portsPanel.hidden = tab() !== "ports" || !portsState.supported;
    stacksPanel.hidden = tab() !== "stacks" || !stacksState.supported;
    lenses.hidden = ["alerts", "health", "outages", "ports", "stacks"].includes(tab());
  }
  function change(key, value) {
    clearTimeout(state.searchTimer);
    if (value) state.params.set(key, value); else state.params.delete(key);
    state.limit = PAGE; state.data = null;
    syncUrl(); syncControls(); tableStatus.textContent = `Reading ${title(tab())}.`; more.hidden = true; load({ table: true }); paintProgress();
  }
  function renderLenses() {
    if (["outages", "ports", "stacks"].includes(tab())) { lenses.replaceChildren(); return; }
    if (tab() === "recipes") {
      lenses.setAttribute("aria-label", "Recipe state filters");
      lenses.replaceChildren(...[["active", "Proposed and approved"], ["proposed", "Proposed"], ["approved", "Approved"], ["rejected", "Rejected"], ["unsupported", "Unsupported"], ["all", "All states"]].map(([value, label]) => h("button", { type: "button", "aria-pressed": String((query("recipeState") || "active") === value), onclick: () => change("recipeState", value) }, label)), h("button", { type: "button", onclick: scanRecipeRows }, "Scan recipes"));
      return;
    }
    if (tab() === "domains") {
      lenses.setAttribute("aria-label", "Domain state filters");
      lenses.replaceChildren(...[["", "All states"], ["origin-down", "Origin down"], ["dns-dangling", "Dangling"], ["ok", "OK"], ["no-origin", "No origin"], ["unknown", "Unknown"]].map(([value, label]) => h("button", { type: "button", "aria-pressed": String(query("state") === value && query("lens") !== "domains-down"), onclick: () => { state.params.delete("lens"); change("state", value); } }, label)), h("button", { type: "button", "aria-pressed": String(query("lens") === "domains-down"), onclick: () => { state.params.set("tab", "domains"); state.params.set("lens", "domains-down"); state.params.delete("state"); state.limit = PAGE; syncUrl(); syncControls(); load({ table: true }); } }, "Domains down"));
      return;
    }
    lenses.setAttribute("aria-label", "Service lenses");
    lenses.replaceChildren(...LENSES.map(([lens, label]) => {
      const active = lens === "hidden" ? query("all") === "1" : lens === "daemons" ? !query("lens") && !query("class") && !query("official") && !query("hasPort") : query("lens") === lens;
      return h("button", { type: "button", "aria-pressed": String(active), onclick: () => { state.params = lensQuery(state.params, lens); state.limit = PAGE; state.data = null; syncUrl(); syncControls(); tableStatus.textContent = `Reading ${title(tab())}.`; more.hidden = true; load({ table: true }); } }, label);
    }), h("button", { type: "button", "aria-pressed": String(query("lens") === "domains-down"), onclick: () => { state.params.set("tab", "domains"); state.params.set("lens", "domains-down"); state.params.delete("state"); state.limit = PAGE; syncUrl(); syncControls(); load({ table: true }); } }, "Domains down"), h("span", { class: "hidden-count quiet" }, `${state.data?.hiddenCount || 0} hidden system rows${query("all") === "1" ? " included" : ""}`));
  }
  function renderMachines() {
    machineSelect.replaceChildren(h("option", { value: "" }, "All machines"), ...mergeFacets(state.data?.facets?.machine, query("machine"), state.machines).map((facet) => h("option", { value: facet.value, selected: facet.value === query("machine") }, `${facet.label} (${facet.count})`)));
    machineSelect.value = query("machine");
  }
  function renderDescriptionFacet() {
    const facets = descriptionFacet(state.data?.facets?.description, query("desc"));
    descriptionSelect.replaceChildren(h("option", { value: "" }, "All descriptions"), ...facets.map((facet) => h("option", { value: facet.value, selected: facet.value === query("desc") }, `${facet.label} (${facet.count})`)));
    descriptionSelect.value = query("desc");
  }
  function countTo(node, target, previous) {
    if (!motion() || target === previous) { node.textContent = String(target); return; }
    const start = performance.now();
    const frame = (now) => {
      node.textContent = String(Math.round(previous + (target - previous) * Math.min(1, (now - start) / 450)));
      if (now - start < 450 && state.shown && motion()) queue(frame);
    };
    queue(frame);
  }
  function queue(callback) {
    const frame = requestAnimationFrame((now) => { state.frames.delete(frame); callback(now); }); state.frames.add(frame);
  }
  function renderFigures(animate = true) {
    const serviceCount = state.machines.reduce((sum, machine) => sum + machine.services.total, 0);
    const portCount = state.machines.reduce((sum, machine) => sum + machine.listeners.total, 0);
    subtitle.textContent = `${state.machines.length} machines, ${serviceCount} services, ${portCount} listening ports${state.snapshotAt ? ` (${snapshotNote(state.snapshotAt, Date.now())})` : ""}`;
    const entries = [["Services", serviceCount], ["Listening ports", portCount], ["Running", state.machines.reduce((sum, machine) => sum + machine.services.running, 0)], ["Could disable", state.machines.reduce((sum, machine) => sum + machine.services.optionalRunning, 0)], ["Domains", state.edgeOverview.domains], ["Needs attention", state.edgeOverview.originDown + state.edgeOverview.dnsDangling], ["Descriptions", `${state.descriptionOverview?.described ?? 0} of ${state.descriptionOverview?.total ?? 0} described`]];
    const old = [...figures.querySelectorAll("strong")].map((node) => Number(node.textContent));
    for (const frame of state.frames) cancelAnimationFrame(frame); state.frames.clear();
    figures.replaceChildren(...entries.map(([label, value], index) => {
      const number = h("strong", {}, String(value));
      if (animate && typeof value === "number") countTo(number, value, old[index] || 0);
      return h("div", { class: label === "Descriptions" ? "description-count" : "" }, h("span", { class: "quiet" }, label), number);
    }));
  }
  function paintAtlas() { renderDiagram(atlas, state.machines, state.listeners, (machine, listener) => { change("machine", machine.id); listener ? openListener(listener) : openMachine(machine); }, state.routes, state.edge, openRoute, showDomains, state.edgeOverview.domains); }
  function paintLive() {
    const problems = state.machines.filter((machine) => machine.live.state !== "fresh" && machine.live.state !== "paused");
    const cadences = [...new Set(state.machines.map((machine) => `${machine.hub ? machine.name : "Remote machines"} ${elapsedTime(machine.live.cadenceMs)}`))].join(", ");
    status.className = `live-pill ${problems.some((machine) => machine.live.state === "unreachable") ? "unreachable" : state.livePaused || problems.length ? "stale" : "fresh"}`;
    status.replaceChildren(h("span", { class: `state-dot ${state.livePaused ? "stale" : "fresh"}` }), `${state.livePaused ? "live updates paused" : `live: ${cadences || "connecting"}`}${problems.length ? ` - ${problems.map((machine) => `${machine.name} ${stateLabel(machine.live.state).toLowerCase()}`).join(", ")}` : ""}`);
    status.title = [problems.map((machine) => `${machine.name}: ${machine.live.error || stateLabel(machine.live.state)}`).join("; "), edgePillText(state.edge)].filter(Boolean).join("; ");
  }
  async function fetchJson(path, signal) {
    const response = await fetch(path, { signal });
    if (!response.ok) throw new Error(`The request failed (${response.status}).`);
    return response.json();
  }
  async function fetchRows(name, params, signal, full = false) {
    const path = name === "listeners" ? "/api/listeners" : "/api/services";
    const rows = []; let result;
    do {
      const count = full ? 500 : Math.min(500, state.limit - rows.length);
      result = await fetchJson(`${path}?${servicesQuery(params, name, count, rows.length)}`, signal);
      rows.push(...result.rows);
      if (!result.rows.length) break;
    } while (rows.length < result.total && (full || rows.length < state.limit));
    return { ...result, rows };
  }
  async function load(routes = { overview: true, edgeOverview: true, routes: true, atlas: true, table: true }) {
    if (!state.shown || document.hidden) return;
    routes = { ...state.loading, ...routes }; state.loading = routes;
    state.controller?.abort(); const controller = new AbortController(); state.controller = controller;
    const sequence = ++state.sequence;
    const currentTab = tab(); const params = new URLSearchParams(state.params);
    const requested = [];
    if (routes.overview) requested.push(["overview", () => fetchJson("/api/services/overview", controller.signal)]);
    if (routes.overview) requested.push(["descriptionOverview", () => fetchJson("/api/services/descriptions/overview", controller.signal)]);
    if (routes.edgeOverview) requested.push(["edgeOverview", () => fetchJson("/api/services/routes/overview", controller.signal)]);
    if (routes.overview || routes.table && currentTab === "recipes") requested.push(["recipeRows", () => fetchJson("/api/services/recipes", controller.signal)]);
    if (routes.overview || routes.table && currentTab === "ports") requested.push(["portsRows", () => fetchJson("/api/services/ports", controller.signal)]);
    if (routes.overview || routes.table && currentTab === "stacks") requested.push(["stacksRows", () => fetchJson("/api/services/stacks", controller.signal)]);
    if (routes.table && currentTab === "stacks") requested.push(["controlRows", () => fetchRows("services", new URLSearchParams("all=1"), controller.signal, true)]);
    if (routes.overview) requested.push(["alertRows", () => fetchJson("/api/services/alerts?state=all&limit=500&include=muted", controller.signal)]);
    if (routes.overview || routes.table && currentTab === "outages") requested.push(["outageRows", () => fetchJson("/api/services/outages?limit=200", controller.signal)]);
    if (routes.overview || routes.table && currentTab === "health") requested.push(["healthRows", () => fetchJson("/api/services/health", controller.signal)]);
    if (routes.table && currentTab === "health") requested.push(["workspaceRows", () => fetchJson("/api/services/workspace-installs", controller.signal)]);
    if (routes.routes || routes.overview) requested.push(["routes", async () => {
      const rows = []; let result;
      do { result = await fetchJson(`/api/services/routes?${routesQuery(params, 500, rows.length)}`, controller.signal); rows.push(...result.rows); if (!result.rows.length) break; } while (rows.length < result.total && rows.length < 500);
      return { ...result, rows };
    }]);
    if (routes.atlas) requested.push(["atlas", () => fetchRows("listeners", new URLSearchParams(), controller.signal, true)]);
    if (routes.table && !["recipes", "outages", "ports", "stacks"].includes(currentTab)) requested.push(["table", async () => {
      if (currentTab === "actions") return fetchJson(`/api/services/actions?limit=${state.limit}`, controller.signal);
      if (currentTab === "alerts") return fetchJson(`/api/services/alerts?state=${encodeURIComponent(query("alertState") === "muted" ? "all" : query("alertState") || "open")}&kind=${encodeURIComponent(query("alertKind"))}&include=muted`, controller.signal);
      if (currentTab === "activity") return fetchJson(`/api/services/events?${servicesQuery(params, "activity", state.limit)}`, controller.signal);
      if (currentTab === "domains") {
        const rows = []; let result;
        do { result = await fetchJson(`/api/services/routes?${routesQuery(params, state.limit - rows.length, rows.length)}`, controller.signal); rows.push(...result.rows); if (!result.rows.length) break; } while (rows.length < result.total && rows.length < state.limit);
        return { ...result, rows };
      }
      return fetchRows(currentTab, params, controller.signal, params.get("lens") === "exposed");
    }]);
    const results = await Promise.allSettled(requested.map(([, run]) => run()));
    if (sequence !== state.sequence || !state.shown) return;
    state.loading = {};
    for (let index = 0; index < requested.length; index++) {
      const [route] = requested[index]; const result = results[index];
      if (result.status === "rejected") {
        if (result.reason.name === "AbortError") continue;
        const statusCode = Number(result.reason.message.match(/\((\d+)\)/)?.[1]);
        if (route === "recipeRows") {
          state.recipeSupported = false; paintRecipeTab();
          if (currentTab === "recipes") { state.params.set("tab", "services"); syncUrl(); syncControls(); load({ table: true }); }
          continue;
        }
        if (route === "portsRows" || route === "stacksRows") {
          const isPorts = route === "portsRows"; (isPorts ? portsState : stacksState).supported = false;
          tabs.children[TABS.indexOf(isPorts ? "ports" : "stacks")].hidden = true;
          if (currentTab === (isPorts ? "ports" : "stacks")) { state.params.set("tab", "services"); syncUrl(); syncControls(); load({ table: true }); }
          continue;
        }
        if (route === "controlRows" || route === "workspaceRows") continue;
        if (route === "outageRows") {
          if (alertEndpointMissing(statusCode)) { tabs.children[TABS.indexOf("outages")].hidden = true; outagesPanel.hidden = true; if (currentTab === "outages") { state.params.set("tab", "services"); syncUrl(); syncControls(); load({ table: true }); } } else outages.setError(result.reason.message);
          continue;
        }
        if (route === "alertRows" && alertEndpointMissing(statusCode)) { state.alertSupported = false; alertsPanel.hidden = true; tabs.children[TABS.indexOf("alerts")].hidden = true; continue; }
        if (route === "healthRows" && alertEndpointMissing(statusCode)) { state.healthSupported = false; healthPanel.hidden = true; tabs.children[TABS.indexOf("health")].hidden = true; if (currentTab === "health") { state.params.set("tab", "services"); syncUrl(); syncControls(); } continue; }
        if (route === "table" && currentTab === "alerts" && alertEndpointMissing(statusCode)) {
          state.alertSupported = false;
          state.params.set("tab", "services"); syncUrl(); syncControls();
          continue;
        }
        const node = route === "table" ? tableStatus : route === "edgeOverview" || route === "routes" ? atlasError : atlasError;
        node.hidden = false; node.textContent = `${route === "table" ? title(currentTab) : "Atlas"}: ${result.reason.message} Use Refresh now to retry.`;
        continue;
      }
      if (SNAPSHOT_ROUTES.includes(route)) state.raw[route] = result.value;
      if (route === "overview") state.snapshotAt = null;
      if (route === "recipeRows") {
        state.recipeSupported = true; state.recipes = result.value.recipes; state.recipeCounts = result.value.counts; paintRecipeTab();
        if (currentTab === "recipes") renderRecipes();
      }
      if (route === "portsRows") { portsState.ports = result.value; portsState.supported = true; tabs.children[TABS.indexOf("ports")].hidden = false; portsPanel.hidden = currentTab !== "ports"; if (currentTab === "ports") renderPorts(); }
      if (route === "stacksRows") { stacksState.stacks = result.value.stacks || []; stacksState.supported = true; tabs.children[TABS.indexOf("stacks")].hidden = false; stacksPanel.hidden = currentTab !== "stacks"; if (currentTab === "stacks") renderStacks(); }
      if (route === "outageRows") { tabs.children[TABS.indexOf("outages")].hidden = false; outages.setData(result.value); outagesPanel.hidden = currentTab !== "outages"; }
      if (route === "controlRows") state.controlAvailable = !result.value.rows.some((row) => row.control?.actions?.length && row.control.actions.every((action) => action.reason === "Control is off."));
      if (route === "overview") { state.machines = result.value.machines.map((machine) => ({ ...machine, live: { ...machine.live, ...state.liveMachines.get(machine.id) } })); state.liveMachines.clear(); renderFigures(); paintLive(); const own = state.phoneDefault ? phoneDefaultMachine(state.params, state.machines, true) : null; state.phoneDefault = false; if (own) change("machine", own); }
      if (route === "alertRows") { state.alertSupported = true; state.alerts = result.value.alerts || []; state.mutes = result.value.mutes || []; state.alertCounts = result.value.counts || countAlerts(state.alerts); tabs.children[TABS.indexOf("alerts")].hidden = false; paintAlertTab(); if (state.data && tab() !== "alerts") renderTable(); }
      if (route === "healthRows") { state.healthSupported = true; state.healthError = ""; state.healthOff = result.value.probe?.intervalSeconds === 0; state.health = healthEventReducer(state.health, result.value); tabs.children[TABS.indexOf("health")].hidden = false; paintHealthTab(); if (currentTab === "health") renderHealth(); if (detail.open) refreshDetailHealth(); }
      if (route === "workspaceRows") { state.workspaceInstalls = result.value.installs || []; if (currentTab === "health") renderHealth(); }
      if (route === "descriptionOverview") { state.descriptionOverview = result.value; renderFigures(false); paintDescribe(); }
      if (route === "edgeOverview") { state.edge = result.value.reader; state.edgeOverview = result.value.totals; }
      if (route === "routes") { state.edge = result.value.reader; state.routes = routeChipOrder(result.value.rows.map(routeRow)); }
      if (route === "atlas") { state.listeners = result.value.rows; atlasError.hidden = true; }
      if (route === "table") {
        if (currentTab === "health") continue;
        if (currentTab === "alerts") {
          state.alertSupported = true; state.alerts = result.value.alerts || []; state.mutes = result.value.mutes || []; state.alertFile = result.value.file || ".scout-data/alerts.json"; state.alertCounts = result.value.counts || countAlerts(state.alerts); renderAlerts(); continue;
        }
        if (currentTab === "actions") { state.actionRows = result.value.items; state.runningActions = result.value.items.filter((row) => row.state === "running").length; state.data = { total: result.value.items.length, rows: result.value.items }; state.dataTab = currentTab; renderTable(); continue; }
        state.data = currentTab === "domains" ? { ...result.value, rows: result.value.rows.map(routeRow) } : result.value;
        state.dataTab = currentTab;
        if (params.get("lens") === "exposed" && currentTab !== "activity") { const rows = state.data.rows.filter(isExposed); state.data = { ...state.data, total: rows.length, rows: rows.slice(0, state.limit) }; }
        state.changed.clear();
        if (currentTab === "services") for (const row of state.data.rows) { if (state.previous.has(row.id) && state.previous.get(row.id) !== row.state) state.changed.add(row.id); state.previous.set(row.id, row.state); state.readings.set(row.id, [...(state.readings.get(row.id) || []), row.state].slice(-8)); }
        renderTable();
        if (state.pendingAlertTarget && currentTab === state.pendingAlertTarget.type + "s") {
          const targetRow = state.data.rows.find((row) => row.id === state.pendingAlertTarget.id);
          if (targetRow) { state.pendingAlertTarget = null; currentTab === "listeners" ? openListener(targetRow) : openService(targetRow); }
        }
      }
    }
    if (currentTab === "stacks" && routes.table && stacksState.supported) renderStacks();
    if (routes.overview || routes.atlas || routes.routes || routes.edgeOverview) paintAtlas();
    if (routes.edgeOverview) renderFigures(false);
    renderMachines(); renderLenses();
    if (routes.overview) saveSnapshot();
  }
  /** Keeps the last reads in the browser, at most once a minute, so the next cold start can paint them first. */
  function saveSnapshot() {
    const now = Date.now();
    if (state.snapshotAt || now - state.snapshotSavedAt < SNAPSHOT_SAVE_EVERY_MS) return;
    const text = packSnapshot(state.raw, now);
    if (!text) return;
    state.snapshotSavedAt = now;
    try { localStorage.setItem(SNAPSHOT_KEY, text); } catch {}
  }
  /** Draws the saved map before the first read answers. A live read then replaces it. */
  function paintSnapshot() {
    if (state.machines.length || state.listeners.length) return;
    let saved = null;
    try { saved = unpackSnapshot(localStorage.getItem(SNAPSHOT_KEY), Date.now()); } catch {}
    if (!saved) return;
    state.machines = saved.overview.machines.map((machine) => ({ ...machine, live: { ...machine.live, state: "stale" } }));
    state.edge = saved.routes.reader; state.edgeOverview = saved.edgeOverview.totals;
    state.routes = routeChipOrder(saved.routes.rows.map(routeRow)); state.listeners = saved.atlas.rows;
    state.snapshotAt = saved.at;
    renderFigures(false); paintLive(); paintAtlas(); renderMachines();
  }
  function cell(label, content, className = "") { return h("td", { "data-label": label, class: className }, content); }
  function heading(label, sort) {
    const active = (query("sort") || (tab() === "domains" ? "hostname" : "machine")) === sort;
    return h("th", { "aria-sort": active ? query("dir") === "desc" ? "descending" : "ascending" : "none" }, h("button", { type: "button", onclick: () => { state.params = toggleSort(state.params, sort); syncUrl(); load({ table: true }); } }, `${label}${active ? query("dir") === "desc" ? " v" : " ^" : ""}`));
  }
  function classChip(row) { return h("span", { class: `classification ${row.classification.class}` }, row.classification.class, h("small", { class: "quiet" }, row.classification.vendor)); }
  function descriptionCell(row) {
    const description = row.description;
    if (!description) return [];
    return [h("small", { class: "quiet description-line", title: description.text }, marked(descriptionLine(row), query("q"))), h("small", { class: "quiet description-marker" }, description.generated ? "auto" : description.source === "hand" ? "edited" : "")];
  }
  function detailButton(row, kind, text, action) { return h("button", { type: "button", class: "row-detail", "data-detail-kind": kind, "data-detail-id": row.id, onclick: action, "aria-label": `Details for ${text} on ${row.machineName}` }, text); }
  function rowAlerts(target, id) { return state.alerts.filter((alert) => !alert.muted && alert.state === "open" && alert.target?.type === target && alert.target.id === id); }
  function alertMark(alerts) { return alerts.length ? h("span", { class: "row-alert-mark", title: `${alerts.length} open alert${alerts.length === 1 ? "" : "s"}`, "aria-label": `${alerts.length} open alert${alerts.length === 1 ? "" : "s"}` }, "Alert") : []; }
  function healthMarker(health) {
    if (!health) return [];
    if (health.state === "not-http") return [h("span", { class: "health-dash quiet", title: healthLabel(health.state), "aria-label": healthLabel(health.state) }, "-")];
    const shape = ["down", "failing"].includes(health.state) ? "health-diamond" : "health-circle";
    return [h("span", { class: `health-dot ${healthTone(health.state)} ${shape}`, role: "img", "aria-label": healthLabel(health.state), title: healthLabel(health.state) }), health.latencyMs == null ? [] : h("small", { class: "quiet health-latency" }, latencyText(health.latencyMs))];
  }
  function renderHealth() {
    if (!state.healthSupported) return;
    const rows = healthFilter(state.health.targets, query("healthState") || "all", query("healthKind") || "all");
    const counts = state.health.counts;
    const stateSelect = h("select", { "aria-label": "Health state", onchange: (event) => change("healthState", event.target.value === "all" ? "" : event.target.value) }, ...[["all", "All states"], ...["down", "failing", "slow", "unknown", "up", "not-http"].map((value) => [value, healthLabel(value)])].map(([value, label]) => h("option", { value, selected: (query("healthState") || "all") === value }, label)));
    const kindSelect = h("select", { "aria-label": "Health kind", onchange: (event) => change("healthKind", event.target.value === "all" ? "" : event.target.value) }, ...[["all", "All kinds"], ["domain", "Domain"], ["listener", "Listener"]].map(([value, label]) => h("option", { value, selected: (query("healthKind") || "all") === value }, label)));
    const table = h("table", { class: "health-table" }, h("caption", { class: "sr-only" }, "Health checks"), h("thead", {}, h("tr", {}, ...["Target", "Kind", "State", "Latency", "Status code", "TLS days", "Last ok"].map((label) => h("th", {}, label)))), h("tbody", {}, ...rows.map((target) => h("tr", {}, cell("Target", h("button", { type: "button", class: "row-detail", onclick: () => showDetail(target, "health") }, target.label)), cell("Kind", title(target.kind)), cell("State", [h("span", { class: `health-dot ${healthTone(target.state)} ${["down", "failing"].includes(target.state) ? "health-diamond" : "health-circle"}`, role: "img", "aria-label": healthLabel(target.state) }), healthLabel(target.state)]), cell("Latency", latencyText(target.latencyMs)), cell("Status code", target.status ?? "None"), cell("TLS days", target.tlsDaysLeft ?? "None"), cell("Last ok", date(target.lastOkAt), "mono")))), ...(rows.length ? [] : [h("tr", {}, h("td", { colspan: 7, class: "empty" }, "No web endpoints are checked yet."))]));
    const installs = state.workspaceInstalls;
    const workspace = h("section", { class: "workspace-installs", "aria-labelledby": "workspace-installs-heading" }, h("h2", { id: "workspace-installs-heading" }, "Started from the workspace"), h("p", { class: "quiet" }, "Services, tasks, and logon entries that run a program from the Repositories folder. Install the tool to its own folder and register that copy."), installs.length ? h("table", { class: "workspace-table" }, h("caption", { class: "sr-only" }, "Entries that start a program from the workspace"), h("thead", {}, h("tr", {}, ...["Machine", "Kind", "Entry", "Where it lives", "Runs from"].map((label) => h("th", {}, label)))), h("tbody", {}, ...installs.map((install) => h("tr", {}, cell("Machine", install.machineName), cell("Kind", workspaceKindLabel(install.kind)), cell("Entry", install.name), cell("Where it lives", install.location || "None", "mono"), cell("Runs from", install.workspacePath, "mono"))))) : h("p", { role: "status" }, "Nothing starts from the Repositories folder."));
    const checked = state.health.probe;
    const statusText = state.healthOff ? "Health checks are turned off." : state.healthError || (checked.running ? `${checked.done} of ${checked.total} checked` : "Checks run every 5 minutes, every minute while this page is open.");
    healthPanel.replaceChildren(h("div", { class: "health-controls" }, h("div", { class: "health-counts", "aria-label": "Health counts" }, ...["down", "failing", "slow", "unknown", "up", "not-http"].map((key) => h("span", { class: `health-chip ${healthTone(key)}` }, `${healthLabel(key)} ${counts[key] || 0}`))), h("label", {}, "State", stateSelect), h("label", {}, "Kind", kindSelect), state.healthOff ? [] : h("button", { type: "button", disabled: checked.running, onclick: refreshHealth }, checked.running ? "Check running" : "Check now")), h("p", { class: "quiet", role: "status", "aria-live": "polite" }, statusText), table, workspace);
  }
  async function refreshHealth() {
    state.healthError = "";
    try {
      const response = await fetch("/api/services/health/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (response.status === 404) { state.healthOff = true; }
      else if (response.status === 409) state.healthError = result.error || "A health check is already running.";
      else if (!response.ok) state.healthError = result.error || `The health check failed (${response.status}).`;
      else state.health = healthEventReducer(state.health, { running: true, done: 0, total: state.health.targets.length });
      renderHealth();
    } catch (error) { state.healthError = error.message; renderHealth(); }
  }
  function renderTable() {
    if (tab() === "recipes") return renderRecipes();
    const name = tab(); const data = state.data;
    if (!data) return;
    protectedPanel.hidden = name !== "actions";
    let rows = name === "activity" ? data.events : name === "domains" && query("lens") === "domains-down" ? data.rows.filter((row) => ["origin-down", "dns-dangling"].includes(row.state)) : data.rows;
    if (name === "domains") { const sort = query("sort") || "hostname"; const direction = query("dir") === "desc" ? -1 : 1; rows = [...rows].sort((a, b) => String((sort === "machine" ? a.machineName : a[sort]) || "").localeCompare(String((sort === "machine" ? b.machineName : b[sort]) || "")) * direction); }
    table.caption.textContent = title(name);
    let headings;
    if (name === "services") headings = [heading("State", "state"), heading("Name", "name"), heading("Machine", "machine"), heading("Kind", "kind"), heading("Class / vendor", "class"), h("th", {}, "Exposure"), heading("Ports", "ports"), h("th", {}, "Pid"), h("th", {}, "Start mode"), heading("Last seen", "lastSeen")];
    else if (name === "domains") headings = [heading("State", "state"), heading("Hostname", "hostname"), heading("Via", "via"), h("th", {}, "Tunnel"), heading("Machine", "machine"), h("th", {}, "Origin"), h("th", {}, "Listener process"), h("th", {}, "Access")];
    else if (name === "actions") headings = [h("th", {}, "Time"), h("th", {}, "Machine"), h("th", {}, "Row"), h("th", {}, "Action"), h("th", {}, "State"), h("th", {}, "Message")];
    else headings = (name === "listeners" ? ["Port", "Bind", "Address", "Process / container", "PID", "Machine", "Class", "Joined service"] : ["Time", "Machine", "Event", "Summary"]).map((label) => h("th", {}, label));
    table.tHead.replaceChildren(h("tr", {}, headings));
    table.tBodies[0].replaceChildren(...rows.map((source) => {
      if (name === "domains") {
        const row = routeRow(source);
        const alerts = rowAlerts("route", row.id);
        return h("tr", {}, cell("State", [h("span", { class: `state-dot ${row.state}` }), row.stateLabel, alertMark(alerts), ...healthMarker(row.health)]), cell("Hostname", detailButton({ ...row, id: row.hostname, machineName: row.machineName || "unplaced" }, "route", row.hostnamePath, () => openRoute(row))), cell("Via", row.viaLabel), cell("Tunnel", row.tunnel ? `${row.tunnel.name}, ${row.tunnel.status}, ${row.tunnel.connections} connections` : row.worker?.script || "None"), cell("Machine", row.machineName || "Unplaced"), cell("Origin", row.originText, "mono"), cell("Listener process", row.listener?.processName || "None"), cell("Access", row.access ? `${row.access.name} (${row.access.policies})` : "No"));
      }
      if (name === "services") {
        const row = serviceRow(source);
        const alerts = rowAlerts("service", row.id);
        const readings = state.readings.get(row.id) || [];
        const marks = h("span", { class: "state-marks", role: "img", "aria-label": `State readings while this view is open: ${readings.map(stateLabel).join(", ")}`, title: "State readings while this view is open" }, ...readings.map((reading) => h("i", { class: reading })));
        const portCells = row.ports.flatMap((port, index) => [index ? ", " : "", String(port.port), ...healthMarker(port.health)]);
        return h("tr", { class: state.changed.has(row.id) ? "row-changed" : "" }, cell("State", [h("span", { class: `state-dot ${row.state}` }), row.stateText, alertMark(alerts), row.control?.protected?.protected ? h("span", { class: "protected-mark", title: `Protected: ${protectedLabel(row.control.protected.group)}`, "aria-label": `Protected: ${protectedLabel(row.control.protected.group)}` }, "Lock") : [], marks]), cell("Name", [detailButton(row, "service", row.name, () => openService(row)), h("small", { class: "quiet" }, row.displayName || row.name), ...descriptionCell(row), ...flagRow(row.flags)]), cell("PID", row.pidText, "mono"), cell("Machine", row.machineName), cell("Kind", row.kindText), cell("Class / vendor", classChip(row)), cell("Exposure", h("span", { class: `exposure ${row.exposure}` }, row.exposureText)), cell("Ports", portCells.length ? portCells : "None", "mono"), cell("Pid", row.pidText, "mono"), cell("Start mode", row.startMode || "Unknown"), cell("Last seen", date(row.lastSeenAt), "mono"));
      }
      if (name === "listeners") {
        const row = listenerRow(source);
        const alerts = rowAlerts("listener", row.id);
        return h("tr", {}, cell("Port", [alertMark(alerts), ...healthMarker(row.health), row.control?.protected?.protected ? h("span", { class: "protected-mark", title: `Protected: ${protectedLabel(row.control.protected.group)}`, "aria-label": `Protected: ${protectedLabel(row.control.protected.group)}` }, "Lock") : [], detailButton(row, "listener", String(row.port), () => openListener(row))]), cell("Bind", h("span", { class: `exposure ${row.bind}` }, row.exposureText)), cell("Address", row.address, "mono"), cell("Process / container", [row.name, h("small", { class: "quiet" }, row.containerImage || row.processPath || "Unknown path"), ...descriptionCell(row), ...flagRow(row.flags)]), cell("Machine", row.machineName), cell("Class", classChip(row)), cell("Joined service", row.joinedText));
      }
      if (name === "actions") {
        const machine = state.machines.find((entry) => entry.id === source.machineId)?.name || source.machineId;
        const rowButton = h("button", { type: "button", class: "row-detail", onclick: () => openActionRow(source) }, source.name);
        const [label, tone] = actionState(source.state);
        return h("tr", {}, cell("Time", date(source.at), "mono"), cell("Machine", machine), cell("Row", rowButton), cell("Action", actionLine(source)), cell("State", h("span", { class: `action-state ${tone}` }, label)), cell("Message", source.message || ""));
      }
      return h("tr", {}, cell("Time", date(source.at), "mono"), cell("Machine", state.machines.find((machine) => machine.id === source.machineId)?.name || source.machineId), cell("Event", detailButton({ ...source, machineName: source.machineId }, "event", source.kind.replaceAll("_", " "), () => showDetail(source, "event"))), cell("Summary", source.summary));
    }), ...(rows.length ? [] : [h("tr", {}, h("td", { colspan: headings.length, class: "empty" }, "Nothing matches these filters."))]));
    if (name === "actions") tableStatus.replaceChildren("Actions - newest first", state.runningActions ? h("span", { class: "running-badge" }, `${state.runningActions} running`) : []);
    else tableStatus.textContent = name === "activity" ? `${rows.length} recent events (newest first)` : `${data.total} ${name}, ${rows.length} shown`;
    renderDescriptionFacet();
    more.hidden = name === "activity" ? rows.length < Math.min(200, state.limit) || state.limit >= 200 : name === "actions" || rows.length >= data.total;
    more.textContent = "Show more";
  }
  function renderRecipes() {
    protectedPanel.hidden = true; more.hidden = true;
    const rows = recipeFilter(state.recipes, query("recipeState") || "active");
    table.caption.textContent = "Launch recipes";
    table.tHead.replaceChildren(h("tr", {}, ...["Project", "Source", "Name", "Command", "Port", "State", "Last seen", "Actions"].map((label) => h("th", {}, label))));
    table.tBodies[0].replaceChildren(...rows.map((recipe) => h("tr", {},
      cell("Project", recipe.project), cell("Source", recipe.source), cell("Name", recipe.name),
      cell("Command", [h("div", { class: "recipe-command mono" }, recipeCommand(recipe)), recipe.detail ? h("small", { class: "quiet recipe-command mono" }, recipe.detail) : []]),
      cell("Port", recipe.port === null ? "None" : String(recipe.port), "mono"),
      cell("State", [recipe.gone ? "Gone" : title(recipe.state), recipe.reason ? h("small", { class: "quiet" }, recipe.reason) : [], recipe.state === "approved" && recipe.running !== null ? h("small", { class: "quiet" }, recipe.running ? "Running" : "Not running") : []]),
      cell("Last seen", date(recipe.lastSeenAt)),
      cell("Actions", recipeButtons(recipe).map((action) => h("button", { type: "button", onclick: () => action === "start" ? requestPlan(recipe, "recipe", "start") : action === "approve" ? approveRecipe(recipe) : decideRecipeRow(recipe, "reject") }, title(action))))
    )), ...(rows.length ? [] : [h("tr", {}, h("td", { colspan: 8, class: "empty" }, "No launch recipes found."))]));
    tableStatus.textContent = `${rows.length} launch recipes`;
  }
  function renderPorts() {
    const ports = portsState.ports || {};
    const reserved = ports.reserved || [];
    const ranges = (ports.ranges || []).map((range) => {
      const fill = rangeFill({ ...range, reserved });
      const label = `${range.name}, ${range.from} to ${range.to}, ${fill.used} of ${range.size} in use, next free ${range.next ?? "none"}`;
      const copied = h("span", { class: "quiet", role: "status", "aria-live": "polite" });
      const copy = h("button", { type: "button", disabled: range.next == null, onclick: async () => {
        const value = String(range.next);
        try { await navigator.clipboard.writeText(value); copied.textContent = `Copied ${value}`; }
        catch { const input = h("input", { value, "aria-label": "Next free port" }); portsPanel.append(input); input.select(); copied.textContent = `Select and copy ${value}`; }
      } }, "Copy next free port");
      let offset = 0;
      const barSegments = fill.segments.map((segment) => { const width = segment.count / range.size * 1000; const rect = h("rect", { class: `port-segment ${segment.type}`, x: offset, y: 0, width, height: 18 }); offset += width; return rect; });
      return h("article", { class: "port-range" }, h("h3", {}, range.name), h("p", { class: "quiet" }, range.note || ""), h("svg", { class: "port-bar", viewBox: "0 0 1000 18", role: "img", "aria-label": label }, ...barSegments), h("p", {}, `${fill.used} of ${range.size} in use. ${fill.reserved} reserved. ${fill.free} free.`), h("div", { class: "port-chips", "aria-label": "Used ports" }, ...(range.used || []).map((port) => h("span", { class: "port-chip mono" }, String(port)))), copy, copied);
    });
    const reservedTable = h("table", { class: "ports-table" }, h("caption", {}, "Reserved ports"), h("thead", {}, h("tr", {}, ...["Port", "Name", "State", "By", "Note"].map((name) => h("th", {}, name)))), h("tbody", {}, ...reserved.map((item) => h("tr", { class: item.state === "clash" ? "clash-row" : "" }, cell("Port", item.port, "mono"), cell("Name", item.name), cell("State", [item.state === "clash" ? h("span", { class: "clash-shape", "aria-hidden": "true" }, "!") : [], title(item.state)]), cell("By", item.by || "None"), cell("Note", item.note || ""))), ...(!reserved.length ? [h("tr", {}, h("td", { colspan: 5, class: "empty" }, "No reserved ports."))] : [])));
    portsPanel.replaceChildren(...(ranges.length ? ranges : [h("p", { class: "quiet" }, ports.file?.exists === false ? "No port registry yet. Add ranges and reserved ports to .scout-data/ports.json." : "No port ranges are configured.")]), reservedTable, h("section", { class: "port-clashes" }, h("h3", {}, "Clashes"), ports.clashes?.length ? h("ul", {}, ...ports.clashes.map((clash) => h("li", {}, clashText(clash)))) : h("p", { class: "quiet" }, "No port clashes.")), h("p", { class: "quiet" }, ports.file?.path || ".scout-data/ports.json"), ports.file?.error ? h("p", { class: "error", role: "status" }, ports.file.error) : []);
  }
  function renderStacks() {
    const stacks = stackFilter(stacksState.stacks, query("stackState") || "all");
    const filter = h("select", { "aria-label": "Stack state", onchange: (event) => change("stackState", event.target.value === "all" ? "" : event.target.value) }, ...[["all", "All states"], ...["ready", "partial", "running", "blocked"].map((value) => [value, stackStateLabel(value)])].map(([value, label]) => h("option", { value, selected: (query("stackState") || "all") === value }, label)));
    stacksPanel.replaceChildren(h("label", { class: "stack-filter" }, "State", filter), ...(stacks.length ? stacks.map((stack) => h("article", { class: "stack-card" }, h("header", {}, h("h3", {}, stack.label), h("span", { class: `stack-state ${stack.state}` }, stackStateLabel(stack.state))), h("ol", {}, ...stack.members.map((member) => h("li", { class: member.available ? "" : "stack-unavailable", "aria-label": stackMemberText(member) }, h("strong", {}, member.label), h("p", {}, member.detail), member.waitPort == null ? [] : h("small", { class: "quiet" }, `Wait for port ${member.waitPort} for ${member.waitSeconds || 30} seconds`), member.running === true ? h("span", { class: "quiet" }, "Running") : [], member.available === false ? h("p", { class: "error" }, member.reason || "This member is unavailable.") : []))), stack.state === "blocked" || stack.state === "running" ? [h("p", { class: "quiet" }, stack.state === "blocked" ? "This stack has unavailable members." : "Every member is already running."), state.controlAvailable ? stackPlanButton(stack, "Review start plan") : []] : [], state.controlAvailable && ["ready", "partial"].includes(stack.state) ? stackPlanButton(stack, "Start", true) : [])) : [h("p", { class: "quiet" }, "No stacks yet. Add stacks to .scout-data/stacks.json.")]), stacksState.error ? h("p", { class: "error", role: "status" }, stacksState.error) : [], stacksState.file?.error ? h("p", { class: "error", role: "status" }, stacksState.file.error) : [], h("p", { class: "quiet" }, stacksState.file?.path || ".scout-data/stacks.json"));
  }
  function stackPlanButton(stack, label, primary = false) {
    let button;
    button = h("button", { type: "button", class: primary ? "primary" : "", "data-stack-name": stack.name, onclick: () => requestPlan({ name: stack.name, label: stack.label }, "stack", "start", false, button) }, label);
    return button;
  }
  async function scanRecipeRows() {
    try {
      const response = await fetch("/api/services/recipes/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The recipe scan failed.");
      await load({ table: true }); announce.textContent = `Scout found ${result.found} recipes.`;
    } catch (error) { announce.textContent = error.message; tableStatus.textContent = error.message; }
  }
  function approveRecipe(recipe) {
    recipeOpener = document.activeElement;
    const error = h("p", { class: "error", role: "alert" });
    const confirm = h("button", { type: "button", class: "primary", onclick: async () => {
      confirm.disabled = true;
      if (await decideRecipeRow(recipe, "approve", error)) recipeDialog.close(); else confirm.disabled = false;
    } }, "Approve recipe");
    recipeDialog.replaceChildren(h("h2", { id: "recipe-title" }, "Approve launch recipe"), h("p", { class: "action-command mono" }, recipeCommand(recipe)), recipe.detail ? h("p", { class: "action-command mono" }, recipe.detail) : [], h("p", { class: "action-command mono" }, recipe.cwd), h("p", {}, "Scout will run this command in this directory whenever you press Start."), error, h("div", { class: "action-dialog-buttons" }, h("button", { type: "button", onclick: () => recipeDialog.close() }, "Cancel"), confirm));
    recipeDialog.showModal();
  }
  async function decideRecipeRow(recipe, decision, errorNode = null) {
    try {
      const response = await fetch("/api/services/recipes/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: recipe.id, decision, hash: recipe.hash, confirm: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The recipe could not be reviewed.");
      const reduced = recipeEventReducer(state.recipes, { recipe: result.recipe }); state.recipes = reduced.recipes; state.recipeCounts = reduced.counts; paintRecipeTab(); renderRecipes(); return true;
    } catch (error) { if (errorNode) errorNode.textContent = error.message; else tableStatus.textContent = error.message; announce.textContent = error.message; return false; }
  }
  function renderAlerts() {
    const selectedState = query("alertState") || "open";
    const selectedKind = query("alertKind");
    const rows = alertFilter(state.alerts, selectedState, selectedKind);
    let keyInput; let coverage; let form;
    const table = h("table", { class: "alerts-table" }, h("caption", { class: "sr-only" }, "Alerts"), h("thead", {}, h("tr", {}, ...["Severity", "Kind", "Title", "Machine", "Age", "State", "Detail"].map((label) => h("th", {}, label)))), h("tbody", {}, ...rows.map((alert) => h("tr", {},
      cell("Severity", h("span", { class: `alert-dot ${alertSeverityTone(alert.severity)}`, role: "img", "aria-label": alertSeverityLabel(alert.severity) })),
      cell("Kind", alertKindLabel(alert.kind)),
      cell("Title", alert.title),
      cell("Machine", alert.machineName || "All machines"),
      cell("Age", elapsedTime(Date.now() - Date.parse(alert.at))),
      cell("State", alert.muted ? "Muted" : title(alert.state)),
      cell("Detail", [h("p", {}, alert.detail), alert.target?.type && alert.target.id != null ? h("button", { type: "button", class: "row-detail", onclick: () => goToAlertTarget(alert) }, "Go to row") : [], alert.state === "open" && !alert.muted ? h("button", { type: "button", onclick: () => alertAction({ id: alert.id }) }, "Acknowledge") : [], alert.state === "open" && !alert.muted ? h("button", { type: "button", onclick: () => { keyInput.value = alert.key; renderMuteCoverage(coverage); form.hidden = false; keyInput.focus(); } }, "Mute") : [], alert.muted && pageMuteKey(alert) ? h("button", { type: "button", onclick: () => alertAction({ key: pageMuteKey(alert), remove: true }) }, "Remove mute") : alert.muted ? h("small", { class: "quiet" }, `Muted by a file rule in ${state.alertFile}.`) : []])
    ))));
    const stateSelect = h("select", { "aria-label": "Alert state", onchange: (event) => change("alertState", event.target.value) }, ...[["open", "Open"], ["acknowledged", "Acknowledged"], ["resolved", "Resolved"], ["all", "All"], ["muted", "Muted"]].map(([value, label]) => h("option", { value, selected: selectedState === value }, label)));
    const kindSelect = h("select", { "aria-label": "Alert kind", onchange: (event) => change("alertKind", event.target.value) }, h("option", { value: "", selected: !selectedKind }, "All kinds"), ...ALERT_KINDS.map((kind) => h("option", { value: kind, selected: selectedKind === kind }, alertKindLabel(kind))));
    keyInput = h("input", { type: "text", required: true, "aria-label": "Mute key", placeholder: "Alert key", oninput: () => renderMuteCoverage(coverage) });
    const reasonInput = h("input", { type: "text", "aria-label": "Mute reason", placeholder: "Optional reason" });
    coverage = h("p", { class: "quiet" });
    form = h("form", { class: "mute-form", hidden: true, onsubmit: async (event) => { event.preventDefault(); if (!keyInput.value.trim()) return; await alertAction({ key: keyInput.value.trim(), ...(reasonInput.value.trim() ? { reason: reasonInput.value.trim() } : {}) }); keyInput.value = ""; reasonInput.value = ""; renderMuteCoverage(coverage); form.hidden = true; } }, h("h3", {}, "Mute alerts"), keyInput, reasonInput, coverage, h("button", { type: "submit" }, "Mute"));
    alertsPanel.replaceChildren(h("div", { class: "alerts-controls" }, h("strong", {}, `${state.alertCounts.open || 0} open`), h("label", {}, "State", stateSelect), h("label", {}, "Kind", kindSelect), h("button", { type: "button", onclick: () => alertAction({ all: true, ...(selectedKind ? { kind: selectedKind } : {}) }) }, selectedKind ? `Acknowledge all ${alertKindLabel(selectedKind)}` : "Acknowledge all"), h("button", { type: "button", onclick: () => { form.hidden = false; keyInput.focus(); } }, "Mute")), state.alertError ? h("p", { class: "error", role: "status" }, state.alertError) : [], table, form,
      h("section", { class: "mute-list" }, h("h3", {}, "Current mutes"), state.mutes.length ? h("ul", {}, ...state.mutes.map((mute) => h("li", {}, h("code", {}, mute.match), mute.reason ? ` - ${mute.reason}` : "", mute.source === "page" ? h("button", { type: "button", onclick: () => alertAction({ key: mute.key, remove: true }) }, "Remove mute") : []))) : h("p", { class: "quiet" }, "No page mutes.")),
      h("p", { class: "quiet" }, `Ungated hosts are configured in ${state.alertFile}.`));
  }
  function renderMuteCoverage(node) {
    const key = alertsPanel.querySelector('[aria-label="Mute key"]')?.value || "";
    const covered = state.alerts.filter((alert) => muteCoverage(key, alert.key));
    node.textContent = key ? `This key covers ${covered.length} listed alert${covered.length === 1 ? "" : "s"}.` : "Use * and ? to match alert keys.";
  }
  function pageMuteKey(alert) { return state.mutes.find((mute) => mute.source === "page" && muteCoverage(mute.match, alert.key))?.key || ""; }
  async function alertAction(body) {
    try {
      const response = await fetch(`/api/services/alerts/${body.key ? "mute" : "ack"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The alert change failed.");
      if (result.mutes) state.mutes = result.mutes;
      state.alertError = "";
      await load({ table: true });
      window.dispatchEvent(new Event("scout-alert"));
    } catch (error) { state.alertError = error.message; renderAlerts(); }
  }
  function goToAlertTarget(alert) {
    const target = alert.target;
    if (target.type === "route") {
      const route = state.routes.find((row) => row.id === target.id || row.hostname === target.id);
      if (route) openRoute(route);
    } else if (target.type === "listener") {
      const row = state.listeners.find((item) => item.id === target.id);
      if (row) openListener(row);
    } else if (target.type === "service") {
      const row = state.dataTab === "services" ? state.data?.rows?.find((item) => item.id === target.id) || [] : [];
      if (row.id != null) openService(row);
      else { state.pendingAlertTarget = target; state.params = new URLSearchParams("view=services&tab=services"); syncUrl(); syncControls(); load({ table: true }); }
    }
  }
  function rememberFocus() {
    opener = document.activeElement;
    focusKey = opener?.dataset.detailId ? { id: opener.dataset.detailId, kind: opener.dataset.detailKind } : null;
  }
  function trapFocus(event) {
    if (event.key !== "Tab") return;
    const controls = [...detail.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  function restoreFocus() {
    state.detailController?.abort(); detailRow = null;
    if (opener?.isConnected && !root.hidden) opener.focus();
    else if (focusKey && !root.hidden) (root.querySelector(`[data-detail-id="${focusKey.id}"][data-detail-kind="${focusKey.kind}"]`) || tabs.querySelector('[aria-selected="true"]'))?.focus();
    else if (!root.hidden) tabs.querySelector('[aria-selected="true"]')?.focus();
  }
  function showDetail(row, kind, opening = true) {
    const refocus = !opening && detail.contains(document.activeElement);
    if (opening) { state.detailController?.abort(); rememberFocus(); }
    detailRow = row; detailKind = kind;
    const pairs = kind === "health" ? [["Kind", title(row.kind)], ["State", healthLabel(row.state)], ["Last answer", row.status ?? "No HTTP answer"], ["Latency", latencyText(row.latencyMs)], ["Last probe", date(row.lastProbeAt)], ["Last ok", date(row.lastOkAt)]] : kind === "route" ? [["Chain", row.chain], ["State", row.stateText], ["Machine confidence", row.confidenceText], ["DNS record", row.dns ? `${row.dns.type} ${row.dns.content}, proxied ${row.dns.proxied}` : "None"], ["Tunnel", row.tunnel ? `${row.tunnel.id}, ${row.tunnel.status}, ${row.tunnel.connections} connections` : "None"], ["Ingress rule", row.origin?.service || "None"], ["Access", row.access ? `${row.access.name}, ${row.access.policies} policies` : "None"], ["Worker", row.worker ? `${row.worker.pattern}, script ${row.worker.script}` : "None"]] : kind === "machine" ? [["OS", row.os], ["Live state", stateLabel(row.live.state)], ["Last live", date(row.live.lastLiveAt)], ["Error", row.live.error || "None"], ["Services", row.services.total], ["Running", row.services.running], ["Could disable", row.services.optionalRunning], ["Listening ports", row.listeners.total]] : kind === "event" ? [["Time", date(row.at)], ["Machine", row.machineId], ["Event", row.kind], ["Summary", row.summary], ["Detail", JSON.stringify(row.detail)]] : [["Machine", row.machineName], ["Program path", row.program || row.processPath || "Unknown"], ["Run as", row.runAs || "Unknown"], ["Start mode", row.startMode || "Unknown"], ["Triggers", row.triggers == null ? "None" : typeof row.triggers === "string" ? row.triggers : JSON.stringify(row.triggers)], ["Last run", date(row.lastRun)], ["Last result", row.lastResult == null ? "None" : String(row.lastResult)], ["First seen", date(row.firstSeenAt)], ["Last seen", date(row.lastSeenAt)], ...(row.goneAt ? [["Gone", date(row.goneAt)]] : []), ...(row.containerName ? [["Container", row.containerName], ["Container image", row.containerImage]] : [])];
    const ports = kind === "service" ? row.ports : kind === "listener" ? [row] : [];
    const classification = row.classification;
    const description = row.description;
    if (kind === "route" && description) pairs.splice(1, 0, ["What it is", description.text]);
    const openAlerts = kind === "route" || kind === "service" || kind === "listener" ? rowAlerts(kind, kind === "route" ? state.routes.find((route) => route.hostnamePath === row.hostnamePath)?.id : row.id) : [];
    if ((kind === "service" || kind === "listener") && row.flags?.length) pairs.push(["Provenance", row.flags.map((flag) => `${flag.label}: ${flag.evidence}`).join(" ")]);
    if (openAlerts.length) pairs.push(["Open alerts", openAlerts.map((alert) => `${alert.title}. ${alert.detail}`).join(" ")]);
    const descriptionInfo = description ? [h("p", { class: "quiet" }, `${descriptionSourceLabel(description.source, description.generated)}${description.generated && description.confidence != null ? ` - ${Math.round(description.confidence * 100)}% confidence` : ""} - ${date(description.at)}`), ...(description.source === "project" && description.evidence?.length ? [h("details", {}, h("summary", {}, "Evidence"), h("ul", {}, ...description.evidence.map((quote) => h("li", {}, quote))))] : [])] : [];
    const controlBlock = (kind === "service" || kind === "listener") && row.control ? [h("section", { class: "control-actions" }, h("h3", {}, "Actions"), row.control.protected?.protected ? h("p", { class: "protected-badge" }, `Protected: ${protectedLabel(row.control.protected.group)}. ${row.control.protected.reason || ""}`) : [], ...actionButtons(row).map((item) => h("div", { class: "control-action" }, h("button", { type: "button", disabled: !item.enabled, title: item.reason || "", onclick: () => requestPlan(row, kind, item.action) }, item.label), !item.enabled ? h("span", { class: "quiet" }, item.reason) : []))), h("details", { class: "uninstall", ontoggle: (event) => { if (event.currentTarget.open) loadUninstall(row, kind, event.currentTarget); } }, h("summary", {}, "How to remove"), h("p", { class: "quiet" }, "Loading instructions when opened."))] : [];
    const descriptionBlock = kind === "service" || kind === "listener" ? [h("section", { class: "what-it-is" }, h("h3", {}, "What it is"), h("p", {}, description?.text || "No description is available."), ...descriptionInfo, ...descriptionEditor(row, kind), ...controlBlock)] : [];
    const portHealth = kind === "service" ? row.ports.map((port) => port.health && (state.health.targets.find((target) => target.key === port.health.key) || { ...port.health, label: `${row.name}:${port.port}`, kind: "listener", url: `http://127.0.0.1:${port.port}/` })).filter(Boolean) : [];
    const health = kind === "health" ? row : row.health ? state.health.targets.find((target) => target.key === row.health.key) || { ...row, ...row.health, label: row.name || row.hostname, kind: row.hostname ? "domain" : "listener" } : null;
    const healthBlock = state.healthSupported ? (kind === "service" ? portHealth : health ? [health] : []).map(healthDetailBlock) : [];
    detail.replaceChildren(h("button", { type: "button", class: "detail-close", onclick: () => detail.close(), "aria-label": "Close details" }, "Close"), h("h2", { id: "services-detail-title" }, kind === "health" ? row.label : kind === "route" ? row.hostnamePath : row.displayName || row.name || row.processName || row.containerName || (kind === "event" ? "Activity detail" : `Port ${row.port}`)), ...descriptionBlock, ...healthBlock, h("dl", {}, ...pairs.flatMap(([label, value]) => [h("dt", { class: "quiet" }, label), h("dd", {}, value)])), ...(ports.length ? [h("h3", {}, "Joined ports"), h("ul", {}, ...ports.map((port) => h("li", { class: "mono" }, `${port.port} - ${exposureLabel(port.bind)} - ${port.address}`)))] : kind === "service" ? [h("p", { class: "quiet" }, "This service has no joined ports.")] : []), ...(classification ? [h("h3", {}, `Classification: ${classification.class}`), h("p", {}, `${classification.vendor} - ${classification.confidence} confidence`), h("ul", {}, ...classification.evidence.map((evidence) => h("li", {}, evidence))), ...(classification.whatBreaks ? [h("h3", {}, "What breaks"), h("p", {}, classification.whatBreaks)] : [])] : []));
    if (opening) detail.showModal();
    else if (refocus) detail.querySelector("button")?.focus();
  }
  function healthDetailBlock(target) {
    const history = target.history || [];
    const answers = history.filter((sample) => sample.ok && Number.isFinite(sample.latencyMs)).map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const middle = Math.floor(answers.length / 2);
    const median = answers.length ? answers.length % 2 ? answers[middle] : (answers[middle - 1] + answers[middle]) / 2 : null;
    const failures = history.filter((sample) => !sample.ok).length;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 240 48"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${median == null ? "No latency data" : `${latencyText(median)} median`}, ${failures} failure${failures === 1 ? "" : "s"} in the last ${history.length} checks`);
    const baseline = document.createElementNS("http://www.w3.org/2000/svg", "line"); baseline.setAttribute("x1", "0"); baseline.setAttribute("x2", "240"); baseline.setAttribute("y1", "47"); baseline.setAttribute("y2", "47"); baseline.setAttribute("class", "health-baseline"); svg.append(baseline);
    for (const points of sparkPoints(history)) { const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline"); line.setAttribute("points", points); line.setAttribute("class", "health-sparkline"); svg.append(line); }
    return h("section", { class: "health-detail" }, h("h3", {}, "Health"), h("p", { class: `health-state ${healthTone(target.state)}` }, healthLabel(target.state)), h("p", { class: "mono health-url" }, target.url || ""), h("p", {}, `Last answer: ${target.status ?? target.error ?? "None"}; latency: ${latencyText(target.latencyMs)}.`), svg, h("p", { class: "quiet" }, svg.getAttribute("aria-label")), ...(target.tlsDaysLeft == null ? [] : [h("p", {}, tlsText(target.tlsDaysLeft))]), state.healthOff ? [] : [h("button", { type: "button", disabled: state.health.probe.running, onclick: refreshHealth }, state.health.probe.running ? "Check running" : "Check now")]);
  }
  function refreshDetailHealth() {
    if (!detail.open || !detailRow) return;
    if (detailKind === "health") {
      const target = state.health.targets.find((entry) => entry.key === detailRow.key);
      if (target) showDetail(target, "health", false);
      return;
    }
    const embedded = detailKind === "service" ? detailRow.ports.find((port) => port.health)?.health : detailRow.health;
    if (!embedded?.key) return;
    const target = state.health.targets.find((entry) => entry.key === embedded.key);
    if (target) showDetail(detailKind === "service" ? detailRow : { ...detailRow, health: target }, detailKind, false);
  }
  function trapActionFocus(event) {
    if (event.key !== "Tab") return;
    const controls = [...actionDialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)')];
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  async function requestPlan(row, kind, action, hard = false, source = null) {
    if (kind === "stack") {
      try {
        stackOpenerName = row.name;
        actionOpener = source || document.activeElement;
        const response = await fetch("/api/services/actions/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: row.name, action }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "The plan could not be read.");
        stackProgress = [];
        actionDialogState = controlDialogReducer(actionDialogState, { type: "plan", plan: result.plan });
        renderActionDialog(); if (!actionDialog.open) actionDialog.showModal(); actionDialog.querySelector(".action-cancel")?.focus();
      } catch (error) { announce.textContent = error.message; }
      return;
    }
    const target = kind === "recipe" ? "recipe" : kind === "listener" ? "listener" : "service";
    try {
      const response = await fetch("/api/services/actions/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, id: row.id, action, hard }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The plan could not be read.");
      actionDialogState = controlDialogReducer(actionDialogState, { type: "plan", plan: result.plan });
      renderActionDialog();
      if (!actionDialog.open) actionDialog.showModal();
      actionDialog.querySelector(".action-cancel")?.focus();
    } catch (error) { announce.textContent = error.message; }
  }
  function renderActionDialog() {
    const plan = actionDialogState.plan;
    if (!plan) return;
    const model = planDialogModel(plan);
    let content;
    if (actionDialogState.phase === "progress") {
      const elapsed = Math.max(0, Math.floor((Date.now() - actionDialogState.startedAt) / 1000));
      content = [h("h2", { id: "action-title" }, "Action in progress"), h("p", { role: "status", "aria-live": "polite" }, `${actionDialogState.action?.state || "running"} - ${elapsed} seconds`), h("p", { class: "quiet" }, actionDialogState.action?.message || (plan.admin === "sudo" ? "Waiting for the change (up to 10 minutes)." : "Waiting for the result.")), plan.target === "stack" ? h("ol", { class: "stack-progress" }, ...stackProgress.map((entry) => h("li", {}, entry))) : [], plan.admin === "sudo" ? h("div", { class: "action-command mono" }, plan.sudoCommand, copyButton(plan.sudoCommand)) : []];
    } else if (actionDialogState.phase === "result") {
      const row = actionDialogState.action || {};
      content = [h("h2", { id: "action-title" }, actionState(row.state)[0]), h("p", { role: row.state === "failed" ? "alert" : "status" }, row.message || actionState(row.state)[0]), row.state === "failed" && model.hardStopLabel ? h("button", { type: "button", onclick: () => requestPlan({ id: plan.rowId }, plan.target, "stop", true) }, "Stop hard") : []];
    } else if (actionDialogState.phase === "error") content = [h("h2", { id: "action-title" }, "Start again"), h("p", { role: "alert" }, actionDialogState.error)];
    else {
      content = [h("h2", { id: "action-title" }, model.heading), plan.target === "stack" ? [] : h("p", {}, `The command runs on ${plan.machineName}.`), plan.target === "stack" ? h("ol", { class: "stack-plan-steps" }, ...model.steps.map((step) => h("li", {}, h("strong", {}, step.label), step.skipped ? h("s", {}, "Already running") : h("code", { class: "mono" }, step.command)))) : h("div", { class: "action-command mono" }, model.command, copyButton(model.command)), model.hardWarning ? h("p", { class: "warning" }, model.hardWarning) : [], plan.whatBreaks ? h("p", { class: "warning" }, plan.whatBreaks) : [], model.effects.length ? h("ul", {}, ...model.effects.map((effect) => h("li", {}, effect))) : [], model.admin ? h("p", {}, model.admin) : [], model.gracefulNote ? h("p", { class: "quiet" }, model.gracefulNote) : [], !plan.allowed ? h("p", { class: "error", role: "alert" }, plan.refusal || "This action is unavailable.") : []];
    }
    const cancel = h("button", { type: "button", class: "action-cancel", onclick: () => actionDialog.close() }, "Cancel");
    const confirm = actionDialogState.phase === "plan" && plan.allowed ? h("button", { type: "button", class: "primary", onclick: submitAction }, plan.target === "stack" ? `Start ${plan.name} (${plan.steps.length} steps)` : plan.action === "stop" ? `Stop ${plan.displayName || plan.name} on ${plan.machineName}` : `${plan.action[0].toUpperCase()}${plan.action.slice(1)} ${plan.displayName || plan.name} on ${plan.machineName}`) : [];
    actionDialog.replaceChildren(...content, h("div", { class: "action-dialog-buttons" }, cancel, confirm));
  }
  function copyButton(text) { return h("button", { type: "button", onclick: async () => { await navigator.clipboard.writeText(text); announce.textContent = "Command copied."; } }, "Copy"); }
  async function submitAction() {
    const plan = actionDialogState.plan;
    const startedAt = Date.now(); actionDialogState = controlDialogReducer(actionDialogState, { type: "confirm", startedAt }); renderActionDialog();
    try {
      const response = await fetch("/api/services/actions/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
      const result = await response.json();
      if (response.status === 404 || response.status === 409) throw new Error("The plan is out of date. Plan it again.");
      if (!response.ok) throw new Error(result.error || "The action could not be started.");
      if (result.state === "waiting") { actionDialogState.action = { state: "waiting", message: "Waiting for the change (up to 10 minutes)." }; renderActionDialog(); }
    } catch (error) { actionDialogState = controlDialogReducer(actionDialogState, { type: "error", message: error.message }); renderActionDialog(); }
  }
  async function loadUninstall(row, kind, details) {
    if (details.dataset.loaded) return;
    details.dataset.loaded = "true";
    try {
      const data = await fetchJson(`/api/services/uninstall?target=${kind}&id=${row.id}`);
      details.replaceChildren(h("summary", {}, "How to remove"), h("h4", {}, data.title || "Removal instructions"), data.available ? h("ol", {}, ...data.steps.map((step) => h("li", {}, step))) : h("p", {}, "No removal instructions are available."), data.leftovers?.length ? h("p", {}, `Leftovers: ${data.leftovers.join(" ")}`) : [], h("p", {}, data.note || "Scout never runs an uninstall."), data.command ? h("div", { class: "action-command mono" }, data.command, copyButton(data.command)) : []);
    } catch (error) { details.append(h("p", { class: "error" }, error.message)); }
  }
  async function openActionRow(action) {
    if (action.target === "recipe") { change("tab", "recipes"); return; }
    const target = action.target === "listener" ? "listeners" : "services";
    try {
      const data = await fetchJson(`/api/${target}?machine=${encodeURIComponent(action.machineId)}&all=1&limit=500`);
      const row = data.rows.find((entry) => entry.id === action.rowId);
      if (row) target === "listeners" ? openListener(listenerRow(row)) : openService(serviceRow(row));
    } catch {}
  }
  async function loadProtected(details) {
    if (details.dataset.loaded) return;
    details.dataset.loaded = "true";
    try {
      const data = await fetchJson("/api/services/protected");
      const body = details.querySelector("div");
      body.replaceChildren(h("p", { class: "quiet" }, `Edit ${data.file} to change custom rules.`), h("ul", {}, ...data.groups.map((group) => h("li", {}, h("strong", {}, group.label), ` - ${group.enabled ? "On" : "Off"}${group.alwaysOn ? ", always on" : ""}. ${group.reason}`))), ...(data.custom || []).map((rule) => h("p", {}, `${rule.machine}: ${rule.match} - ${rule.reason}`)));
    } catch (error) { details.querySelector("div").replaceChildren(h("p", { class: "error" }, error.message)); }
  }
  function descriptionEditor(row, kind) {
    if (descriptionEditing) {
      const textarea = h("textarea", { class: "description-input", rows: "5", minlength: "8", maxlength: "400", "aria-label": "Description text" }, descriptionDraft ?? row.description?.text ?? "");
      const counter = h("span", { class: "quiet", "aria-live": "polite" }, `${textarea.value.length} of 400`);
      const error = h("p", { class: "error", role: "status", hidden: !descriptionError }, descriptionError);
      textarea.addEventListener("input", () => { textarea.value = textarea.value.replace(/[\r\n]/g, " "); descriptionDraft = textarea.value; counter.textContent = `${textarea.value.length} of 400`; });
      return [textarea, counter, error, h("div", { class: "description-actions" }, h("button", { type: "button", onclick: () => saveDescription(row, kind, textarea.value, false) }, "Save"), h("button", { type: "button", onclick: () => { descriptionDraft = null; transitionDescription({ type: "cancel" }); showDetail(row, kind, false); detail.querySelector(".description-edit")?.focus(); } }, "Cancel"), ...(row.description?.hasHandEdit ? [h("button", { type: "button", onclick: () => saveDescription(row, kind, null, true) }, "Revert to automatic")] : []))];
    }
    return [h("button", { type: "button", class: "description-edit", onclick: () => { descriptionDraft = row.description?.text || ""; transitionDescription({ type: "edit" }); showDetail(row, kind, false); detail.querySelector("textarea")?.focus(); } }, "Edit"), ...(descriptionError ? [h("p", { class: "error", role: "status" }, descriptionError)] : [])];
  }
  async function saveDescription(row, kind, text, reverting) {
    let response; let result;
    try {
      response = await fetch("/api/services/description", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: kind, id: row.id, text }) });
      result = await response.json();
    } catch (error) { transitionDescription({ type: "error", message: error.message }); showDetail(row, kind, false); detail.querySelector(".description-input")?.focus(); return; }
    if (!response.ok) { transitionDescription({ type: "error", message: result.error || `The save failed (${response.status}).` }); showDetail(row, kind, false); detail.querySelector(".description-input")?.focus(); return; }
    row.description = result.description;
    descriptionDraft = null;
    transitionDescription({ type: "saved" });
    if (state.data?.rows) renderTable();
    showDetail(row, kind, false);
    detail.querySelector(".description-edit")?.focus();
    announce.textContent = reverting ? "The hand edit was removed." : "The description was saved.";
  }
  function openService(row) { showDetail(row, "service"); }
  function openRoute(row) { showDetail(routeRow(row), "route"); }
  function showDomains() { state.params.set("tab", "domains"); state.limit = PAGE; syncUrl(); syncControls(); load({ table: true }); }
  function openMachine(row) { showDetail(row, "machine"); }
  async function openListener(row) {
    showDetail(row, "listener");
    if (!row.serviceName) return;
    const controller = new AbortController(); state.detailController = controller;
    try {
      const params = new URLSearchParams({ machine: row.machineId, q: row.serviceName });
      if (row.classification.hidden) params.set("all", "1");
      const data = await fetchRows("services", params, controller.signal, true);
      const joined = data.rows.find((service) => service.name === row.serviceName && service.kind === row.serviceKind);
      if (detailRow !== row || !detail.open) return;
      if (joined) detail.append(h("p", { class: "quiet joined-description" }, `Joined service: ${joined.displayName || joined.name}${joined.description ? ` - ${joined.description.text}` : ""}`));
      else detail.append(h("p", { class: "quiet" }, "The joined service is no longer present in the catalog."));
    } catch (error) { if (error.name !== "AbortError" && detail.open) detail.append(h("p", { class: "error" }, `The joined service could not be read. ${error.message}`)); }
  }
  function paintProgress() {
    const now = Date.now();
    for (const [key, probe] of Object.entries(state.probes)) if (probe.expiresAt && probe.expiresAt < now) delete state.probes[key];
    if (state.edgeProgress?.expiresAt && state.edgeProgress.expiresAt < now) state.edgeProgress = null;
    progress.replaceChildren(...Object.values(state.probes).map((probe) => {
      const machine = state.machines.find((machine) => machine.id === probe.machineId)?.name || probe.machineId;
      const label = probe.probe === "win-tasks" ? `Reading scheduled tasks on ${machine}` : `Reading ${probe.label} on ${machine}`;
      const result = probe.phase === "start" ? "" : probe.phase === "done" ? " - done" : ` - failed${probe.message ? `: ${probe.message}` : ""}`;
      return h("div", { class: `probe ${probe.phase}` }, h("span", {}, `${label} - ${elapsedTime(probeElapsed(probe, now))}${result}`), ...(probe.phase === "start" ? [h("div", { class: "probe-bar", role: "progressbar", "aria-label": label, "aria-valuetext": "The duration is unknown" }, h("span", { class: "probe-sweep" }))] : []));
    }));
    if (state.edgeProgress) {
      const edge = state.edgeProgress;
      const elapsed = Math.floor((now - Date.parse(edge.startedAt || new Date(edge.receivedAt).toISOString())) / 1000);
      const ending = edge.phase === "done" ? " - done" : edge.phase === "failed" ? ` - failed${edge.message ? `: ${edge.message}` : ""}` : "";
      progress.append(h("div", { class: `probe ${edge.phase}` }, h("span", {}, `Reading Cloudflare - ${elapsedTime(elapsed * 1000)}${ending}`), ...(edge.phase === "start" ? [h("div", { class: "probe-bar", role: "progressbar", "aria-label": "Reading Cloudflare", "aria-valuetext": "The duration is unknown" }, h("span", { class: "probe-sweep" }))] : [])));
    }
    const running = Object.values(state.probes).some((probe) => probe.phase === "start" && (!query("machine") || probe.machineId === query("machine")));
    refresh.disabled = running;
    refresh.textContent = running ? "Refresh running" : "Refresh now";
    refreshEdge.disabled = state.edgeProgress?.phase === "start";
    refreshEdge.textContent = refreshEdge.disabled ? "Cloudflare refresh running" : "Refresh Cloudflare";
    paintDescribe();
  }
  function tick() { paintProgress(); if (actionDialog.open && actionDialogState.phase === "progress") renderActionDialog(); }
  function paintDescribe() {
    const run = state.describe;
    const progressState = run ? describeProgress(run) : null;
    const off = !!state.describeError;
    refreshDescriptions.disabled = off || run?.state === "running";
    const todo = state.descriptionOverview?.public?.todo ?? 0;
    refreshDescriptions.textContent = `Describe from public names (${todo})`;
    const project = state.descriptionOverview?.project;
    const projectOff = !project || project.state === "off";
    refreshProjects.disabled = projectOff || project.state === "busy" || run?.state === "running";
    refreshProjects.textContent = `Describe my projects${project ? ` (${project.todo})` : ""}`;
    refreshProjects.title = projectOff ? project?.reason || "Project descriptions are off." : project.state === "busy" ? "Cogitator is busy." : "";
    describeStatus.textContent = state.describeError || state.describeMessage || progressState?.label || `${todo} names ready`;
    const existing = progress.querySelector(".describe-progress");
    existing?.remove();
    if (run?.state === "running") {
      const bar = h("progress", { class: "describe-progress", max: run.total || 1, value: run.done || 0, "aria-label": "Public description progress" });
      progress.append(bar);
    }
  }
  async function refreshPublicDescriptions() {
    refreshDescriptions.disabled = true;
    state.describeError = ""; state.describeMessage = ""; paintDescribe();
    try {
      const response = await fetch("/api/services/descriptions/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "public" }) });
      const result = await response.json();
      if (response.status === 404) { state.describeError = "Descriptions need the model, which is off."; paintDescribe(); return; }
      if (!response.ok) throw new Error(result.error || `The description refresh failed (${response.status}).`);
      if (result.started) state.describe = { scope: "public", state: "running", done: 0, total: state.descriptionOverview?.public?.todo || 0, applied: 0 };
      paintDescribe();
    } catch (error) { state.describeError = error.message; paintDescribe(); }
  }
  async function refreshProjectDescriptions() {
    refreshProjects.disabled = true;
    state.describeError = ""; state.describeMessage = ""; paintDescribe();
    try {
      const response = await fetch("/api/services/descriptions/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "project" }) });
      const result = await response.json();
      if (response.status === 404) { state.describeError = "Project descriptions need the local model host, which is off."; paintDescribe(); return; }
      if (!response.ok) throw new Error(result.error || `The project description refresh failed (${response.status}).`);
      if (result.started) state.describe = { scope: "project", state: "running", done: 0, total: state.descriptionOverview?.project?.todo || 0, applied: 0 };
      else state.describeError = result.reason === "busy" ? "Cogitator is busy. Try again in a minute." : "A description pass is already running.";
      paintDescribe();
    } catch (error) { state.describeError = error.message; paintDescribe(); }
  }
  async function refreshCloudflare() {
    refreshEdge.disabled = true;
    try {
      const response = await fetch("/api/services/routes/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(`The Cloudflare refresh failed (${response.status}).`);
      const result = await response.json();
      if (result.started) {
        state.edgeProgress = edgeProgressReducer(state.edgeProgress, { phase: "start", startedAt: new Date().toISOString() });
        announce.textContent = "The Cloudflare refresh started.";
      } else announce.textContent = "A Cloudflare refresh is already running.";
      paintProgress();
    } catch (error) { announce.textContent = error.message; refreshEdge.disabled = false; }
  }
  async function refreshNow() {
    refresh.disabled = true;
    try {
      const response = await fetch("/api/services/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(query("machine") ? { machineId: query("machine") } : {}), slow: true }) });
      if (!response.ok) throw new Error(`The refresh failed (${response.status}).`);
      const result = await response.json();
      announce.textContent = result.started ? "The refresh started. The last results remain visible." : "A refresh is already running.";
      await load();
    } catch (error) { tableStatus.textContent = error.message; }
    finally { paintProgress(); }
  }
  function stopLive() {
    state.source?.close(); state.source = null;
    clearInterval(state.poll); state.poll = null;
    clearTimeout(state.debounce); state.pending = {};
  }
  function paused() {
    if (!state.shown || document.hidden) return;
    state.livePaused = true; paintLive();
    if (!state.poll) state.poll = setInterval(() => load({ overview: true, edgeOverview: true, routes: true }), 30000);
  }
  function startLive() {
    if (!state.shown || document.hidden || state.source) return;
    try {
      const source = new EventSource("/api/services/live"); state.source = source;
      source.onerror = paused;
      source.onopen = () => { state.livePaused = false; clearInterval(state.poll); state.poll = null; paintLive(); };
      const listen = (name, action) => source.addEventListener(name, (event) => { try { action(JSON.parse(event.data)); } catch { paused(); } });
      listen("hello", (event) => { for (const machine of event.machines) state.liveMachines.set(machine.id, machine); state.machines = state.machines.map((machine) => ({ ...machine, live: { ...machine.live, ...state.liveMachines.get(machine.id) } })); if (event.describe) { state.describe = event.describe; paintDescribe(); } if (event.actions) state.runningActions = event.actions.running; if (tab() === "actions" && state.data?.rows) renderTable(); paintLive(); paintAtlas(); });
      listen("hello", (event) => { if (event.alerts) { state.alertCounts = event.alerts; paintAlertTab(); window.dispatchEvent(new Event("scout-alert")); } });
      listen("hello", (event) => { if (event.health) { state.health = healthEventReducer(state.health, { health: event.health }); paintHealthTab(); } });
      listen("hello", (event) => { if (event.stacks) stacksState.stacks = stackEventReducer(stacksState.stacks, { stacks: event.stacks }); });
      listen("stack", (event) => { stacksState.stacks = stackEventReducer(stacksState.stacks, event); if (tab() === "stacks") renderStacks(); });
      listen("health", (event) => { state.health = healthEventReducer(state.health, event); paintHealthTab(); if (tab() === "health") renderHealth(); if (detail.open) refreshDetailHealth(); });
      listen("health-run", (event) => { state.health = healthEventReducer(state.health, event); if (tab() === "health") renderHealth(); if (detail.open) refreshDetailHealth(); });
      listen("recipe", (event) => {
        const result = recipeEventReducer(state.recipes, event); state.recipes = result.recipes; state.recipeCounts = result.counts;
        state.recipeSupported = true; paintRecipeTab(); if (tab() === "recipes") renderRecipes();
      });
      listen("hello", (event) => { if (event.recipes && state.recipeSupported) { state.recipeCounts = event.recipes; paintRecipeTab(); } });
      listen("alert", (event) => {
        const result = alertEventReducer(state.alerts, event); state.alerts = result.alerts; state.alertCounts = result.counts;
        paintAlertTab();
        if (tab() === "alerts") renderAlerts(); else if (state.data) renderTable();
        window.dispatchEvent(new Event("scout-alert"));
      });
      listen("action", (event) => {
        if (actionDialog.open && actionDialogState.plan?.target === "stack" && event.target !== "stack") { stackProgress = [...stackProgress, `${event.name}: ${event.state}${event.message ? ` - ${event.message}` : ""}`]; renderActionDialog(); }
        if (event.target === "recipe" && !["running", "waiting"].includes(event.state) && tab() === "recipes") load({ table: true });
        const result = actionEventReducer(state.actionRows, event); state.actionRows = result.items; state.runningActions = result.running;
        if (actionDialog.open && actionDialogState.plan?.rowId === event.rowId && actionDialogState.plan?.target === event.target) { actionDialogState = controlDialogReducer(actionDialogState, { type: "action", row: event }); renderActionDialog(); }
        if (tab() === "actions") { state.data = { total: result.items.length, rows: result.items }; renderTable(); }
      });
      listen("hello", (event) => { if (event.edge) { state.edge = event.edge; paintLive(); paintAtlas(); } });
      listen("edge", (event) => {
        state.edge = { ...state.edge, ...event };
        state.edgeProgress = edgeProgressReducer(state.edgeProgress, { phase: event.state === "fresh" ? "done" : "failed", startedAt: state.edgeProgress?.startedAt || event.lastReadAt, message: event.error });
        announce.textContent = event.state === "fresh" ? "The Cloudflare refresh finished." : `The Cloudflare refresh failed${event.error ? `: ${event.error}` : ""}`;
        paintProgress(); paintLive(); paintAtlas();
        if (event.changed) { state.pending.edgeOverview = true; state.pending.routes = true; if (tab() === "domains") state.pending.table = true; clearTimeout(state.debounce); state.debounce = setTimeout(() => { const routes = state.pending; state.pending = {}; load(routes); }, 300); }
      });
      listen("machine", (event) => { state.liveMachines.set(event.id, { ...state.liveMachines.get(event.id), ...event }); state.machines = state.machines.map((machine) => machine.id === event.id ? { ...machine, live: { ...machine.live, ...event } } : machine); paintLive(); paintAtlas(); });
      listen("probe", (event) => {
        const key = `${event.machineId}:${event.probe}`; const old = state.probes[key];
        state.probes = probeReducer(state.probes, event);
        if (!old || old.phase !== event.phase || old.startedAt !== event.startedAt) announce.textContent = `${event.label} on ${state.machines.find((machine) => machine.id === event.machineId)?.name || event.machineId}: ${event.phase === "start" ? "started" : event.phase}${event.message ? `. ${event.message}` : ""}`;
        paintProgress();
      });
      listen("describe", (event) => {
        state.describe = event; paintDescribe();
        if (event.state === "done") {
          state.describeMessage = `Added ${event.applied} descriptions`;
          paintDescribe();
          setTimeout(() => { state.describeMessage = ""; paintDescribe(); }, 6000);
          if (event.applied > 0) load({ overview: true, table: true, atlas: true, routes: true });
        } else if (event.state === "failed") { state.describeError = event.error || "The description pass failed."; paintDescribe(); }
      });
      listen("changed", (event) => {
        state.pending.overview = true;
        state.pending.edgeOverview = true;
        state.pending.routes = true;
        if (event.tables.includes("listeners")) state.pending.atlas = true;
        if (tab() === "recipes" && state.machines.some((machine) => machine.hub && machine.id === event.machineId) && event.tables.includes("listeners")) state.pending.table = true;
        if ((!query("machine") || query("machine") === event.machineId) && (tab() === "activity" || tab() === "services" && event.tables.some((name) => ["services", "listeners"].includes(name)) || tab() === "listeners" && event.tables.includes("listeners"))) state.pending.table = true;
        clearTimeout(state.debounce);
        state.debounce = setTimeout(() => { const routes = state.pending; state.pending = {}; load(routes); }, 300);
      });
    } catch { paused(); }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopLive(); clearInterval(state.tick); state.tick = null; state.controller?.abort(); }
    else if (state.shown) { load(); startLive(); state.tick = setInterval(tick, 1000); }
  });
  window.addEventListener("pagehide", () => { stopLive(); clearInterval(state.tick); state.controller?.abort(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted && state.shown) { load(); startLive(); state.tick = setInterval(tick, 1000); } });
  return {
    show(params) {
      state.shown = true; root.hidden = false; state.params = new URLSearchParams(params); state.phoneDefault = matchMedia("(max-width: 719px)").matches; state.limit = PAGE; state.data = null; tableStatus.textContent = "The catalog is loading.";
      syncControls(); paintSnapshot(); load(); startLive(); clearInterval(state.tick); state.tick = setInterval(tick, 1000);
    },
    hide() {
      state.shown = false; root.hidden = true; stopLive(); clearInterval(state.tick); clearTimeout(state.searchTimer); state.tick = null;
      state.controller?.abort(); state.detailController?.abort(); if (detail.open) detail.close();
      for (const frame of state.frames) cancelAnimationFrame(frame); state.frames.clear();
    },
    load,
  };
}
