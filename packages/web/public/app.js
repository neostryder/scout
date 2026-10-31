import { $, h, flagRow, marked, safeUrl, defaultDir, riskBadge, updateDialogModel, updatePlanQuery } from "./lib.js";
import { savedFilterControl } from "./saved-filters.js";
import { dependencyCard, discoveryControls } from "./dependency-cards.js";
import { upstreamSections } from "./intel-detail.js";
import { isLive, jobProgress, jobSummary } from "./jobs-model.js";

let windowPanel;
let servicesView;
let resourcesView;
let claudeView;
let competitorsView;
let traySettings;

const PAGE = 100;
const UPDATE_SORTS = ["priority", "name", "machine", "ecosystem", "source", "installed", "available", "status", "bump", "checked", "lastUsed", "category", "publisher", "firstSeen"];
const CATALOG_SORTS = ["name", "path", "machine", "source", "kind", "ecosystem", "version", "category", "publisher", "lastUsed", "firstSeen", "lastSeen", "useCount"];
const UPDATE_FACETS = [["machine", "Machine"], ["ecosystem", "Ecosystem"], ["source", "Source"], ["status", "Status"], ["bump", "Bump size"], ["category", "Category"], ["publisher", "Publisher"]];
const CATALOG_FACETS = [["machine", "Machine"], ["source", "Source"], ["kind", "Kind"], ["ecosystem", "Ecosystem"], ["category", "Category"], ["publisher", "Publisher"], ["scope", "Scope"], ["descriptionSource", "Description source"]];
const UPDATE_FLAGS = [["hasBeta", "Has beta"], ["hasUpstream", "Has newer upstream"], ["running", "Running now"], ["neverUsed", "Never used"], ["unknownUse", "Use unknown"], ["safe", "Hide updates that would break something"]];
const CATALOG_FLAGS = [["running", "Running now"], ["neverUsed", "Never used"], ["unknownUse", "Use unknown"], ["autostart", "Starts automatically"], ["ai", "Used by AI"], ["constrained", "Constrained"], ["libs", "Show libraries"]];
const CATALOG_DATES = [["seenBefore", "Seen before"], ["seenSince", "Seen since"], ["installedBefore", "Installed before"], ["newSince", "Installed since"]];
const state = { params: new URLSearchParams(location.search), rows: [], facets: {}, total: 0, updatable: 0, limit: PAGE, selected: new Map(), jobs: [], review: [], controller: null, sequence: 0, timer: null, poll: null, detailId: null, plans: [] };
const planReasons = new Map();
const view = () => state.params.get("view") || "updates";
const facets = () => view() === "updates" ? UPDATE_FACETS : CATALOG_FACETS;
const values = (name) => (state.params.get(name) || "").split(",").filter(Boolean);
const value = (name) => state.params.get(name) || "";
const title = (name) => name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

