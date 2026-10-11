import { listListeners, type Listener } from "./listeners.ts";
import { listServices } from "./services.ts";
import { loadDescriptionResolver } from "./descriptions.ts";
import type { Db } from "./db.ts";
import type { TrayMachine, TrayRow, TrayState } from "./tray.ts";

export interface WhoIsMatch {
  machineId: string;
  machineName: string;
  /** What answered: a listening port or a service. */
  kind: "listener" | "service";
  name: string;
  state: string;
  port: number | null;
  /** Where the port accepts connections from, for a listener. */
  bind: string | null;
  /** The program or container behind it. */
  program: string | null;
  /** The service that owns a listener, when one does. */
  detail: string;
  id: number;
}

const flatten = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

/** Finds what is on a port (a number) or what matches a name (text) across every machine's present listeners and services. */
export function whoIs(db: Db, query: string): WhoIsMatch[] {
  const text = query.trim();
  if (text === "") throw new Error("whois requires a port number or a name");
  const port = /^\d{1,5}$/.test(text) ? Number(text) : null;
  if (port !== null && (port < 1 || port > 65535)) throw new Error("a port is a number from 1 to 65535");
  const needle = text.toLowerCase();
  const descriptions = loadDescriptionResolver(db, { hints: [] });
  const matches: WhoIsMatch[] = [];
  const listenerName = (l: Listener): string => l.processName ?? l.containerName ?? `port ${l.port}`;
  for (const l of listListeners(db, { state: "present", includeHidden: true }, descriptions)) {
    const hit = port !== null ? l.port === port : [listenerName(l), l.containerImage, l.processPath].some((part) => (part ?? "").toLowerCase().includes(needle));
    if (!hit) continue;
    matches.push({ machineId: l.machineId, machineName: l.machineName, kind: "listener", name: listenerName(l), state: "listening", port: l.port, bind: l.bind, program: l.containerImage ?? l.processPath, detail: l.description?.text ?? "", id: l.id });
  }
  for (const s of listServices(db, { gone: "present", includeHidden: true }, descriptions)) {
    const ports = s.ports.map((p) => p.port);
    const hit = port !== null ? ports.includes(port) : [s.name, s.displayName].some((part) => (part ?? "").toLowerCase().includes(needle));
    if (!hit) continue;
    matches.push({ machineId: s.machineId, machineName: s.machineName, kind: "service", name: s.displayName ?? s.name, state: s.state, port: ports[0] ?? null, bind: null, program: s.program, detail: s.description?.text ?? "", id: s.id });
  }
  return matches.sort((a, b) => a.machineName.localeCompare(b.machineName) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

const RANK: Record<TrayState, number> = { down: 0, changed: 1, up: 2, stopped: 3, unknown: 4 };

export interface StatusProblem { machineId: string; label: string; kind: string; state: TrayState; port: number | null; detail: string; key: string; target: string; id: number | null }
export interface StatusOutage { id: number; machineId: string | null; label: string; state: string; detail: string; startedAt: string }
export interface StatusSummary {
  state: TrayState;
  openOutages: number;
  /** The open outages behind that count, including rows the tray hides or no longer lists. */
  outages: StatusOutage[];
  generatedAt: string;
  machines: { id: string; name: string; reachable: boolean; worst: TrayState; counts: Record<TrayState, number>; hidden: number }[];
  /** Rows that are down or changed, worst first. */
  problems: StatusProblem[];
}

/** The tray read model boiled down to what an agent or a terminal needs first: how bad it is, and which rows are the reason. */
export function statusSummary(tray: { machines: TrayMachine[]; state: TrayState; openOutages: number; generatedAt: string }, outages: StatusOutage[] = []): StatusSummary {
  const problems: StatusProblem[] = [];
  for (const machine of tray.machines) {
    for (const row of machine.rows) {
      if (row.state === "down" || row.state === "changed") problems.push({ machineId: machine.id, label: row.label, kind: row.kind, state: row.state, port: row.port, detail: row.detail, key: row.key, target: row.target, id: row.id });
    }
  }
  problems.sort((a, b) => RANK[a.state] - RANK[b.state] || a.machineId.localeCompare(b.machineId) || a.label.localeCompare(b.label));
  return {
    state: tray.state,
    openOutages: tray.openOutages,
    outages: outages.map(({ id, machineId, label, state, detail, startedAt }) => ({ id, machineId, label, state, detail, startedAt })),
    generatedAt: tray.generatedAt,
    machines: tray.machines.map((m) => ({ id: m.id, name: m.name, reachable: m.reachable, worst: m.worst, counts: m.counts, hidden: m.hidden })),
    problems,
  };
}

export interface MapPortRange { name: string; from: number; to: number; usedCount: number; size: number; next: number | null }
export interface MapReserved { port: number; name: string; state: string; by: string | null }
export interface MapStack { name: string; label: string; state: string; members: { order: number; label: string; machineId: string; running: boolean | null; waitPort: number | null }[] }
export interface MapInput {
  tray: { machines: TrayMachine[]; state: TrayState; openOutages: number; generatedAt: string };
  ports?: { ranges: MapPortRange[]; reserved: MapReserved[]; clashes: { kind: string; detail: string }[] };
  stacks?: MapStack[];
}

const cell = (value: string | number | null | undefined): string => flatten(value === null || value === undefined ? "" : String(value)).replace(/\|/g, "/");
const table = (head: string[], rows: string[][]): string[] => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];

const rowLine = (row: TrayRow): string[] => [row.label, row.kind, row.state, row.port === null ? "" : String(row.port), row.protected ? "protected" : "", row.mine ? "mine" : "", row.detail];

/** One markdown document that says what runs where: every machine's rows with state and port, the stacks and their members, and the reserved port ranges. Meant to be written into a notes vault. */
export function systemsMapMarkdown(input: MapInput): string {
  const lines: string[] = ["# Systems map", "", `Generated ${input.tray.generatedAt}. Overall state: ${input.tray.state}. Open outages: ${input.tray.openOutages}.`, ""];
  for (const machine of input.tray.machines.filter((m) => m.id !== "stacks")) {
    const c = machine.counts;
    lines.push(`## ${cell(machine.name)}`, "", `${machine.os}, ${machine.reachable ? "reachable" : "not reachable"}${machine.lastSeen ? `, last seen ${machine.lastSeen}` : ""}. ${c.up} up, ${c.changed} changed, ${c.down} down, ${c.stopped} stopped${machine.hidden ? `, ${machine.hidden} hidden by rules` : ""}.`, "");
    if (machine.rows.length === 0) { lines.push("Nothing is watched on this machine.", ""); continue; }
    lines.push(...table(["Name", "Kind", "State", "Port", "Flags", "Owner", "Detail"], machine.rows.map(rowLine)), "");
  }
  if (input.stacks && input.stacks.length > 0) {
    lines.push("## Stacks", "");
    for (const stack of input.stacks) {
      lines.push(`### ${cell(stack.label)}`, "", `State: ${stack.state}.`, "");
      lines.push(...table(["Step", "Member", "Machine", "Running", "Waits for port"], stack.members.map((m) => [String(m.order), m.label, m.machineId, m.running === null ? "unknown" : m.running ? "yes" : "no", m.waitPort === null ? "" : String(m.waitPort)])), "");
    }
  }
  if (input.ports) {
    lines.push("## Ports", "");
    lines.push(...table(["Range", "Ports", "Used", "Next free"], input.ports.ranges.map((r) => [r.name, `${r.from}-${r.to}`, `${r.usedCount}/${r.size}`, r.next === null ? "full" : String(r.next)])), "");
    if (input.ports.reserved.length > 0) lines.push(...table(["Port", "Reserved for", "State", "Held by"], input.ports.reserved.map((r) => [String(r.port), r.name, r.state, r.by ?? ""])), "");
    for (const clash of input.ports.clashes) lines.push(`- Clash (${clash.kind}): ${clash.detail}`);
    if (input.ports.clashes.length > 0) lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
