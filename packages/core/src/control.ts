import { isProtected, type ProtectedContext, type Protection } from "./protected.ts";
import type { Service, ServiceKind } from "./services.ts";
import type { Listener } from "./listeners.ts";

export type ControlAction = "start" | "stop" | "restart";
export type ControlTarget = "service" | "listener" | "recipe" | "stack";
export type ControlMechanism = ServiceKind | "process" | "recipe" | "stack";
export interface ControlRow {
  id: number;
  machineId: string;
  machineName: string;
  name: string;
  displayName: string | null;
  program: string | null;
  pid: number | null;
  state: string;
  goneAt: string | null;
  kind: ServiceKind | null;
  domain: "system" | "gui";
  uid?: number | null;
  keepAlive?: boolean | null;
  plist?: string | null;
  classification: Service["classification"];
  ports: { port: number }[];
  serviceId?: number;
  recipe?: import("./recipes.ts").LaunchRecipe;
  stack?: import("./stacks.ts").ResolvedStack;
}
export interface RowControl {
  mechanism: ControlMechanism | null;
  actions: { action: ControlAction; available: boolean; reason: string | null }[];
  protected: Protection;
  needsAdmin: boolean;
  uninstall: boolean;
}

export function controlRow(row: Service | Listener, services: Service[] = []): ControlRow {
  if ("kind" in row) return row;
  const path = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
  const service = services.find((s) => s.machineId === row.machineId && s.goneAt === null && row.pid !== null && s.pid === row.pid) ?? services.find((s) => s.machineId === row.machineId && s.goneAt === null && s.pid === null && s.program !== null && row.processPath !== null && (s.kind === "launchd" ? s.program === row.processPath : path(s.program) === path(row.processPath)));
  if (service) return { ...service, id: row.id, serviceId: service.id, ports: [...service.ports, { port: row.port }], classification: row.classification };
  return { id: row.id, machineId: row.machineId, machineName: row.machineName, name: row.processName ?? "Unknown process", displayName: null, program: row.processPath, pid: row.pid, state: row.goneAt === null ? "running" : "stopped", goneAt: row.goneAt, kind: null, domain: "gui", classification: row.classification, ports: [{ port: row.port }] };
}

export function rowControl(row: ControlRow, context: ProtectedContext = {}, enabled = true): RowControl {
  const mechanism = row.kind ?? (row.pid !== null && row.program !== null ? "process" : null);
  const protection = isProtected(row, context);
  const running = row.state === "running" && row.goneAt === null;
  return {
    mechanism,
    actions: (["start", "stop", "restart"] as const).map((action) => {
      let reason: string | null = null;
      if (!enabled) reason = "Control is off.";
      else if (action !== "start" && protection.protected) reason = `Protected: ${protection.group === "remote-access" ? "remote access" : protection.group}`;
      else if (mechanism === null) reason = "The process identity is unknown";
      else if (mechanism === "process" && action !== "stop") reason = "A bare process has no start command";
      else if (row.goneAt !== null) reason = "The row is no longer present";
      else if (action === "start" && running) reason = "Already running";
      else if (action !== "start" && !running) reason = "Not running";
      return { action, available: reason === null, reason };
    }),
    protected: protection,
    needsAdmin: row.kind === "windows-service" && row.domain === "system" || row.kind === "launchd" && row.domain === "system",
    uninstall: true,
  };
}