function url() { history.replaceState(null, "", state.params.toString() ? `?${state.params}` : location.pathname); savedFilters.sync(); }
function setParam(name, val, immediate = true) {
  if (val === "" || val === null) state.params.delete(name); else state.params.set(name, val);
  state.limit = PAGE;
  url();
  renderChips();
  if (immediate) load();
}
function toggle(name, val) { const now = values(name); setParam(name, (now.includes(val) ? now.filter((x) => x !== val) : [...now, val]).join(",")); }
function searchChanged() {
  setParam("q", $("search").value.trim(), false);
  clearTimeout(state.timer);
  state.controller?.abort();
  state.sequence++;
  state.timer = setTimeout(load, 35);
}
function sortKey() { return value("sort") || (view() === "updates" ? "priority" : "name"); }
function sortChanged(sort) {
  const current = sortKey();
  const direction = value("dir") || defaultDir(current);
  state.params.set("sort", sort);
  state.params.set("dir", current === sort ? (direction === "asc" ? "desc" : "asc") : defaultDir(sort));
  url(); load();
}
function makeGroup(name, children) {
  let closed = false;
  try { closed = localStorage.getItem(`scout.filters.${view()}.${name}`) === "closed"; } catch {}
  return h("details", { class: "filter-group", open: !closed, ontoggle: (e) => { try { localStorage.setItem(`scout.filters.${view()}.${name}`, e.target.open ? "open" : "closed"); } catch {} } }, h("summary", {}, name), ...children);
}
function selectField(name, label, options) {
  return h("label", { class: "field" }, label, h("select", { "aria-label": label, onchange: (e) => setParam(name, e.target.value) }, options.map(([v, text]) => h("option", { value: v, selected: value(name) === v }, text))));
}
function renderFilters() {
  const updates = view() === "updates";
  const root = $("filters");
  root.replaceChildren(
    ...facets().map(([name, label]) => makeGroup(label, [h("div", { class: "facet", id: `facet-${name}` })])),
    makeGroup("Use and state", [
      selectField("usedWithinDays", "Last used", [["", "Any time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last year"]]),
      h("div", { class: "toggles" }, (updates ? UPDATE_FLAGS : CATALOG_FLAGS).map(([name, label]) => h("label", {}, h("input", { type: "checkbox", checked: value(name) === "1", onchange: (e) => setParam(name, e.target.checked ? "1" : "") }), label))),
    ]),
    ...(updates ? [] : [
      makeGroup("Dates", CATALOG_DATES.map(([name, label]) => h("label", { class: "field" }, label, h("input", { type: "date", value: value(name), onchange: (e) => setParam(name, e.target.value) })))),
      makeGroup("Other", [
        h("label", { class: "field" }, "Path starts with", h("input", { type: "text", value: value("path"), oninput: (e) => { clearTimeout(state.timer); const text = e.target.value; state.timer = setTimeout(() => setParam("path", text), 35); } })),
        selectField("hasDescription", "Description", [["", "Any"], ["1", "Has description"], ["0", "No description"]]),
        selectField("presence", "Across machines", [["", "Any"], ["one", "One"], ["some", "Some"], ["all", "All"]]),
        selectField("versionKnown", "Version known", [["", "Any"], ["1", "Known"], ["0", "Unknown"]]),
        selectField("hasHomepage", "Homepage", [["", "Any"], ["1", "Has homepage"], ["0", "No homepage"]]),
      ]),
    ]),
  );
  renderFacetCounts();
}
function renderFacetCounts() {
  for (const [name] of facets()) {
    const box = $(`facet-${name}`);
    if (!box) continue;
    const counts = new Map((state.facets[name] || []).map(({ value, count }) => [String(value), count]));
    const checked = name === "status" && !state.params.has("status") ? ["updatable", "blocked", "upstream", "advisory"] : values(name);
    for (const val of checked) if (!counts.has(val)) counts.set(val, 0);
    box.replaceChildren(...[...counts].map(([val, count]) => h("label", { class: count ? "" : "zero" }, h("input", { type: "checkbox", checked: checked.includes(val), onchange: () => { if (name === "status" && !state.params.has("status")) state.params.set("status", checked.join(",")); toggle(name, val); } }), h("span", {}, val), h("span", { class: "n" }, Number(count).toLocaleString()))));
  }
}
function renderChips() {
  const chips = [];
  for (const [name, label] of facets()) for (const val of values(name)) chips.push(h("button", { class: "chip", type: "button", "aria-label": `Remove ${label} ${val}`, onclick: () => toggle(name, val) }, `${label}: ${val}`));
  for (const [name, val] of state.params) if (!["view", "sort", "dir", "q", ...facets().map(([n]) => n)].includes(name)) chips.push(h("button", { class: "chip", type: "button", "aria-label": `Remove ${title(name)} ${val}`, onclick: () => setParam(name, "") }, `${title(name)}: ${val}`));
  $("chips").replaceChildren(...chips);
}
function heading(label, sort, extra = {}) {
  const active = sortKey() === sort;
  const dir = value("dir") || defaultDir(sort);
  return h("th", { ...extra, "aria-sort": active ? (dir === "asc" ? "ascending" : "descending") : "none" }, h("button", { type: "button", class: "head-sort", onclick: () => sortChanged(sort) }, `${label} ${active ? (dir === "asc" ? "^" : "v") : ""}`));
}
function noteSummary(row) {
  const notes = row.notes || [];
  if (notes.length === 0) return [];
  return h("div", { class: "muted note", title: notes.join("\n") }, notes.length === 1 ? notes[0] : `${notes[0]} (and ${notes.length - 1} more)`);
}
function nameCell(row) { return h("td", { class: "name" }, h("div", { class: "t" }, marked(row.name, value("q"))), h("div", { class: "d" }, marked(row.description || "No description yet", value("q"))), ...flagRow(row.flags)); }
function rowBase(row, cells) { return h("tr", { tabindex: 0, "aria-selected": String(state.detailId === row.installId), onclick: () => openDetail(row.installId), onkeydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) openDetail(row.installId); } }, ...cells); }
function jobText(job) { return jobSummary(job); }
// A segmented bar of the stages the command reports, with the current one pulsing; a command with no stages shows a sweep.
function jobProgressView(job) {
  const progress = jobProgress(job);
  if (!progress) return [];
  const bar = progress.stages > 1
    ? h("ol", { class: "stages", role: "progressbar", "aria-label": "Update progress", "aria-valuemin": "0", "aria-valuemax": String(progress.stages), "aria-valuenow": String(progress.stage), "aria-valuetext": `Step ${progress.stage} of ${progress.stages}: ${progress.label}` }, ...Array.from({ length: progress.stages }, (_, index) => h("li", { class: index + 1 < progress.stage ? "done" : index + 1 === progress.stage ? "current" : "" })))
    : progress.stages === 1 ? h("div", { class: "stages sweep", role: "progressbar", "aria-label": "Update progress", "aria-valuetext": "The duration is unknown" }, h("span", {})) : [];
  return h("div", { class: "job-progress" }, h("div", { class: "muted" }, progress.label, progress.stages > 1 && progress.stage > 0 ? ` (step ${progress.stage} of ${progress.stages})` : "", progress.elapsed ? `, ${progress.elapsed}` : ""), bar, progress.attention ? h("div", { class: `warning needs-you ${job.attention.kind}`, role: "status" }, progress.attention) : []);
}
function renderTable() {
  const updates = view() === "updates";
  const columns = updates ? [heading("Name", "name"), heading("Machine", "machine"), heading("Installed", "installed"), heading("Available", "available"), heading("Source", "source"), heading("Status", "status"), heading("Bump", "bump"), heading("Checked", "checked"), h("th", {}, "Action")] : [heading("Name", "name"), heading("Machine", "machine"), heading("Source", "source"), heading("Version", "version"), heading("Category", "category"), heading("Last used", "lastUsed"), heading("Location", "path", { class: "path" })];
  $("table").tHead.replaceChildren(h("tr", {}, ...(updates ? [h("th", {}, "Select")] : []), ...columns));
  const body = $("table").tBodies[0];
  body.replaceChildren(...(state.rows.length ? state.rows.map((row) => updates ? updateRow(row) : catalogRow(row)) : [h("tr", {}, h("td", { colspan: updates ? 10 : 7, class: "empty" }, "Nothing matches these filters."))]));
  $("count").textContent = `${state.total.toLocaleString()} ${updates ? "updates" : "installs"}${updates ? `, ${state.updatable.toLocaleString()} updatable` : ""}`;
  $("more").hidden = state.rows.length >= state.total;
  $("more").textContent = `Show more (${Math.min(PAGE, state.total - state.rows.length)} left)`;
  labelCells($("table"));
  $("selection").hidden = !updates || !state.selected.size;
  $("update-selected").textContent = `Update ${state.selected.size} selected`;
}
function labelCells(table) {
  const names = [...table.tHead.rows[0].cells].map((cell) => cell.textContent.replace(/\s+[\^v]$/, "").trim());
  for (const row of table.tBodies[0].rows) [...row.cells].forEach((cell, index) => { if (names[index]) cell.dataset.label = names[index]; });
}
const autoUpdates = new Map();
const autoKey = (row) => `${row.machineId}:${row.packageId}`;
async function loadAutoUpdates() {
  try {
    const response = await fetch("/api/updates/auto-updates");
    if (!response.ok) return;
    autoUpdates.clear();
    for (const entry of (await response.json()).autoUpdates || []) autoUpdates.set(`${entry.machineId}:${entry.packageId}`, entry.maxBump);
  } catch { /* the toggle shows Off until the list loads */ }
}
/** Opts one program in to the automatic run, with the biggest version step it may take. */
function autoToggle(row) {
  const select = h("select", { class: "auto-update", "aria-label": `Update ${row.name} on ${row.machineId} automatically`, title: "Whether the automatic update run may update this program", onclick: (e) => e.stopPropagation(), onchange: async (e) => {
    e.stopPropagation(); e.target.disabled = true;
    try {
      const response = await fetch("/api/updates/auto-updates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installId: row.installId, maxBump: e.target.value || null }) });
      if (!response.ok) throw new Error((await response.json()).error || "The choice could not be saved");
      autoUpdates.clear();
      for (const entry of (await response.json()).autoUpdates || []) autoUpdates.set(`${entry.machineId}:${entry.packageId}`, entry.maxBump);
      windowPanel?.refresh();
    } catch (error) { $("count").textContent = error.message; }
    renderTable();
  } }, [["", "Auto: off"], ["patch", "Auto: patch"], ["minor", "Auto: up to minor"], ["major", "Auto: any update"]].map(([value, label]) => h("option", { value }, label)));
  select.value = autoUpdates.get(autoKey(row)) || "";
  return select;
}
function updateRow(row) {
  const job = state.jobs.find((j) => j.installId === row.installId) || row.job;
  const badge = row.risk ? riskBadge(row.risk) : null;
  const reason = planReasons.get(row.installId) || (row.blockedBy ? `Blocked: ${row.blockedBy}` : row.advisoryOnly ? "Advisory only" : "No installable update");
  const updateButton = h("button", { class: row.risk?.hard > 0 ? "primary muted-action" : "primary", type: "button", disabled: !row.updatable || !!job && !["done", "failed", "stopped"].includes(job.state), title: row.updatable ? badge?.text || "" : reason, "aria-label": row.updatable ? `Update ${row.name} on ${row.machineId}${badge ? `: ${badge.text}` : ""}` : `Cannot update ${row.name}: ${reason}`, onclick: (e) => { e.stopPropagation(); startPlan([row.installId]); } }, "Update");
  const canDownload = !row.updatable && !row.blockedBy && (row.downloadUrl || row.statuses?.some((status) => status === "upstream" || status === "advisory"));
  const button = canDownload ? h("button", { class: "button download", "data-install-id": String(row.installId), type: "button", disabled: !!job && !["done", "failed", "stopped"].includes(job.state), "aria-label": `Download ${row.name} to ${row.machineId}`, onclick: (e) => { e.stopPropagation(); startDownload(row, e.currentTarget); } }, "Download") : updateButton;
  return rowBase(row, [h("td", {}, h("input", { type: "checkbox", checked: state.selected.has(row.installId), "aria-label": `Select ${row.name} on ${row.machineId}`, onclick: (e) => e.stopPropagation(), onchange: (e) => { e.stopPropagation(); e.target.checked ? state.selected.set(row.installId, row.machineId) : state.selected.delete(row.installId); renderTable(); } })), nameCell(row), h("td", {}, row.machineId), h("td", {}, row.installed || "unknown"), h("td", {}, row.available || "no answer", row.upstream ? h("div", { class: "muted" }, `Upstream ${row.upstream}`) : [], row.beta ? h("div", { class: "muted" }, `Beta ${row.beta}`) : []), h("td", {}, row.availableSource || row.sourceKind || ""), h("td", { class: "status" }, job ? jobText(job) : row.statuses?.join(", ") || (row.updatable ? "updatable" : reason), job && isLive(job) ? jobProgressView(job) : [], badge ? h("div", {}, h("span", { class: badge.className, title: badge.title }, badge.text)) : [], row.priority != null ? h("div", { class: "muted", title: (row.priorityParts || []).map((part) => `${part.name} ${Math.round(part.value * 100)}%`).join(", ") }, `Priority ${Math.round(row.priority)}`) : [], noteSummary(row)), h("td", {}, row.bump || ""), h("td", {}, row.checkedAt || ""), h("td", {}, button, row.updatable ? autoToggle(row) : [])]);
}
function catalogRow(row) { return rowBase(row, [nameCell(row), h("td", {}, row.machineId), h("td", {}, row.sourceKind), h("td", {}, row.version || "unknown"), h("td", {}, row.category || ""), h("td", {}, row.lastUsed || ""), h("td", { class: "path", title: row.location }, row.location)]); }
async function load() {
  const current = view();
  if (current === "services" || current === "resources" || current === "claude" || current === "settings" || current === "competitors") return;
  state.controller?.abort();
  const controller = new AbortController(); state.controller = controller;
  const sequence = ++state.sequence;
  try {
    if (current === "review") { await loadReview(controller.signal, sequence); return; }
    if (current === "jobs") { await loadJobs(controller.signal, sequence); return; }
    const q = new URLSearchParams(state.params); q.delete("view"); q.set("limit", String(state.limit));
    if (current === "updates") await loadAutoUpdates();
    const response = await fetch(`/api/${current === "updates" ? "updates" : "installs"}?${q}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    if (sequence !== state.sequence || current !== view()) return;
    state.rows = data.rows; state.total = data.total; state.updatable = data.updatable || 0; state.facets = data.facets || {};
    renderFacetCounts(); renderTable();
    if (current === "updates") {
      const disabled = data.rows.filter((row) => !row.updatable && !planReasons.has(row.installId));
      Promise.all(disabled.map(async (row) => { try { const result = await (await fetch(`/api/updates/plan?installId=${row.installId}`)).json(); planReasons.set(row.installId, result.refusal || "No installable update"); } catch {} })).then(() => { if (sequence === state.sequence) renderTable(); });
    }
    if (current === "updates") $("updates-count").textContent = state.updatable ? String(state.updatable) : "";
  } catch (error) { if (error.name !== "AbortError" && sequence === state.sequence) $("count").textContent = error.message; }
}

async function openDetail(id) {
  state.detailId = id;
  const response = await fetch(`/api/installs/${id}`);
  if (!response.ok || state.detailId !== id) return;
  const d = await response.json();
  const panel = $("detail");
  const link = safeUrl(d.homepage);
  panel.replaceChildren(h("button", { type: "button", class: "close", onclick: closeDetail }, "Close"), h("h2", {}, d.name), h("p", { class: "muted" }, `${d.ecosystem} / ${d.key}`), h("p", {}, d.description || "No description yet."), h("dl", {}, ...[["Machine", d.machineId], ["Source", d.sourceKind], ["Version", d.version || "unknown"], ["Category", d.category], ["Publisher", d.publisher], ["Location", d.location], ["First seen", d.firstSeen], ["Last seen", d.lastSeen]].filter(([, v]) => v != null).flatMap(([label, val]) => [h("dt", {}, label), h("dd", {}, val)])), link ? h("p", {}, h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "Homepage")) : [], h("h3", {}, "Use"), h("ul", {}, (d.usage || []).map((u) => h("li", {}, `${u.kind}: ${u.available ? u.value || "none" : "unreadable"}`))), h("h3", {}, "Constraints"), h("ul", {}, (d.constraints || []).map((c) => h("li", {}, `${c.type}: ${c.spec} - ${c.origin}`))), h("h3", {}, "Related installs"), h("ul", {}, [...(d.relations || []).map((r) => ({ id: r.otherId, name: r.otherName })), ...(d.sameSoftware || [])].map((r) => h("li", {}, h("button", { type: "button", onclick: () => openDetail(r.id) }, r.name)))), h("h3", {}, "Raw details"), h("pre", {}, JSON.stringify(d.details || {}, null, 2)));
  const sections = [];
  for (const [label, edges, direction] of [["Needs", d.dependencies?.needs, "to"], ["Needed by", d.dependencies?.neededBy, "from"]]) {
    if (!edges?.length) continue;
    sections.push(h("h3", {}, label), h("ul", {}, edges.map((edge) => h("li", {}, `${edge[direction].name} (${edge.from.machine}) - ${edge.kind}${edge.constraint ? `, ${edge.constraint}` : ""}${edge.kind === "library" && edge.to.ecosystem === "brew" && edge.builtAgainst ? `, built against ${edge.builtAgainst}` : ""}`))));
  }
  if (d.supportWindows?.length) sections.push(h("h3", {}, "Support"), h("table", {}, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Cycle"), h("th", { scope: "col" }, "End date"), h("th", { scope: "col" }, "Status"))), h("tbody", {}, d.supportWindows.map((window) => h("tr", {}, h("td", {}, window.cycle), h("td", {}, window.eol || "no end date announced"), h("td", {}, [window.eolPassed && "Passed", window.lts && "LTS"].filter(Boolean).join(", ")))))));
  if (d.changelog) {
    const source = safeUrl(d.changelog.sourceUrl);
    sections.push(h("h3", {}, "Release notes"), h("p", { class: "release-summary" }, d.changelog.summary), source ? h("p", {}, h("a", { href: source, target: "_blank", rel: "noopener noreferrer" }, "Source")) : [], h("small", { class: "muted" }, d.changelog.model));
  }
  if (d.flags?.length) sections.push(h("h3", {}, "Provenance"), h("ul", {}, d.flags.map((flag) => h("li", {}, `${flag.label}: ${flag.evidence}`))));
  sections.push(...upstreamSections(d));
  const rawHeading = panel.children[panel.children.length - 2];
  for (const section of sections.flat(Infinity)) panel.insertBefore(section, rawHeading);
  panel.hidden = false; panel.scrollTop = 0;
  if (["updates", "catalog"].includes(view())) renderTable();
}
function closeDetail() { const wasOpen = !$("detail").hidden; state.detailId = null; $("detail").hidden = true; if (wasOpen && ["updates", "catalog"].includes(view())) renderTable(); }
document.addEventListener("click", (e) => { if (!$("detail").hidden && !$("detail").contains(e.target) && !$("confirm").open) { e.preventDefault(); e.stopPropagation(); closeDetail(); } }, true);
document.addEventListener("keydown", (e) => {
  const search = ["review", "jobs"].includes(view()) ? $(view()).querySelector("input[type=search]") : $("search");
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && !$("confirm").open) { e.preventDefault(); search?.focus(); }
  if (e.key === "Escape") { if (document.activeElement === search) { search.value = ""; if (view() === "review") { setParam("q", "", false); renderReview(); } else if (view() === "jobs") { setParam("q", "", false); renderJobs(); } else searchChanged(); } else if (!$("confirm").open) closeDetail(); }
});

async function startPlan(ids, machineId = null) {
  state.downloadPlan = null;
  $("confirm-title").textContent = "Confirm updates";
  $("confirm-submit").textContent = "Start updates";
  const selected = ids.map((installId) => ({ installId, machineId: machineId || state.selected.get(installId) || state.rows.find((row) => row.installId === installId)?.machineId }));
  const plans = await Promise.all(ids.map(async (id) => { try { const query = ids.length > 1 ? updatePlanQuery(id, selected) : `installId=${id}`; const r = await fetch(`/api/updates/plan?${query}`); if (!r.ok) throw new Error("Plan unavailable"); return await r.json(); } catch { return { installId: id, allowed: false, refusal: "Plan unavailable" }; } }));
  state.plans = plans;
  const allowed = plans.filter((p) => p.allowed);
  const refused = plans.filter((p) => !p.allowed);
  const disruptive = allowed.some((p) => p.disruptive);
  const admin = allowed.some((p) => p.needsAdmin);
  const soft = plans.some((p) => p.softConfirmation) ? updateDialogModel(plans) : { requiresSoftConfirmation: false };
  const refreshSubmit = () => { $("confirm-submit").disabled = !allowed.length || disruptive && !$("allow-disruptive")?.checked || admin && !$("allow-admin")?.checked || soft.requiresSoftConfirmation && !$("confirm-soft")?.checked; };
  const acknowledgement = disruptive ? h("label", { class: "warning" }, h("input", { id: "allow-disruptive", type: "checkbox", onchange: refreshSubmit }), "I understand this will close or restart the app") : null;
  const adminAcknowledgement = admin ? h("label", { class: "warning" }, h("input", { id: "allow-admin", type: "checkbox", onchange: refreshSubmit }), "Windows will ask for administrator permission. I am at this computer and will approve the prompt.") : null;
  const softAcknowledgement = soft.requiresSoftConfirmation ? h("section", { class: "warning" }, h("p", {}, "These installs or projects need a check before updating."), soft.projects.length ? h("p", {}, `Projects: ${soft.projects.join(", ")}`) : [], soft.dependents.length ? h("p", {}, `Dependents: ${soft.dependents.join(", ")}`) : [], h("label", {}, h("input", { id: "confirm-soft", type: "checkbox", onchange: refreshSubmit }), "I have checked these")) : null;
  const affects = (p) => {
    const breaks = [...(p.breaks?.hard || []), ...(p.breaks?.soft || [])];
    return breaks.length ? [h("h3", {}, "Also affects"), h("ul", {}, breaks.map((entry) => h("li", {}, `${entry.dependent.name} (${entry.dependent.machine}): ${entry.reason}`)))] : [];
  };
  $("confirm-body").replaceChildren(h("ul", {}, allowed.map((p) => h("li", {}, `${p.machineId}: ${p.name}, ${p.from || "unknown"} to ${p.to}`, h("pre", {}, p.command), (p.warnings || []).map((w) => h("div", { class: "warning" }, w)), affects(p)))), acknowledgement || [], adminAcknowledgement || [], softAcknowledgement || [], refused.length ? h("section", {}, h("h3", {}, "Cannot update"), h("ul", {}, refused.map((p) => h("li", {}, `${p.name || p.installId}: ${p.refusal}`, affects(p))))) : []);
  refreshSubmit();
  $("confirm").showModal();
}
async function submitPlans() {
  if (state.downloadPlan) return submitDownload();
  if ($("confirm-submit").disabled) return;
  const ids = state.plans.filter((p) => p.allowed).map((p) => p.installId);
  const response = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installIds: ids, confirm: true, allowDisruptive: !!$("allow-disruptive")?.checked, allowAdmin: !!$("allow-admin")?.checked, confirmSoft: !!$("confirm-soft")?.checked }) });
  const data = await response.json();
  if (!response.ok) { $("confirm-body").append(h("p", { role: "alert" }, data.error || data.refused?.map((entry) => entry.reason).join("; ") || "No updates were queued.")); return; }
  $("confirm").close(); state.selected.clear(); await pollJobs(); await load(); windowPanel?.refresh();
}
async function startDownload(row, button) {
  const label = button.textContent;
  button.disabled = true; button.textContent = "Checking..."; button.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(`/api/downloads/plan?installId=${row.installId}`);
    const plan = await response.json();
    if (!response.ok) throw new Error(plan.error || "Download plan unavailable");
    if (plan.kind === "page" && safeUrl(plan.url)) { window.open(plan.url, "_blank", "noopener,noreferrer"); return; }
    state.downloadPlan = plan;
    $("confirm-title").textContent = "Confirm download";
    $("confirm-submit").textContent = `Download to ${plan.machineId}`;
    $("confirm-submit").disabled = !plan.allowed || plan.kind !== "file";
    $("confirm-body").replaceChildren(h("dl", {}, ...[["File", plan.fileName || "No exact file"], ["Source", plan.source || "unknown"], ...(plan.size !== null ? [["Size", `${plan.size.toLocaleString()} bytes`]] : []), ["Checksum", plan.sha256 ? `checksum from ${plan.source}` : "no checksum available"], ["Machine", plan.machineId], ["Folder", plan.folder]].flatMap(([label, text]) => [h("dt", {}, label), h("dd", {}, text)])), ...(plan.warnings || []).map((warning) => h("p", { class: "warning" }, warning)), plan.refusal ? h("p", { role: "alert" }, plan.refusal) : []);
    $("confirm").showModal();
  } catch (error) { $("count").textContent = error.message; }
  finally { button.disabled = false; button.textContent = label; button.removeAttribute("aria-busy"); }
}
async function submitDownload() {
  const plan = state.downloadPlan;
  $("confirm-submit").disabled = true;
  try {
    const response = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "download", installIds: [plan.installId], confirm: true, url: plan.url, fileName: plan.fileName, size: plan.size, sha256: plan.sha256 }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Download was not queued");
    $("confirm").close(); state.downloadPlan = null; await pollJobs(); await load();
  } catch (error) { $("confirm-body").append(h("p", { role: "alert" }, error.message)); }
  finally { $("confirm-submit").disabled = false; }
}
// A prompt or installer window can sit behind other windows, so the tab title says when a job is waiting on a person.
const BASE_TITLE = document.title;
function flagNeedsYou() { document.title = state.jobs.some((j) => isLive(j) && j.attention) ? `Needs you - ${BASE_TITLE}` : BASE_TITLE; }
async function pollJobs() {
  try {
    const data = await (await fetch("/api/jobs?limit=50")).json();
    const previous = state.jobs;
    state.jobs = data.jobs;
    flagNeedsYou();
    if (view() === "updates") renderTable();
    if (view() === "jobs") renderJobs();
    if (data.jobs.some((j) => ["queued", "preflight", "running"].includes(j.state))) {
      if (!state.poll) state.poll = setInterval(pollJobs, 1500);
    } else if (state.poll) { clearInterval(state.poll); state.poll = null; }
    if (previous.some((j) => ["queued", "preflight", "running"].includes(j.state)) && data.jobs.some((j) => ["done", "failed", "stopped"].includes(j.state))) load();
  } catch {}
}
async function loadJobs(signal, sequence) { const data = await (await fetch("/api/jobs?limit=50", { signal })).json(); if (sequence !== state.sequence) return; state.jobs = data.jobs; renderJobs(); }
function renderJobs() {
  $("jobs").replaceChildren(h("label", { class: "search-label" }, "Search", h("input", { type: "search", value: value("q"), "aria-label": "Search jobs", oninput: (e) => { setParam("q", e.target.value, false); renderJobs(); restoreSearch("jobs", e.target.selectionStart); } })), h("h2", {}, "Recent jobs"), ...state.jobs.filter((j) => matches(`${j.name} ${j.machineId} ${j.state} ${j.download?.fileName || ""} ${j.finalPath || ""}`)).map((j) => h("article", { class: "proposal" }, h("div", { class: "job-head" }, h("strong", {}, `${j.machineId}: ${j.name}`), h("span", {}, j.action === "download" ? `Download: ${j.download?.fileName || "unknown file"}` : `${j.from || "unknown"} to ${j.to || "unknown"}`), j.finalPath ? h("span", {}, j.finalPath) : [], h("span", {}, jobText(j)), ["queued", "preflight", "running"].includes(j.state) ? h("button", { type: "button", onclick: async () => { await fetch(`/api/jobs/${j.id}/stop`, { method: "POST", headers: { "content-type": "application/json" } }); await pollJobs(); } }, "Stop") : []), isLive(j) ? jobProgressView(j) : [], h("details", {}, h("summary", {}, "Steps"), ...(j.steps || []).map((s) => h("div", {}, `${s.seq}. ${s.name}: ${s.state}`, h("pre", {}, s.output || "")))))));
}
function restoreSearch(root, position) { const input = $(root).querySelector("input[type=search]"); input.focus(); input.setSelectionRange(position, position); }
function matches(text) { const lower = text.toLowerCase(); return value("q").toLowerCase().split(/\s+/).filter(Boolean).every((term) => lower.includes(term)); }
async function loadReview(signal, sequence) { const data = await (await fetch("/api/proposals", { signal })).json(); if (sequence !== state.sequence) return; state.review = data; renderReview(); }
function renderReview() {
  const items = state.review.filter((p) => p.packages.some((k) => matches(`${k.name} ${k.description || ""} ${k.publisher || ""}`)));
  $("review").replaceChildren(discoveryControls(load), h("label", { class: "search-label" }, "Search", h("input", { type: "search", value: value("q"), "aria-label": "Search review queue", oninput: (e) => { setParam("q", e.target.value, false); renderReview(); restoreSearch("review", e.target.selectionStart); } })), h("h2", {}, "Review queue"), items.length ? [] : h("p", { class: "empty" }, "Nothing matches these filters."), ...items.map((p) => p.kind === "dependency_proposal" ? dependencyCard(p, decide) : h("article", { class: "proposal" }, h("p", {}, `Why: ${p.rule}`), h("div", { class: "pkgs" }, p.packages.map((k) => h("div", { class: "pkg" }, h("strong", {}, marked(k.name, value("q"))), h("div", {}, marked(k.description || "No description yet", value("q"))), h("div", {}, `${k.ecosystem} / ${k.key}`)))), h("div", { class: "actions" }, h("button", { type: "button", onclick: () => decide(p.id, true) }, "Same software: join"), h("button", { type: "button", onclick: () => decide(p.id, false) }, "Different: keep separate")))));
}
async function decide(id, accept) { const response = await fetch(`/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept }) }); if (response.ok) load(); }
function showView(next, initial = false) {
  if (!initial) state.params = new URLSearchParams();
  state.params.set("view", next); if (next === "updates") state.params.delete("view");
  state.limit = PAGE; state.rows = []; state.facets = {}; state.selected.clear(); closeDetail(); url();
  $("list-layout").hidden = !["updates", "catalog"].includes(next);
  $("review").hidden = next !== "review"; $("jobs").hidden = next !== "jobs"; $("settings").hidden = next !== "settings";
  if (next === "settings") openSettings();
  if (next === "services") openServices(); else servicesView?.hide();
  if (next === "resources") openResources(); else resourcesView?.hide();
  if (next === "claude") openClaude(); else claudeView?.hide();
  if (next === "competitors") openCompetitors(); else competitorsView?.hide();
  $("toggle-filters").hidden = !["updates", "catalog"].includes(next);
  $("plan-window").hidden = next !== "updates"; windowPanel?.hide();
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-current", String(button.dataset.view === next));
  if (["updates", "catalog"].includes(next)) { $("search").value = value("q"); renderFilters(); renderSorts(); renderChips(); }
  savedFilters.refresh();
  load();
}
// The Services, Resources, Settings, and Competitors pages are large, so each one's code is fetched the first time that page opens. If the page was left again while its code was loading, nothing is drawn.
async function openSettings() {
  const [{ createTraySettings }, { TEXT: TRAY_TEXT }] = await Promise.all([import("./tray-settings.js"), import("./tray-text.js")]);
  if (view() !== "settings") return;
  if (!traySettings) { traySettings = createTraySettings(); $("settings").replaceChildren(h("h1", {}, TRAY_TEXT.viewTitle), traySettings.section); }
  traySettings.load();
}
async function openServices() {
  const { createServicesView } = await import("./services.js");
  if (view() !== "services") return;
  servicesView ||= createServicesView($("services"));
  servicesView.show(state.params);
}
// The update-window planner loads the first time its button is pressed.
async function openWindowPlanner() {
  const { createWindowPanel } = await import("./update-window.js");
  windowPanel ||= createWindowPanel({ root: $("window"), button: $("plan-window"), startPlan: (ids, machineId) => startPlan(ids, machineId) });
  windowPanel.toggle();
}
async function openClaude() {
  const { createClaudeView } = await import("./claude.js");
  if (view() !== "claude") return;
  claudeView ||= createClaudeView($("claude"));
  claudeView.show();
}
async function openResources() {
  const { createResourcesView } = await import("./resources.js");
  if (view() !== "resources") return;
  resourcesView ||= createResourcesView($("resources"));
  resourcesView.show();
}
async function openCompetitors() {
  const { createCompetitorsView } = await import("./competitors.js");
  if (view() !== "competitors") return;
  competitorsView ||= createCompetitorsView($("competitors"));
  competitorsView.show();
}
function renderSorts() { const names = view() === "updates" ? UPDATE_SORTS : CATALOG_SORTS; $("sort").replaceChildren(...names.map((name) => h("option", { value: name, selected: sortKey() === name }, title(name)))); $("dir").value = value("dir") || defaultDir(sortKey()); }

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("search").addEventListener("input", searchChanged);
$("sort").addEventListener("change", (e) => sortChanged(e.target.value));
$("dir").addEventListener("change", (e) => setParam("dir", e.target.value));
$("plan-window").addEventListener("click", openWindowPlanner);
$("clear").addEventListener("click", () => { for (const key of [...state.params.keys()]) if (key !== "view") state.params.delete(key); $("search").value = ""; state.limit = PAGE; url(); renderFilters(); renderSorts(); renderChips(); load(); });
$("more").addEventListener("click", () => { state.limit += PAGE; load(); });
$("toggle-filters").addEventListener("click", (e) => { const open = $("filters").classList.toggle("open"); e.target.setAttribute("aria-expanded", String(open)); });
$("update-selected").addEventListener("click", () => startPlan([...state.selected.keys()]));
$("select-page").addEventListener("click", () => { for (const row of state.rows) if (row.updatable) state.selected.set(row.installId, row.machineId); renderTable(); });
$("clear-selection").addEventListener("click", () => { state.selected.clear(); renderTable(); });
$("confirm-cancel").addEventListener("click", () => $("confirm").close());
$("confirm-submit").addEventListener("click", submitPlans);
const initial = ["updates", "catalog", "review", "jobs", "services", "resources", "claude", "competitors", "settings"].includes(view()) ? view() : "updates";
window.addEventListener("popstate", () => { state.params = new URLSearchParams(location.search); showView(view(), true); });
const savedFilters = savedFilterControl($("saved-filters"), { view, query: () => state.params, apply: (spec) => {
  const current = view(); clearTimeout(state.timer);
  state.params = new URLSearchParams(spec); if (current === "catalog") state.params.set("view", current);
  state.limit = PAGE; state.selected.clear(); closeDetail(); url();
  $("search").value = value("q"); renderFilters(); renderSorts(); renderChips(); load();
} });
showView(initial, true);
fetch("/api/summary").then((r) => r.json()).then((s) => { $("summary").textContent = `${s.installs} installs, ${s.packages} packages`; $("review-count").textContent = s.openProposals || ""; }).catch(() => {});
pollJobs();
