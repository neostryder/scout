import { h } from "./lib.js";
import { ageText, isStale, machineTone, meterRows, pollMs, sparkSegments, summaryText, toneWord, topRows } from "./resources-model.js";

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
  root.classList.add("resources");
  root.replaceChildren(h("header", { class: "resources-head" }, h("h1", {}, "Resources"), note), status, cards);

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
