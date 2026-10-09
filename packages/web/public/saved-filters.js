import { h } from "./lib.js";
import { filterName, filterQuery, matchesFilter } from "./filters.js";

export function savedFilterControl(root, { view, query, apply }) {
  let filters = [];
  let sequence = 0;
  let currentView = null;
  let buttons = [];
  const active = h("span", { class: "muted", "aria-live": "polite" });
  const list = h("ul", { class: "saved-list" });
  const editor = h("div", { class: "saved-editor", hidden: true });
  const error = h("p", { role: "alert", class: "saved-error", hidden: true });
  const save = h("button", { type: "button", onclick: () => edit("save") }, "Save current filter");
  root.replaceChildren(h("summary", {}, "Saved filters ", active), list, save, editor, error);

  function fail(message) { error.textContent = message; error.hidden = false; }
  function clearError() { error.textContent = ""; error.hidden = true; }
  function cancel() { editor.hidden = true; editor.replaceChildren(); save.focus(); }
  function sync() {
    const names = filters.filter((filter) => matchesFilter(filter, view(), query())).map((filter) => filter.name);
    active.textContent = names.length ? `Active: ${names.join(", ")}` : "";
    for (const { filter, button } of buttons) {
      if (names.includes(filter.name)) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
    }
  }
  function render() {
    buttons = [];
    list.replaceChildren(...(filters.length ? filters.map((filter) => {
      const button = h("button", { type: "button", class: "saved-apply", "aria-label": `Apply filter ${filter.name}`, onclick: () => { cancel(); apply(filter.spec); } }, filter.name);
      buttons.push({ filter, button });
      return h("li", {}, button, h("button", { type: "button", "aria-label": `Rename filter ${filter.name}`, onclick: () => edit("rename", filter) }, "Rename"), h("button", { type: "button", "aria-label": `Delete filter ${filter.name}`, onclick: () => edit("delete", filter) }, "Delete"));
    }) : [h("li", { class: "muted" }, "No saved filters.")]));
    sync();
  }
  function edit(action, filter) {
    clearError();
    const capturedView = view();
    const params = filterQuery(capturedView, query());
    const input = action === "delete" ? null : h("input", { type: "text", value: filter?.name || "", maxlength: 60, autocomplete: "off", "aria-label": action === "rename" ? "New filter name" : "Filter name" });
    const submit = h("button", { type: "submit" }, action === "delete" ? "Delete filter" : action === "rename" ? "Rename" : "Save");
    const dismiss = h("button", { type: "button", onclick: cancel }, "Cancel");
    const form = h("form", { onsubmit: async (event) => {
      event.preventDefault(); clearError();
      let body;
      try {
        body = action === "delete" ? { name: filter.name, view: capturedView } : action === "rename" ? { from: filter.name, to: filterName(input.value), view: capturedView } : { name: filterName(input.value), view: capturedView, params };
      } catch (err) { fail(err.message); input?.focus(); return; }
      submit.disabled = true;
      try {
        const response = await fetch(`/api/filters${action === "save" ? "" : `/${action}`}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const data = await response.json();
        if (capturedView !== view()) return;
        if (!response.ok) throw new Error(data.error || "The filter could not be saved.");
        cancel(); await refresh();
      } catch (err) { if (capturedView === view()) fail(err.message === "Failed to fetch" ? "The hub could not be reached." : err.message); }
      finally { submit.disabled = false; }
    } }, input ? h("label", { class: "field" }, action === "rename" ? "New filter name" : "Filter name", input) : h("p", {}, `Delete filter "${filter.name}"?`), h("div", { class: "actions" }, submit, dismiss));
    editor.replaceChildren(form); editor.hidden = false;
    (input || dismiss).focus();
  }
  async function refresh() {
    const requestedView = view();
    const request = ++sequence;
    if (currentView !== requestedView) { filters = []; render(); editor.hidden = true; editor.replaceChildren(); }
    currentView = requestedView;
    clearError();
    if (!["catalog", "updates"].includes(requestedView)) return;
    try {
      const response = await fetch(`/api/filters?view=${requestedView}`);
      if (!response.ok) throw new Error("Saved filters could not load.");
      const data = await response.json();
      if (request !== sequence || requestedView !== view()) return;
      filters = data; render();
    } catch { if (request === sequence && requestedView === view()) fail("Saved filters could not load."); }
  }
  return { sync, refresh };
}
