import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubMachineId, outagesResponse, portsFileReader, portsResponse, stacksFileReader, stacksResponse, statusSummary, trayFileReader, trayResponse, watchFileReader, type Db, type MapInput, type StatusSummary } from "@scout/core";

export interface LocalPaths {
  root: string;
  db: string;
  machines: string;
  protectedFile: string;
  ports: string;
  stacks: string;
  tray: string;
  watch: string;
  alerts: string;
  tunnelHosts: string;
  competitors: string;
}

/** The repository root, found from this file, so a command works from any folder. */
export const scoutRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Where the hub machine keeps its catalog and registry files, relative to a Scout checkout. */
export function localPaths(root: string = scoutRoot(), db?: string): LocalPaths {
  const data = (name: string): string => resolve(root, ".scout-data", name);
  return { root, db: db === undefined ? data("catalog.db") : db === ":memory:" ? db : resolve(db), machines: resolve(root, "machines.json"), protectedFile: data("protected.json"), ports: data("ports.json"), stacks: data("stacks.json"), tray: data("tray.json"), watch: data("watch.json"), alerts: data("alerts.json"), tunnelHosts: data("tunnel-hosts.json"), competitors: data("competitors.json") };
}

/** The tray read model built straight from the catalog and the local rules, the same rows the panel lists. */
export function localTray(db: Db, paths: LocalPaths, now: string = new Date().toISOString()) {
  const stacks = stacksResponse(db, stacksFileReader(paths.stacks)(), now).stacks;
  return trayResponse(db, trayFileReader(paths.tray)().rules, { now, stacks, context: { machineId: hubMachineId(), pid: process.pid, parentPid: process.ppid } });
}

/** Everything the systems map prints: the tray rows, the stacks, and the port registry. */
export function localMapInput(db: Db, paths: LocalPaths, now: string = new Date().toISOString()): MapInput {
  return { tray: localTray(db, paths, now), stacks: stacksResponse(db, stacksFileReader(paths.stacks)(), now).stacks, ports: portsResponse(db, portsFileReader(paths.ports)(), now) };
}

/** The overall state, the machines, and the rows and open outages that explain it. */
export function localStatus(db: Db, paths: LocalPaths, now: string = new Date().toISOString()): StatusSummary {
  const open = outagesResponse(db, watchFileReader(paths.watch)(), new URLSearchParams({ state: "open", limit: "100" }), now).outages;
  return statusSummary(localTray(db, paths, now), open);
}
