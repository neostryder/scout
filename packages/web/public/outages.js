import { h } from "./lib.js";
import { outageStateLabel, outageDuration, outageKindLabel, groupOutages, itemGroups, channelText, pauseText } from "./outages-model.js";

const date = (value) => value ? new Date(value).toLocaleString() : "";

/** The Outages tab: open and past outages, what is watched with a switch for each item, a pause and a test notice. */
export function createOutagesPanel({ onCount }) {
  const panel = h("section", { id: "services-outages-panel", role: "tabpanel", class: "outages-panel", hidden: true, "aria-labelledby": "services-tab-outages" });
  const model = { data: null, error: "", busy: false, testResult: "", switchesOpen: false };
  let supported = true;

  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 404 && body === undefined) { supported = false; throw new Error("The outage watch is not available on this hub."); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
    return result;
  }

  function setData(data) {
    model.data = data; model.error = "";
    onCount?.(data.open || 0);
    render();
  }

  function setError(message) {
    model.error = message;
    render();
  }

  async function refresh() {
    try {
      model.data = await request("/api/services/outages?limit=200");
      model.error = "";
      onCount?.(model.data.open || 0);
    } catch (error) { model.error = error.message; }
    render();
  }

  async function setWatch(body) {
    model.busy = true; render();
    try { await request("/api/services/outages/watch", body); model.error = ""; } catch (error) { model.error = error.message; }
    model.busy = false;
    await refresh();
  }

  async function testNotice() {
    model.busy = true; model.testResult = "Sending a test notice."; render();
    try {
      const { results } = await request("/api/services/outages/test", {});
      model.testResult = results.map((row) => `${row.channel === "discord" ? "Discord" : "Desktop"}: ${row.ok ? "sent" : `failed (${row.error})`}`).join(". ") + ".";
    } catch (error) { model.testResult = error.message; }
    model.busy = false; render();
  }

  function outageTable(rows, caption, open) {
    if (!rows.length) return h("p", { class: "empty" }, open ? "Nothing is down." : "No past outages are recorded yet.");
    return h("div", { class: "data-wrap" }, h("table", { class: "outage-table" }, h("caption", { class: "sr-only" }, caption),
      h("thead", {}, h("tr", {}, ...["What", "Kind", "State", "Started", open ? "Down for" : "Ended", open ? "Detail" : "Lasted"].map((name) => h("th", { scope: "col" }, name)))),
      h("tbody", {}, ...rows.map((row) => h("tr", {},
        h("th", { scope: "row" }, row.label),
        h("td", {}, outageKindLabel(row.kind)),
        h("td", {}, h("span", { class: `health-state ${open ? "danger" : "quiet"}` }, outageStateLabel(row))),
        h("td", {}, date(row.startedAt)),
        h("td", {}, open ? outageDuration(row.durationMs) : date(row.endedAt)),
        h("td", {}, open ? row.detail : outageDuration(row.durationMs)))))));
  }

  function switchList(title, items, kindKey) {
    if (!items.length) return [];
    return [h("h4", {}, title), h("ul", { class: "watch-list" }, ...items.map((item) => h("li", {},
      h("label", {}, h("input", { type: "checkbox", checked: item.watched, disabled: model.busy, onchange: (event) => setWatch(kindKey === "machine" && item.machineId ? { machine: item.machineId, watched: event.target.checked } : { item: item.key, watched: event.target.checked }) }), " ", item.label),
      item.failures > 0 ? h("span", { class: "health-state warn" }, ` failing (${item.failures})`) : [])))];
  }

  function render() {
    if (!model.data) { panel.replaceChildren(h("p", { class: "table-status", role: "status" }, model.error || "Reading outages.")); return; }
    const { open, past } = groupOutages(model.data.outages);
    const config = model.data.config;
    const groups = itemGroups(model.data.items);
    const paused = pauseText(config);
    const minutes = (count) => new Date(Date.now() + count * 60_000).toISOString();
    panel.replaceChildren(
      model.error ? h("p", { class: "error", role: "alert" }, model.error) : [],
      config.fileError ? h("p", { class: "error", role: "alert" }, config.fileError) : [],
      h("div", { class: "outage-controls" },
        h("p", {}, channelText(model.data.watch?.channels), model.data.watch?.lastCycleAt ? ` Last check ${date(model.data.watch.lastCycleAt)}.` : ""),
        paused ? h("p", { class: "health-state warn" }, paused) : [],
        h("div", { class: "outage-buttons" },
          h("button", { type: "button", disabled: model.busy, onclick: testNotice }, "Send a test notice"),
          paused
            ? h("button", { type: "button", disabled: model.busy, onclick: () => setWatch({ pausedUntil: null }) }, "Resume checks")
            : [h("button", { type: "button", disabled: model.busy, onclick: () => setWatch({ pausedUntil: minutes(60) }) }, "Pause for 1 hour"), h("button", { type: "button", disabled: model.busy, onclick: () => setWatch({ pausedUntil: minutes(480) }) }, "Pause for 8 hours")]),
        model.testResult ? h("p", { role: "status" }, model.testResult) : []),
      h("h3", {}, `Open outages (${open.length})`),
      outageTable(open, "Open outages", true),
      h("h3", {}, "Past outages"),
      outageTable(past, "Past outages", false),
      h("details", { class: "watch-switches", open: model.switchesOpen, ontoggle: (event) => { model.switchesOpen = event.currentTarget.open; } }, h("summary", {}, "What is watched"),
        h("p", {}, "Everything is watched by default. Switch off a kind of check, a machine or one item here; the choice is saved in .scout-data/watch.json on the hub machine."),
        h("fieldset", {}, h("legend", {}, "Kinds of check"), ...[["machine", "Machines (ssh port and greeting)"], ["url", "Public web addresses"], ["service", "Services and listening ports"]].map(([key, text]) =>
          h("label", {}, h("input", { type: "checkbox", checked: config.checks[key], disabled: model.busy, onchange: (event) => setWatch({ check: key, watched: event.target.checked }) }), " ", text, " "))),
        ...switchList("Machines", groups.machine, "machine"), ...switchList("Web addresses", groups.url, "url"), ...switchList("Services and ports", groups.service, "service")));
  }

  render();
  return { panel, refresh, setData, setError, supported: () => supported };
}
