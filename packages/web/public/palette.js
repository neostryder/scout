// The command palette: Ctrl+K or Cmd+K, or the magnifier in the header. It looks things up and jumps to them, such as "port 4870", a machine, a service, or a page, and it never starts, stops, or changes anything.
import { lookups, listenerResult, machineResults, pageResults, parseQuery, serviceResult } from "./palette-model.js";

const SVG = "http://www.w3.org/2000/svg";
const DELAY_MS = 150;

function magnifier() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const part = document.createElementNS(SVG, "path");
  part.setAttribute("d", "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.5-4.5");
  svg.append(part);
  return svg;
}

// A choice moves inside the page: the address changes and the portal's own popstate handler draws the new view.
function go(href) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function mount() {
  const header = document.querySelector("header.top");
  if (!header || document.querySelector(".palette")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "palette";
  dialog.setAttribute("aria-label", "Search Scout");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Find a port, machine, service, or page";
  input.setAttribute("aria-label", "Search Scout");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "palette-results");
  input.setAttribute("aria-expanded", "true");
  input.autocomplete = "off";
  const list = document.createElement("ul");
  list.id = "palette-results";
  list.setAttribute("role", "listbox");
  const note = document.createElement("p");
  note.className = "palette-note";
  note.setAttribute("role", "status");
  dialog.append(input, list, note);
  document.body.append(dialog);

  let items = [];
  let active = 0;
  let machines = null;
  let timer = 0;
  let controller = null;

  const paint = () => {
    list.replaceChildren(...items.map((item, index) => {
      const row = document.createElement("li");
      row.id = `palette-item-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === active));
      const label = document.createElement("span");
      label.className = "palette-label";
      label.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "palette-hint";
      hint.textContent = item.hint;
      row.append(label, hint);
      row.addEventListener("click", () => choose(item));
      row.addEventListener("pointermove", () => { if (active !== index) { active = index; select(); } });
      return row;
    }));
    input.setAttribute("aria-activedescendant", items.length ? `palette-item-${active}` : "");
  };
  const select = () => {
    for (const [index, row] of [...list.children].entries()) row.setAttribute("aria-selected", String(index === active));
    input.setAttribute("aria-activedescendant", `palette-item-${active}`);
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  const close = () => { if (dialog.open) dialog.close(); };
  const choose = (item) => { close(); go(item.href); };

  async function readJson(path, signal) {
    const response = await fetch(path, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  async function search() {
    controller?.abort();
    const mine = (controller = new AbortController());
    const query = parseQuery(input.value);
    const found = [];
    if (query.kind === "text") {
      found.push(...pageResults(query.text).map(({ label, hint, href }) => ({ label, hint, href })));
    }
    items = found;
    active = 0;
    note.textContent = "";
    paint();
    const asks = lookups(query);
    if (query.kind === "text" && query.text.length >= 2 && machines === null) asks.push({ kind: "machines", path: "/api/services/overview" });
    if (asks.length === 0) return;
    const results = await Promise.allSettled(asks.map((ask) => readJson(ask.path, mine.signal)));
    if (mine.signal.aborted) return;
    const fromHub = [];
    let failed = 0;
    results.forEach((result, index) => {
      const ask = asks[index];
      if (result.status !== "fulfilled") { failed += 1; return; }
      if (ask.kind === "machines") machines = Array.isArray(result.value.machines) ? result.value.machines : [];
      if (ask.kind === "listeners") fromHub.push(...(result.value.rows ?? []).map(listenerResult));
      if (ask.kind === "services") fromHub.push(...(result.value.rows ?? []).map(serviceResult));
    });
    const machineHits = query.kind === "text" ? machineResults(machines, query.text) : [];
    items = [...machineHits, ...(query.kind === "port" ? [] : found), ...fromHub].filter((item, index, all) => all.findIndex((other) => other.href === item.href) === index);
    active = 0;
    paint();
    if (items.length === 0) note.textContent = failed === asks.length ? "Scout could not look that up right now." : "Nothing found.";
  }

  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, DELAY_MS); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      select();
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      choose(items[active]);
    }
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => { controller?.abort(); clearTimeout(timer); });

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    input.value = "";
    search();
    input.focus();
  };
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") { event.preventDefault(); if (dialog.open) close(); else open(); }
  });

  const button = document.createElement("button");
  button.type = "button";
  button.className = "palette-toggle theme-toggle";
  button.style.marginLeft = "0";
  button.title = "Search (Ctrl+K)";
  button.setAttribute("aria-label", "Search Scout");
  button.append(magnifier());
  button.addEventListener("click", open);
  const density = header.querySelector(".density-toggle") || header.querySelector(".theme-toggle");
  if (density) density.after(button);
  else header.append(button);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
