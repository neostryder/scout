import { h } from "./lib.js";
import { machineGroups, quietHourNote } from "./update-window-model.js";

/** The planning panel above the Updates table. Its buttons open the usual confirmation dialog, so nothing starts without it. */
export function createWindowPanel({ root, button, startPlan, fetchWindow = async () => { const response = await fetch("/api/updates/window"); if (!response.ok) throw new Error("The plan is unavailable"); return response.json(); } }) {
  let open = false;
  let sequence = 0;
  const group = (machine, entry) => h("div", { class: `window-group window-${entry.key}` },
    h("h4", {}, entry.heading),
    h("p", { class: "muted" }, entry.note),
    h("ul", {}, entry.items.map((line) => h("li", {}, line))),
    entry.button ? h("button", { type: "button", class: entry.key === "now" ? "primary" : "", onclick: () => startPlan(entry.ids, machine.machineId) }, entry.button) : []);
  const draw = (windows) => {
    const machines = windows.machines || [];
    const body = machines.length
      ? machines.map((machine) => h("section", { class: "window-machine" }, h("h3", {}, machine.machineId), h("p", { class: "muted" }, quietHourNote(machine.quietHour)), machineGroups(machine).map((entry) => group(machine, entry))))
      : [h("p", {}, "Nothing is waiting to be updated.")];
    root.replaceChildren(h("h2", {}, "Plan a window"), ...body);
  };
  async function refresh() {
    if (!open) return;
    const mine = ++sequence;
    try {
      const windows = await fetchWindow();
      if (mine === sequence && open) draw(windows);
    } catch (error) {
      if (mine === sequence && open) root.replaceChildren(h("p", { role: "alert" }, error.message));
    }
  }
  function setOpen(next) {
    open = next;
    root.hidden = !next;
    button.setAttribute("aria-expanded", String(next));
    if (next) { root.replaceChildren(h("p", { class: "muted", "aria-busy": "true" }, "Planning...")); refresh(); }
  }
  return { refresh, toggle: () => setOpen(!open), hide: () => setOpen(false) };
}
