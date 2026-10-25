import { h } from "./lib.js";
import { autoRunNote, machineGroups, quietWindowNote } from "./update-window-model.js";

/** The planning panel above the Updates table. Its buttons open the usual confirmation dialog, so nothing starts without it. */
export function createWindowPanel({ root, button, startPlan, fetchWindow = async () => { const response = await fetch("/api/updates/window"); if (!response.ok) throw new Error("The plan is unavailable"); return response.json(); }, setAuto = async (enabled) => { const response = await fetch("/api/updates/window/auto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); if (!response.ok) throw new Error("The switch could not be saved"); } }) {
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
      ? machines.map((machine) => h("section", { class: "window-machine" }, h("h3", {}, machine.machineId), machineGroups(machine, windows.quiet).map((entry) => group(machine, entry))))
      : [h("p", {}, "Nothing is waiting to be updated.")];
    const auto = windows.autoRun ? [h("label", { class: "window-auto" }, h("input", { type: "checkbox", checked: windows.autoRun.enabled, onchange: async (event) => { event.target.disabled = true; try { await setAuto(event.target.checked); } catch (error) { root.prepend(h("p", { role: "alert" }, error.message)); } refresh(); } }), "Run the plan automatically in the quiet window"), h("p", { class: "muted" }, autoRunNote(windows.autoRun, windows.quiet))] : [];
    root.replaceChildren(h("h2", {}, "Plan a window"), h("p", { class: "muted" }, quietWindowNote(windows.quiet)), ...auto, ...body);
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
