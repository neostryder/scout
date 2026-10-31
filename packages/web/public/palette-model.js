// The command palette's lookups. It only ever finds a place to go: every result is a link to a page, a Services tab, or a filtered list, and nothing here starts, stops, or changes anything.
export const PAGES = [
  { label: "Updates", hint: "Page", href: "/", words: "updates outdated versions" },
  { label: "Catalog", hint: "Page", href: "/?view=catalog", words: "catalog installs packages software" },
  { label: "Services", hint: "Page", href: "/?view=services", words: "services daemons running" },
  { label: "Listening ports", hint: "Services tab", href: "/?view=services&tab=listeners", words: "listeners listening ports sockets" },
  { label: "Activity", hint: "Services tab", href: "/?view=services&tab=activity", words: "activity log actions history" },
  { label: "Recipes", hint: "Services tab", href: "/?view=services&tab=recipes", words: "recipes projects start commands" },
  { label: "Domains", hint: "Services tab", href: "/?view=services&tab=domains", words: "domains routes hostnames tunnel" },
  { label: "Alerts", hint: "Services tab", href: "/?view=services&tab=alerts", words: "alerts notifications warnings" },
  { label: "Health", hint: "Services tab", href: "/?view=services&tab=health", words: "health checks latency certificates" },
  { label: "Outages", hint: "Services tab", href: "/?view=services&tab=outages", words: "outages downtime incidents" },
  { label: "Port map", hint: "Services tab", href: "/?view=services&tab=ports", words: "ports map ranges clashes" },
  { label: "Stacks", hint: "Services tab", href: "/?view=services&tab=stacks", words: "stacks groups compose" },
  { label: "Resources", hint: "Page", href: "/?view=resources", words: "resources cpu memory disk meters usage" },
  { label: "Claude", hint: "Page", href: "/?view=claude", words: "claude sessions code waiting running idle memory" },
  { label: "Competitors", hint: "Page", href: "/?view=competitors", words: "competitors watch versions research" },
  { label: "Review queue", hint: "Page", href: "/?view=review", words: "review proposals merges decisions" },
  { label: "Jobs", hint: "Page", href: "/?view=jobs", words: "jobs running updates downloads" },
  { label: "Settings", hint: "Page", href: "/?view=settings", words: "settings tray rules preferences" },
];

/** "port 4870", ":4870", and a bare number all mean a port; anything else is a name to look for. */
export function parseQuery(raw) {
  const text = String(raw ?? "").trim();
  const match = /^(?:port\s*|:)?(\d{1,5})$/i.exec(text);
  const port = match ? Number(match[1]) : NaN;
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return { kind: "port", port, text };
  return { kind: "text", port: null, text: text.replace(/^(?:go to|open|find|show)\s+/i, "") };
}

function score(text, label, words = "") {
  const wanted = text.toLowerCase();
  if (wanted === "") return 0;
  const name = label.toLowerCase();
  if (name === wanted) return 4;
  if (name.startsWith(wanted)) return 3;
  if (name.split(/[\s/._-]+/).some((word) => word.startsWith(wanted))) return 2.5;
  if (name.includes(wanted)) return 2;
  if (words.split(" ").some((word) => word.startsWith(wanted))) return 1.5;
  return 0;
}

export function pageResults(text) {
  if (text === "") return PAGES.slice(0, 8);
  return PAGES.map((page) => ({ page, rank: score(text, page.label, page.words) })).filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank).map(({ page }) => page);
}

export function machineResults(machines, text) {
  return (machines ?? []).map((machine) => ({ machine, rank: score(text, machine.name || machine.id, machine.id) })).filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank)
    .map(({ machine }) => ({ label: machine.name || machine.id, hint: "Machine", href: `/?view=services&machine=${encodeURIComponent(machine.id)}` }));
}

export function listenerResult(row) {
  const who = row.serviceName || row.containerName || row.label || row.processName || "Unknown process";
  return { label: `Port ${row.port}: ${who}`, hint: `Listener on ${row.machineId}`, href: `/?view=services&tab=listeners&port=${row.port}&machine=${encodeURIComponent(row.machineId)}&all=1` };
}

export function serviceResult(row) {
  return { label: row.name, hint: `${row.kind || "Service"} on ${row.machineId}`, href: `/?view=services&q=${encodeURIComponent(row.name)}&machine=${encodeURIComponent(row.machineId)}&all=1` };
}

/** The address of each lookup the palette asks the hub for: a port number searches listeners, a name searches services and listeners. */
export function lookups(query) {
  if (query.kind === "port") return [{ kind: "listeners", path: `/api/listeners?port=${query.port}&all=1&limit=6` }];
  if (query.text.length < 2) return [];
  const q = encodeURIComponent(query.text);
  return [{ kind: "services", path: `/api/services?q=${q}&all=1&limit=6` }, { kind: "listeners", path: `/api/listeners?q=${q}&all=1&limit=4` }];
}
