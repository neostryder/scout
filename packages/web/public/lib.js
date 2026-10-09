export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "checked") el.checked = value;
    else if (key === "disabled") el.disabled = value;
    else if (key === "selected") el.selected = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) el.append(child instanceof Node ? child : document.createTextNode(String(child ?? "")));
  return el;
}

export function marked(value, query) {
  const text = String(value ?? "");
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  const root = document.createDocumentFragment();
  if (!terms.length) { root.append(document.createTextNode(text)); return root; }
  let start = 0;
  while (start < text.length) {
    const matches = terms.map((term) => ({ index: text.toLowerCase().indexOf(term.toLowerCase(), start), term })).filter((m) => m.index >= 0).sort((a, b) => a.index - b.index);
    if (!matches.length) { root.append(document.createTextNode(text.slice(start))); break; }
    const match = matches[0];
    root.append(document.createTextNode(text.slice(start, match.index)));
    root.append(h("mark", {}, text.slice(match.index, match.index + match.term.length)));
    start = match.index + match.term.length;
  }
  return root;
}

export function safeUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export function defaultDir(sort) { return ["lastUsed", "checked", "firstSeen", "lastSeen", "useCount", "bump", "priority"].includes(sort) ? "desc" : "asc"; }

export function riskBadge(risk) {
  if (risk?.hard > 0) return { text: `Breaks ${risk.hard}`, title: `Updating would break ${risk.hard} install${risk.hard === 1 ? "" : "s"} that depend${risk.hard === 1 ? "s" : ""} on this`, className: "risk hard" };
  if (risk?.soft > 0) return { text: `Check ${risk.soft}`, title: `${risk.soft} install${risk.soft === 1 ? " or project" : "s or projects"} may be affected`, className: "risk soft" };
  return null;
}

export function updateDialogModel(plans) {
  const confirmations = plans.map((plan) => plan.softConfirmation).filter(Boolean);
  return {
    requiresSoftConfirmation: confirmations.length > 0,
    projects: [...new Set(confirmations.flatMap((confirmation) => confirmation.projects || []))],
    dependents: [...new Set(confirmations.flatMap((confirmation) => confirmation.dependents || []))],
  };
}

export function updatePlanQuery(id, selected) {
  const machine = selected.find((install) => install.installId === id)?.machineId;
  const others = machine ? selected.filter((install) => install.installId !== id && install.machineId === machine).map((install) => install.installId) : [];
  const query = new URLSearchParams({ installId: String(id) });
  if (others.length) query.set("alsoInstallIds", others.join(","));
  return query;
}
