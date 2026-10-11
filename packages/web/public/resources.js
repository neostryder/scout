import { h } from "./lib.js";
import { activeAlertText, ageText, alertEdit, alertRows, isStale, machineTone, meterRows, pollMs, sparkSegments, summaryText, toneWord, topRows } from "./resources-model.js";

const SVG = "http://www.w3.org/2000/svg";

function spark(row) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 96 28");
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", row.spark.length ? `Last half hour of ${row.label.toLowerCase()}` : `${row.label} has no history chart`);
  for (const points of sparkSegments(row.spark, 96, 28, row.sparkMax)) {
    const line = document.createElementNS(SVG, points.includes(" ") ? "polyline" : "circle");
    if (line.tagName === "polyline") { line.setAttribute("points", points); line.setAttribute("fill", "none"); } else { const [x, y] = points.split(","); line.setAttribute("cx", x); line.setAttribute("cy", y); line.setAttribute("r", "1.5"); }
    svg.append(line);
  }
  return svg;
}

/** The Resources view: one card per machine, one rail row per meter, the biggest users of a meter one click away. */
export function createResourcesView(root) {
  let machines = [];
  let intervalSeconds = 10;
  let error = "";
  let loaded = false;
  let timer = null;
  let controller = null;
  let visible = false;
  const open = new Map();
  const status = h("p", { class: "resources-status", role: "status" }, "Reading the machines.");
  const cards = h("div", { class: "resource-cards" });
  const note = h("p", { class: "resources-note" });
  const alertsBox = h("details", { class: "alerts", hidden: true });
  const alertsActive = h("ul", { class: "alerts-active", "aria-live": "polite" });
  let alertStatus = null;
  let alertsBuilt = false;
  root.classList.add("resources");
  root.replaceChildren(h("header", { class: "resources-head" }, h("h1", {}, "Resources"), note), status, cards, alertsBox);

  function row(machine, meter) {
    const key = `${machine.machineId}:${meter.key}`;
    const expandable = meter.top !== null && topRows(machine, meter.top).length > 0;
    const expanded = expandable && open.get(key) === true;
    const bar = h("div", { class: `rail-bar tone-${meter.tone}`, role: "meter", "aria-label": meter.label, "aria-valuemin": meter.pct === null ? false : "0", "aria-valuemax": meter.pct === null ? false : "100", "aria-valuenow": meter.pct === null ? false : String(Math.round(meter.pct)), "aria-valuetext": `${meter.value}, ${toneWord(meter.tone)}` },
      meter.pct === null ? [] : [h("span", { class: "rail-fill", style: `width:${Math.min(100, Math.max(0, meter.pct))}%` }), h("span", { class: "rail-tick" })]);
    const head = h(expandable ? "button" : "div", { class: "rail-head", "data-key": expandable ? key : false, type: expandable ? "button" : false, "aria-expanded": expandable ? String(expanded) : false, onclick: expandable ? () => { open.set(key, !expanded); paint(); } : false },
      h("span", { class: "rail-name" }, h("span", { class: "rail-label" }, meter.label), h("span", { class: "rail-detail" }, meter.detail)),
      bar,
      h("span", { class: `rail-value tone-${meter.tone}` }, meter.value, meter.pct !== null && meter.tone !== "ok" ? h("span", { class: "rail-word" }, toneWord(meter.tone)) : []),
      spark(meter));
    const users = expanded ? h("div", { class: "rail-users" },
      h("h3", {}, meter.top === "mem" ? "Biggest users of memory" : "Biggest users of the processor"),
      h("ul", {}, topRows(machine, meter.top).map((user) => h("li", {}, h("span", { class: "user-name" }, user.name), h("span", { class: "user-kind" }, user.kind), h("span", { class: "user-value" }, user.value))))) : [];
    return h("li", { class: "rail-row" }, head, users);
  }

  function card(machine) {
    const stale = isStale(machine);
    return h("section", { class: `resource-card tone-${stale ? "quiet" : machineTone(machine)}`, "aria-label": machine.name },
      h("header", {}, h("h2", {}, machine.name), h("span", { class: "card-os" }, machine.os), h("span", { class: `card-age${stale ? " stale" : ""}` }, stale ? `Stale. ${ageText(machine.ageSeconds)}` : ageText(machine.ageSeconds))),
      h("p", { class: "card-summary" }, summaryText(machine)),
      h("ul", { class: "rail" }, meterRows(machine).map((meter) => row(machine, meter))));
  }

  function paint() {
    status.hidden = loaded && !error;
    status.textContent = error || "Reading the machines.";
    note.textContent = machines.length ? `Updated every ${intervalSeconds} s while this view is open.` : "";
    if (loaded && !machines.length && !error) { status.hidden = false; status.textContent = "No machine has a reading yet. The first one arrives within a minute of the hub starting."; }
    const focused = cards.contains(document.activeElement) ? document.activeElement.getAttribute("data-key") : null;
    cards.replaceChildren(...machines.map(card));
    if (focused) [...cards.querySelectorAll("[data-key]")].find((el) => el.getAttribute("data-key") === focused)?.focus({ preventScroll: true });
  }

  function paintAlertsActive() {
    const up = alertStatus?.active ?? [];
    const nameOf = (id) => machines.find((machine) => machine.machineId === id)?.name ?? id;
    alertsActive.replaceChildren(...(up.length ? up.map((alert) => h("li", { class: "alert-up" }, activeAlertText(alert, nameOf(alert.machineId), Date.now()))) : [h("li", { class: "alert-none" }, "No meter is over its threshold.")]));
    const summary = alertsBox.querySelector("summary");
    if (summary) summary.textContent = up.length ? `Alerts (${up.length} up)` : "Alerts";
  }

  function buildAlerts() {
    const fields = alertRows(alertStatus.settings).map((row) => {
      const enabled = h("input", { type: "checkbox", checked: row.enabled, "aria-label": `${row.label} alert on` });
      const pct = h("input", { type: "number", min: "50", max: "100", step: "1", value: String(row.pct), "aria-label": `${row.label} threshold in percent` });
      const minutes = h("input", { type: "number", min: "0", max: "1440", step: "1", value: String(row.minutes), "aria-label": `${row.label} minutes over the threshold` });
      return { row, enabled, pct, minutes };
    });
    const result = h("p", { class: "alerts-result", role: "status" });
    const save = h("button", { type: "button", class: "alerts-save", onclick: async () => {
      save.disabled = true;
      result.className = "alerts-result";
      result.textContent = "";
      try {
        const body = alertEdit(fields.map((f) => ({ key: f.row.key, enabled: f.enabled.checked, pct: f.pct.value, minutes: f.minutes.value })));
        const response = await fetch("/api/resources/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const reply = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(reply.error ?? `The hub answered ${response.status}.`);
        alertStatus = reply;
        result.textContent = "Saved.";
        paintAlertsActive();
      } catch (cause) { result.className = "alerts-result bad"; result.textContent = cause instanceof Error ? cause.message : "The hub could not be reached."; }
      finally { save.disabled = false; }
    } }, "Save alerts");
    const channels = alertStatus.channels ?? {};
    alertsBox.replaceChildren(h("summary", {}, "Alerts"),
      h("p", { class: "alerts-help" }, `Scout sends one notice when a meter stays at or over its threshold for the minutes shown, and one when it falls back. Notices go to ${channels.discord ? "Discord and the desktop" : "the desktop on the hub machine"}.`),
      alertsActive,
      h("div", { class: "alerts-grid" }, ...fields.map((f) => h("div", { class: "alerts-row" },
        h("label", { class: "alerts-name" }, f.enabled, h("span", {}, f.row.label), h("small", {}, f.row.hint)),
        h("label", {}, h("span", {}, "At or over"), f.pct, h("span", {}, "%")),
        h("label", {}, h("span", {}, "For"), f.minutes, h("span", {}, "min"))))),
      h("div", { class: "alerts-actions" }, save, result),
      alertStatus.settings?.fileError ? h("p", { class: "alerts-result bad" }, alertStatus.settings.fileError) : []);
    alertsBuilt = true;
    paintAlertsActive();
  }

  async function loadAlerts() {
    try {
      const response = await fetch("/api/resources/alerts");
      if (!response.ok) { alertsBox.hidden = true; return; }
      alertStatus = await response.json();
      alertsBox.hidden = false;
      if (alertsBuilt) paintAlertsActive(); else buildAlerts();
    } catch { /* the page keeps what it has */ }
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    try {
      const response = await fetch("/api/resources", { signal: mine.signal });
      if (!response.ok) throw new Error(response.status === 404 ? "This hub is too old to report resources. Update the hub." : `The hub answered ${response.status}.`);
      const body = await response.json();
      machines = body.machines ?? [];
      intervalSeconds = Number.isFinite(body.intervalSeconds) ? body.intervalSeconds : 10;
      error = "";
    } catch (cause) {
      if (cause?.name === "AbortError") return;
      error = cause instanceof Error && cause.message ? cause.message : "The hub could not be reached.";
    }
    loaded = true;
    paint();
    loadAlerts();
  }

  function schedule() {
    clearTimeout(timer);
    if (!visible) return;
    timer = setTimeout(async () => { if (!document.hidden) await load(); schedule(); }, pollMs(intervalSeconds));
  }

  document.addEventListener("visibilitychange", () => { if (visible && !document.hidden) { load().then(schedule); } });

  return {
    show() { visible = true; root.hidden = false; paint(); load().then(schedule); },
    hide() { visible = false; clearTimeout(timer); controller?.abort(); root.hidden = true; },
  };
}
