import { h } from "./lib.js";
import { FAILURE_CLASSES, INCIDENT_PARAMS, incidentFilters, incidentCounts, filterIncidents, sortIncidents, relativeTime, isSnoozed, packetSections, snoozeMinutes } from "./incidents-model.js";

const date = (value) => value ? new Date(value).toLocaleString() : "Unknown";
const title = (value) => value[0].toUpperCase() + value.slice(1);

export function createIncidentsPanel({ onCount, onFilterChange }) {
  const panel = h("section", { id: "services-incidents-panel", role: "tabpanel", class: "incidents-panel", hidden: true, "aria-labelledby": "services-tab-incidents" });
  const model = { rows: null, error: "", loading: false, expanded: new Set(), details: new Map(), actions: new Map(), mute: new Set(), reasons: new Map(), hours: new Map() };
  let supported = true;
  let visible = false;
  let timer = null;
  let filters = incidentFilters(new URLSearchParams());
  let searchTimer = null;
  const summary = h("div", { class: "incident-summary" });
  const content = h("div", {});
  const change = (key, value) => {
    filters[key] = value;
    onFilterChange?.(INCIDENT_PARAMS[key], value === "active" ? "" : value);
    render();
  };
  const select = (name, options) => h("select", { "aria-label": `Incident ${name}`, onchange: (event) => change(name === "class" ? "failureClass" : name, event.target.value) }, ...options.map(([value, label]) => h("option", { value }, label)));
  const state = select("state", [["active", "Open and acknowledged"], ["all", "All states"], ["resolved", "Resolved"]]);
  const host = select("host", [["", "All hosts"]]);
  const failureClass = select("class", [["", "All classes"], ...FAILURE_CLASSES.map((value) => [value, value])]);
  const search = h("input", { type: "search", "aria-label": "Search incidents", placeholder: "Component or summary", oninput: () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => change("q", search.value), 150);
  } });
  const refreshButton = h("button", { type: "button", onclick: refresh }, "Refresh");
  panel.append(summary, h("div", { class: "alerts-controls" }, h("label", {}, "State", state), h("label", {}, "Host", host), h("label", {}, "Failure class", failureClass), h("label", {}, "Search", search), refreshButton), content);

  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 501 ? "No investigator is configured on this hub." : result.error || `The request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function setData(data) {
    model.rows = data.incidents || [];
    model.error = "";
    supported = true;
    onCount?.(incidentCounts(model.rows).attention);
    render();
  }

  function setError(message, status) {
    if (status === 404) { supported = false; updateTimer(); }
    model.error = status === 404 ? "Fleet incidents are not available on this hub." : message;
    onCount?.(supported ? incidentCounts(model.rows || []).attention : 0);
    render();
  }

  async function refresh() {
    if (model.loading) return;
    model.loading = true; refreshButton.disabled = true;
    try {
      setData(await request("/api/fleet/incidents?limit=200"));
      await Promise.all([...model.expanded].map(loadDetail));
    } catch (error) { setError(error.message, error.status); }
    finally { model.loading = false; refreshButton.disabled = false; }
  }

  async function loadDetail(id) {
    model.details.set(id, { ...model.details.get(id), loading: true });
    try { model.details.set(id, await request(`/api/fleet/incidents/${id}`)); }
    catch (error) { model.details.set(id, { error: error.message }); }
    render();
  }

  async function toggleDetail(id) {
    if (model.expanded.has(id)) model.expanded.delete(id);
    else { model.expanded.add(id); if (!model.details.has(id)) { render(); await loadDetail(id); return; } }
    render();
  }

  async function act(id, action, body = {}) {
    if (model.actions.get(id)?.pending) return;
    model.actions.set(id, { pending: true, message: "", error: false }); render();
    try {
      const result = await request(`/api/fleet/incidents/${id}/${action}`, body);
      const message = action === "investigate" ? `Investigation ${result.ok ? "ok" : "failed"}.${result.reference ? ` Reference: ${result.reference}.` : ""}${result.error ? ` ${result.error}` : ""}` : ({ ack: "Incident acknowledged.", snooze: "Incident snoozed.", mute: "Incident muted." })[action];
      model.actions.set(id, { pending: false, message, error: action === "investigate" && !result.ok });
      if (action === "mute") { model.mute.delete(id); model.reasons.delete(id); }
    } catch (error) { model.actions.set(id, { pending: false, message: error.message, error: true }); }
    await refresh();
    render();
  }

  function actions(row, location) {
    const pending = model.actions.get(row.id)?.pending;
    const key = (action) => `incident-${row.id}-${location}-${action}`;
    const hours = h("select", { "aria-label": `Snooze duration for ${row.component}`, disabled: pending, "data-focus": key("hours"), onchange: (event) => model.hours.set(row.id, event.target.value) }, ...[["1", "1 hour"], ["4", "4 hours"], ["24", "24 hours"]].map(([value, label]) => h("option", { value, selected: (model.hours.get(row.id) || "1") === value }, label)));
    return h("div", { class: "incident-actions" },
      h("button", { type: "button", disabled: pending, "data-focus": key("investigate"), onclick: () => act(row.id, "investigate") }, "Investigate"),
      h("button", { type: "button", disabled: pending || row.state !== "open", "data-focus": key("ack"), onclick: () => act(row.id, "ack") }, "Acknowledge"),
      hours, h("button", { type: "button", disabled: pending || row.state === "resolved", "data-focus": key("snooze"), onclick: () => act(row.id, "snooze", { minutes: snoozeMinutes(hours.value) }) }, "Snooze"),
      h("button", { type: "button", disabled: pending || row.muted, "data-focus": key("mute"), onclick: async () => {
        model.mute.add(row.id); model.expanded.add(row.id); render();
        if (!model.details.has(row.id)) await loadDetail(row.id);
        panel.querySelector(`[data-focus="incident-${row.id}-reason"]`)?.focus();
      } }, "Mute"));
  }

  function actionResult(id) {
    const result = model.actions.get(id);
    return result?.message ? h("p", { class: result.error ? "error" : "quiet", role: result.error ? "alert" : "status" }, result.message) : [];
  }

  function detail(row) {
    const data = model.details.get(row.id);
    const incident = data?.incident || row;
    const pending = model.actions.get(row.id)?.pending;
    const reason = h("input", { type: "text", required: true, minlength: "1", maxlength: "500", value: model.reasons.get(row.id) || "", "data-focus": `incident-${row.id}-reason`, oninput: (event) => model.reasons.set(row.id, event.target.value) });
    return h("tr", {}, h("td", { colspan: "11", id: `incident-detail-${row.id}` }, h("div", { class: "incident-detail" },
      h("h3", {}, `${row.host}: ${row.component}`), h("p", {}, incident.summary),
      h("dl", {}, h("dt", {}, "Owner chat"), h("dd", {}, incident.ownerChat || "Not set"), h("dt", {}, "Runbook"), h("dd", {}, incident.runbook || "Not set")),
      actions(row, "detail"),
      model.mute.has(row.id) ? h("form", { class: "mute-form", onsubmit: (event) => {
        event.preventDefault();
        const value = reason.value.trim();
        if (!value || value.length > 500) { model.actions.set(row.id, { message: "Enter a reason from 1 to 500 characters.", error: true }); render(); return; }
        act(row.id, "mute", { reason: value });
      } }, h("p", {}, "Mute stops future notifications for this host, component, and failure class until its rule is unmuted."), h("label", {}, "Reason (1 to 500 characters)", reason), h("div", { class: "incident-actions" }, h("button", { type: "submit", disabled: pending }, "Confirm mute"), h("button", { type: "button", disabled: pending, onclick: () => { model.mute.delete(row.id); render(); } }, "Cancel"))) : [],
      actionResult(row.id),
      h("h4", {}, "Evidence"), ...packetSections(incident.packet).map((section) => h("section", {}, h("h4", {}, section.label), h("pre", {}, section.text))),
      packetSections(incident.packet).length ? [] : h("p", { class: "quiet" }, "No evidence is recorded."),
      h("h4", {}, "Events"), data?.error ? h("p", { class: "error", role: "alert" }, data.error, " ", h("button", { type: "button", onclick: () => loadDetail(row.id) }, "Retry")) : data?.loading || !data ? h("p", { role: "status" }, "Reading events.") : data.events?.length ? h("ol", { class: "incident-events" }, ...data.events.map((event) => h("li", {}, h("time", { datetime: event.at, title: `${date(event.at)} (${event.at})` }, relativeTime(event.at)), " ", h("strong", {}, event.kind), event.detail ? h("pre", {}, String(event.detail)) : []))) : h("p", { class: "quiet" }, "No events are recorded."))));
  }

  function render() {
    const active = document.activeElement;
    const focus = panel.contains(active) ? active.dataset.focus : null;
    const selection = focus && active.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : null;
    const counts = incidentCounts(model.rows || []);
    summary.replaceChildren(h("div", { class: "incident-totals" }, ...[["Open", counts.open], ["Acknowledged", counts.acknowledged], ["Resolved", counts.resolved], ["Open critical", counts.critical]].map(([label, count]) => h("span", {}, label, " ", h("strong", {}, count)))), h("div", { class: "port-chips", "aria-label": "Open incidents by host" }, ...Object.entries(counts.hosts).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => h("button", { type: "button", "aria-pressed": String(filters.host === name), onclick: () => change("host", filters.host === name ? "" : name) }, `${name} (${count})`))));
    const hosts = [...new Set([...Object.keys(counts.hosts), filters.host].filter(Boolean))].sort();
    host.replaceChildren(h("option", { value: "" }, "All hosts"), ...hosts.map((name) => h("option", { value: name }, name)));
    state.value = filters.state; host.value = filters.host; failureClass.value = filters.failureClass;
    if (document.activeElement !== search) search.value = filters.q;
    const rows = sortIncidents(filterIncidents(model.rows || [], filters));
    content.replaceChildren(
      model.error ? h("p", { class: "error", role: "alert" }, model.error) : [],
      model.rows === null ? h("p", { class: "table-status", role: "status" }, model.error ? "" : "Reading incidents.") : [],
      model.rows && !counts.open ? h("p", { class: "table-status" }, "Nothing is open.") : [],
      model.rows && !rows.length ? h("p", { class: "empty" }, "No incidents match these filters.") : [],
      rows.length ? h("div", { class: "data-wrap" }, h("table", { class: "incident-table" }, h("caption", { class: "sr-only" }, "Fleet incidents"),
        h("thead", {}, h("tr", {}, ...["Severity", "Host", "Component", "Failure class", "Summary", "Count", "First seen", "Last seen", "State", "Notices", "Actions"].map((label) => h("th", { scope: "col" }, label)))),
        h("tbody", {}, ...rows.flatMap((row) => [h("tr", {},
          h("td", {}, h("span", { class: `health-state ${row.severity === "critical" ? "danger" : row.severity === "warning" ? "warn" : "quiet"}` }, h("span", { class: "state-dot", "aria-hidden": "true" }), title(row.severity))),
          h("td", {}, row.host), h("th", { scope: "row" }, h("button", { type: "button", "aria-expanded": String(model.expanded.has(row.id)), "aria-controls": `incident-detail-${row.id}`, "data-focus": `incident-${row.id}-expand`, onclick: () => toggleDetail(row.id) }, row.component)),
          h("td", {}, row.failureClass), h("td", {}, h("span", { class: "incident-summary-text", title: row.summary }, row.summary)), h("td", { class: "incident-number" }, row.count),
          ...[row.firstSeen, row.lastSeen].map((at) => h("td", {}, h("time", { datetime: at, title: `${date(at)} (${at})` }, relativeTime(at)))),
          h("td", {}, h("span", { class: `health-state ${row.state === "resolved" ? "ok" : row.state === "acknowledged" ? "warn" : "quiet"}` }, title(row.state))),
          h("td", { class: "quiet" }, [row.muted ? "Muted" : "", isSnoozed(row) ? `Snoozed until ${date(row.snoozedUntil)}` : ""].filter(Boolean).join("; ") || "Active"),
          h("td", {}, actions(row, "row"), actionResult(row.id))),
        model.expanded.has(row.id) ? detail(row) : h("tr", { hidden: true }, h("td", { colspan: "11", id: `incident-detail-${row.id}` }))])))) : []);
    if (focus) {
      const target = panel.querySelector(`[data-focus="${focus}"]`);
      target?.focus({ preventScroll: true });
      if (selection && target) target.setSelectionRange(...selection);
    }
  }

  function updateTimer() {
    clearInterval(timer); timer = null;
    if (visible && !document.hidden && supported) timer = setInterval(refresh, 30_000);
  }
  document.addEventListener("visibilitychange", () => { updateTimer(); if (visible && !document.hidden && supported) refresh(); });
  window.addEventListener("pagehide", () => { clearInterval(timer); clearTimeout(searchTimer); });
  window.addEventListener("pageshow", updateTimer);
  render();
  return {
    panel, refresh, setData, setError, supported: () => supported,
    setParams(params) { filters = incidentFilters(params); render(); },
    setVisible(value) { if (value === visible) return; visible = value; if (!visible) clearTimeout(searchTimer); updateTimer(); },
  };
}
