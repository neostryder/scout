import { h } from "./lib.js";
import { autoRunNote, machineGroups, quietWindowNote } from "./update-window-model.js";

/** The planning panel above the Updates table. Its buttons open the usual confirmation dialog, so nothing starts without it. */
export function createWindowPanel({ root, button, startPlan, fetchWindow = async () => { const response = await fetch("/api/updates/window"); if (!response.ok) throw new Error("The plan is unavailable"); return response.json(); }, setAuto = async (patch) => { const response = await fetch("/api/updates/window/auto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }); if (!response.ok) throw new Error("The switch could not be saved"); } }) {
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
    const auto = windows.autoRun ? [h("label", { class: "window-auto" }, h("input", { type: "checkbox", checked: windows.autoRun.enabled, onchange: async (event) => { event.target.disabled = true; try { await setAuto({ enabled: event.target.checked }); } catch (error) { root.prepend(h("p", { role: "alert" }, error.message)); } refresh(); } }), "Run the plan automatically in the quiet window"), h("p", { class: "muted" }, autoRunNote(windows.autoRun, windows.quiet)), h("label", { class: "window-cap" }, "Updates per machine each night", h("input", { type: "number", min: 1, max: 100, step: 1, value: windows.autoRun.cap ?? 15, "aria-label": "Updates per machine each night", onchange: async (event) => { const cap = Number(event.target.value); event.target.disabled = true; try { await setAuto({ cap }); } catch (error) { root.prepend(h("p", { role: "alert" }, error.message)); } refresh(); } }))] : [];
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
