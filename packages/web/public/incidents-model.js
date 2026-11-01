// Pure helpers keep incident data testable without a browser.

export const FAILURE_CLASSES = ["dead", "wedged", "never-ran", "ran-failed", "degraded-output", "slow-or-timeout", "resources", "credentials-quota", "network-path", "ai-agent", "watcher-failure", "alert-quality"];
export const INCIDENT_PARAMS = { state: "incidentState", host: "incidentHost", failureClass: "incidentClass", q: "incidentQ" };

export function incidentFilters(params) {
  const state = params.get(INCIDENT_PARAMS.state);
  return { state: ["all", "resolved"].includes(state) ? state : "active", host: params.get(INCIDENT_PARAMS.host) || "", failureClass: params.get(INCIDENT_PARAMS.failureClass) || "", q: params.get(INCIDENT_PARAMS.q) || "" };
}

export function isSnoozed(row, now = Date.now()) {
  return Date.parse(row.snoozedUntil) > now;
}

export function incidentCounts(rows, now = Date.now()) {
  const counts = { open: 0, acknowledged: 0, resolved: 0, critical: 0, attention: 0, hosts: {} };
  for (const row of rows) {
    if (!Object.hasOwn(counts.hosts, row.host)) Object.defineProperty(counts.hosts, row.host, { value: 0, writable: true, enumerable: true });
    if (row.state === "open") {
      counts.open += 1;
      counts.hosts[row.host] += 1;
      if (row.severity === "critical") counts.critical += 1;
      if (!row.acknowledgedAt && !row.muted && !isSnoozed(row, now)) counts.attention += 1;
    } else if (row.state === "acknowledged") counts.acknowledged += 1;
    else if (row.state === "resolved") counts.resolved += 1;
  }
  return counts;
}

export function filterIncidents(rows, filters) {
  const terms = (filters.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => (filters.state === "all" || (filters.state === "resolved" ? row.state === "resolved" : ["open", "acknowledged"].includes(row.state)))
    && (!filters.host || row.host === filters.host)
    && (!filters.failureClass || row.failureClass === filters.failureClass)
    && terms.every((term) => `${row.component} ${row.summary}`.toLowerCase().includes(term)));
}

export function sortIncidents(rows) {
  const critical = (row) => row.state === "open" && row.severity === "critical" ? 1 : 0;
  return [...rows].sort((a, b) => critical(b) - critical(a) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || b.id - a.id);
}

export function relativeTime(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "Unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function packetSections(packet, cap = 8000) {
  const evidence = packet?.evidence;
  if (!evidence || typeof evidence !== "object") return [];
  const preferred = ["journalTail", "stderrTail", "recentChanges"];
  const labels = { journalTail: "Journal tail", stderrTail: "Stderr tail", recentChanges: "Recent changes", exitCode: "Exit code", snapshot: "Snapshot" };
  const order = (key) => preferred.includes(key) ? preferred.indexOf(key) : preferred.length;
  return Object.keys(evidence).sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((key) => {
    const value = evidence[key];
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n") : JSON.stringify(value, null, 2) ?? "";
    return { key, label: labels[key] || key, text: text.length > cap ? `${text.slice(0, Math.max(0, cap - 3))}...` : text };
  });
}

export function snoozeMinutes(hours) {
  return ["1", "4", "24"].includes(String(hours)) ? Number(hours) * 60 : null;
}
