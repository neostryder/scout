import { hubMachineId } from "./hub.ts";
export type ProtectedGroup = "essential" | "scout" | "cloudflared" | "ssh" | "cogitator" | "remote-access" | "dns-network" | "containers" | "custom";
export interface Protection { protected: boolean; group: ProtectedGroup | null; reason: string | null }
export interface ProtectedEntry { machine: string; match: string; reason: string }
export interface ProtectedConfig { disable: string[]; names: ProtectedEntry[] }
export interface ProtectedContext {
  config?: ProtectedConfig;
  machineId?: string;
  pid?: number;
  parentPid?: number;
  port?: number;
  windows?: boolean;
}
export interface ProtectedRow {
  machineId: string;
  kind?: string | null;
  name?: string;
  displayName?: string | null;
  program?: string | null;
  processName?: string | null;
  processPath?: string | null;
  pid?: number | null;
  port?: number;
  ports?: { port: number }[];
  classification?: { class: string };
}

export const PROTECTED_GROUPS = [
  { id: "essential", label: "Essential", alwaysOn: true, reason: "Stopping this could disable operating-system functions." },
  { id: "scout", label: "Scout", alwaysOn: true, reason: "Stopping this would stop the Scout hub or its supervisor." },
  { id: "cloudflared", label: "Cloudflared", alwaysOn: true, reason: "Stopping this would disconnect the tunnel." },
  { id: "ssh", label: "SSH", alwaysOn: true, reason: "Stopping this would disconnect SSH access." },
  { id: "cogitator", label: "Cogitator", alwaysOn: true, reason: "Stopping this would stop Cogitator." },
  { id: "remote-access", label: "Remote access", alwaysOn: false, reason: "Stopping these could lock you out of a machine you reach remotely." },
  { id: "dns-network", label: "DNS and network", alwaysOn: false, reason: "Stopping these could disconnect DNS or network access." },
  { id: "containers", label: "Containers", alwaysOn: false, reason: "Stopping these would interrupt containers and their workloads." },
] as const;

function glob(pattern: string, value: string, windows: boolean): boolean {
  if (windows) { pattern = pattern.toLowerCase(); value = value.toLowerCase(); }
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (pattern[p] === "?" || pattern[p] === value[v]) { p++; v++; }
    else if (pattern[p] === "*") { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function isProtected(row: ProtectedRow, context: ProtectedContext = {}): Protection {
  const windows = context.windows ?? (row.kind === "windows-service" || row.kind === "scheduled-task" || /^[a-z]:[/\\]/i.test(row.program ?? row.processPath ?? ""));
  const values = [row.name, row.displayName, row.program, row.processName, row.processPath].filter((v): v is string => typeof v === "string").map((v) => v.replace(/\\/g, "/"));
  const text = values.join(" ");
  let group: ProtectedGroup | null = null;
  if (row.classification?.class === "essential") group = "essential";
  else if (row.machineId === (context.machineId ?? hubMachineId()) && ((row.pid != null && (row.pid === context.pid || row.pid === context.parentPid)) || (context.port !== undefined && (row.port === context.port || row.ports?.some((p) => p.port === context.port))))) group = "scout";
  else if (/(?:^|[/ ._-])scout(?:[-_. ]?(?:hub|supervisor))?(?:[/. _-]|$)/i.test(text)) group = "scout";
  else if (/cloudflared/i.test(text)) group = "cloudflared";
  else if (values.some((v) => /(?:^|[/ ._-])sshd(?:\.exe)?$/i.test(v))) group = "ssh";
  else if (/cogitator/i.test(text)) group = "cogitator";
  else if (/ARDAgent|screensharing|RemoteManagement|TermService|Remote Desktop|tailscale/i.test(text)) group = "remote-access";
  else if (/warp-svc|Cloudflare WARP|nordvpn|adguard/i.test(text)) group = "dns-network";
  else if (/(?:^|[/ ._-])(?:colima|limactl|docker)(?:[/. _-]|$)|Docker Desktop/i.test(text)) group = "containers";
  if (group) {
    const rule = PROTECTED_GROUPS.find((item) => item.id === group)!;
    if (rule.alwaysOn || !context.config?.disable.includes(group)) return { protected: true, group, reason: rule.reason };
  }
  for (const entry of context.config?.names ?? []) {
    if (glob(entry.machine, row.machineId, windows) && values.some((v) => glob(entry.match.replace(/\\/g, "/"), v, windows))) return { protected: true, group: "custom", reason: entry.reason };
  }
  return { protected: false, group: null, reason: null };
}
