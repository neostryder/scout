// Pure helpers for the Outages tab, kept apart from the page so tests can load them without a browser.

export const OUTAGE_STATE_LABELS = { hung: "Hung", down: "Down", unhealthy: "Not answering", "not-running": "Not running", flapping: "Flapping", "monitor-gap": "Scout not running" };

export function outageStateLabel(outage) {
  return OUTAGE_STATE_LABELS[outage.state] || outage.state;
}

export function outageDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function outageKindLabel(kind) {
  return { machine: "Machine", url: "Web address", service: "Service", flapping: "Flapping", "monitor-gap": "Monitor gap" }[kind] || kind;
}

/** The open outages first, newest start first, then the closed ones. The hub already sorts by start, so this only groups. */
export function groupOutages(outages) {
  return { open: outages.filter((row) => row.endedAt === null), past: outages.filter((row) => row.endedAt !== null) };
}

export function itemGroups(items) {
  const groups = { machine: [], url: [], service: [] };
  for (const item of items) (groups[item.kind] || (groups[item.kind] = [])).push(item);
  return groups;
}

export function channelText(channels) {
  if (!channels) return "Notices are not set up.";
  return channels.discord ? "Notices go to Discord and to a desktop notification on the hub machine." : "Notices go to a desktop notification on the hub machine. Set SCOUT_DISCORD_WEBHOOK on the hub machine to add Discord.";
}

export function pauseText(config, now = Date.now()) {
  if (!config.pausedUntil || Date.parse(config.pausedUntil) <= now) return "";
  return `Paused until ${new Date(config.pausedUntil).toLocaleString()}.`;
}

/** The count shown on the tab: open outages that are not monitor gaps. */
export function openCount(response) {
  return response?.open || 0;
}
