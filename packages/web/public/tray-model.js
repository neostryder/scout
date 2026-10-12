// The tray rules document: the pure edits the Settings view makes before it saves.

export const KINDS = ["windows-service", "launchd", "systemd", "scheduled-task", "listener", "container", "recipe", "stack"];
export const CLASSES = ["essential", "optional", "third-party"];
export const VENDORS = ["apple", "microsoft", "other"];

export const emptyRules = () => ({ hide: { kinds: [], classes: [], machines: [], vendors: [], names: [] }, pins: [] });

/** Fills every list so the view can read a partial document. */
export function normalizeRules(value) {
  const base = emptyRules();
  const hide = value && typeof value === "object" && value.hide && typeof value.hide === "object" ? value.hide : {};
  for (const key of ["kinds", "classes", "machines", "vendors"]) if (Array.isArray(hide[key])) base.hide[key] = hide[key].filter((item) => typeof item === "string");
  if (Array.isArray(hide.names)) base.hide.names = hide.names.filter((rule) => rule && typeof rule.match === "string").map((rule) => rule.machine ? { machine: String(rule.machine), match: rule.match } : { match: rule.match });
  if (Array.isArray(value?.pins)) base.pins = value.pins.filter((pin) => pin && typeof pin.machine === "string" && typeof pin.key === "string").map((pin) => ({ machine: pin.machine, key: pin.key }));
  return base;
}

export function toggleHide(rules, field, value, on) {
  const next = structuredClone(rules);
  const list = next.hide[field].filter((item) => item !== value);
  next.hide[field] = on ? [...list, value] : list;
  return next;
}

export function addNameRule(rules, machine, match) {
  const text = String(match ?? "").trim();
  if (!text) return rules;
  const rule = machine ? { machine, match: text } : { match: text };
  if (rules.hide.names.some((item) => item.match === rule.match && item.machine === rule.machine)) return rules;
  const next = structuredClone(rules);
  next.hide.names.push(rule);
  return next;
}

export function removeNameRule(rules, index) {
  const next = structuredClone(rules);
  next.hide.names.splice(index, 1);
  return next;
}

export function removePin(rules, index) {
  const next = structuredClone(rules);
  next.pins.splice(index, 1);
  return next;
}

/** Reads an imported file. Throws a short reason when it is not a rules document. */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("the file is not valid JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("the file must hold one JSON object.");
  const rules = normalizeRules(data.rules ?? data);
  const unknown = [...rules.hide.kinds.filter((k) => !KINDS.includes(k)), ...rules.hide.classes.filter((c) => !CLASSES.includes(c)), ...rules.hide.vendors.filter((v) => !VENDORS.includes(v))];
  if (unknown.length) throw new Error(`"${unknown[0]}" is not a known value.`);
  return rules;
}

export const exportText = (rules) => `${JSON.stringify(rules, null, 2)}\n`;
export const sameRules = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A pin's key ends in the row's own name; that tail, with the machine's name, is what the list shows. */
export function pinLabel(pin, machines) {
  const machine = machines.find((item) => item.id === pin.machine)?.name || pin.machine;
  const tail = pin.key.split(":").slice(-1)[0] || pin.key;
  return `${machine}: ${tail}`;
}
