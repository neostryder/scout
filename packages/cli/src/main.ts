#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubMachineId, setHubMachine, findHubMachine, listRoutes, loadTunnelHosts, openCatalog, type RouteState } from "@scout/core";
import { configureHubMachine, loadMachines, lookupCloudflareSecrets, readCloudflare } from "@scout/ops";
import { describeCommand } from "./describe.ts";
import { recipesCommand } from "./recipes.ts";
import { findProjects } from "@scout/core";
import { controlCommand } from "./control.ts";
import { alertsCommand } from "./alerts.ts";
import { alertsFileReader } from "@scout/core";
import { healthCommand } from "./health.ts";
import { portsCommand } from "./ports.ts";
import { stacksCommand } from "./stacks.ts";

const STATES = ["ok", "origin-down", "dns-dangling", "no-origin", "unknown"];

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const next = index >= 0 ? args[index + 1] : undefined;
  if (next === undefined || next.startsWith("--")) return undefined;
  return next;
}

function clip(text: string | null, length: number): string {
  return (text ?? "").replace(/\s+/g, " ").slice(0, length).padEnd(length + 2);
}

function printRoutes(dbPath: string, args: string[]): void {
  const state = value(args, "--state");
  const machine = value(args, "--machine");
  if (state !== undefined && !STATES.includes(state)) throw new Error("--state requires ok, origin-down, dns-dangling, no-origin or unknown");
  const db = openCatalog(dbPath);
  try {
    const rows = listRoutes(db, { tunnelHosts: loadTunnelHosts(resolve(dirname(dbPath), "tunnel-hosts.json")), ...(machine ? { machine } : {}), ...(state ? { state: state as RouteState } : {}) });
    console.log(`${clip("Hostname", 36)}${clip("Via", 16)}${clip("State", 14)}${clip("Machine", 18)}${clip("Tunnel", 18)}Origin`);
    for (const row of rows) console.log(`${clip(row.hostname, 36)}${clip(row.via, 16)}${clip(row.state, 14)}${clip(row.machineName, 18)}${clip(row.tunnel?.name ?? null, 18)}${row.origin?.service ?? ""}`);
    console.log(`\n${rows.length} route${rows.length === 1 ? "" : "s"}`);
  } finally {
    db.close();
  }
}

async function printRead(dbPath: string, args: string[]): Promise<void> {
  const db = openCatalog(dbPath);
  try {
    if (args.includes("--no-cloudflare")) {
      console.log("reader off");
      return;
    }
    const secretName = value(args, "--cloudflare-secret");
    const found = await lookupCloudflareSecrets({ env: process.env, ...(secretName ? { secretName } : {}) });
    if (!found) {
      console.log("reader off");
      return;
    }
    const result = await readCloudflare(db, { token: found.token, accountId: found.accountId });
    console.log(`reader ${result.state}`);
    console.log(`zones ${result.counts.zones}`);
    console.log(`dns ${result.counts.dns}`);
    console.log(`tunnels ${result.counts.tunnels}`);
    console.log(`ingress ${result.counts.ingress}`);
    console.log(`access ${result.counts.access}`);
    console.log(`workers ${result.counts.workers}`);
    console.log(`changed ${result.changed}`);
    if (result.state === "fresh" && result.error) {
      for (const part of result.error.split("; ")) {
        const name = part.replace(/:\s*not permitted\s*$/i, "").trim();
        if (name) console.log(`degraded ${name}`);
      }
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (existsSync(resolve(root, "machines.json"))) configureHubMachine(resolve(root, "machines.json"));
  const requestedDb = value(args, "--db") ?? `${root}/.scout-data/catalog.db`;
  const dbPath = requestedDb === ":memory:" ? requestedDb : resolve(requestedDb);
  if (args[0] === "ports" || args[0] === "stacks") {
    if (args[0] === "stacks" && args[1] === "start" && !args.includes("--yes")) throw new Error("stacks start requires --yes");
    const db = openCatalog(dbPath);
    try {
      if (args[0] === "ports") portsCommand(db, args.slice(1), { portsPath: resolve(root, ".scout-data/ports.json") });
      else await stacksCommand(db, args.slice(1), { stacksPath: resolve(root, ".scout-data/stacks.json"), deps: { machines: args[1] === "plan" || args[1] === "start" ? loadMachines(resolve(root, "machines.json")) : [], protectedPath: resolve(root, ".scout-data/protected.json"), context: { machineId: hubMachineId(), pid: process.pid, parentPid: process.ppid } } });
    } finally { db.close(); }
    return;
  }
  if (args[0] === "health") {
    const db = openCatalog(dbPath);
    try { await healthCommand(db, args.slice(1), { probe: { tunnelHosts: loadTunnelHosts(resolve(root, ".scout-data/tunnel-hosts.json")), alerts: { loadMutes: alertsFileReader(resolve(root, ".scout-data/alerts.json")) } } }); } finally { db.close(); }
    return;
  }
  if (args[0] === "alerts") {
    const db = openCatalog(dbPath);
    try { alertsCommand(db, args.slice(1), { alerts: { loadMutes: alertsFileReader(resolve(root, ".scout-data/alerts.json")), tunnelHosts: loadTunnelHosts(resolve(root, ".scout-data/tunnel-hosts.json")) } }); } finally { db.close(); }
    return;
  }
  if (args[0] === "recipes") {
    const db = openCatalog(dbPath);
    try {
      recipesCommand(db, args.slice(1), { projects: () => {
        const machine = loadMachines(resolve(root, "machines.json")).find((item) => item.id === hubMachineId() && item.transport.type === "local") as { id: string; projectRoots?: string[] } | undefined;
        return machine ? findProjects(machine.id, machine.projectRoots ?? []) : [];
      } });
    } finally { db.close(); }
    return;
  }
  if (args[0] === "control") {
    if (args[1] === "run" && !args.includes("--yes")) throw new Error("control run requires --yes");
    const db = openCatalog(dbPath);
    try {
      const machines = args[1] === "plan" || args[1] === "run" ? loadMachines(resolve(root, "machines.json")) : [];
      await controlCommand(db, args.slice(1), { deps: { machines, context: { machineId: hubMachineId(), pid: process.pid, parentPid: process.ppid } }, protectedPath: resolve(root, ".scout-data/protected.json") });
    } finally { db.close(); }
    return;
  }
  if (args[0] === "describe") {
    const db = openCatalog(dbPath);
    try { await describeCommand(db, args.slice(1)); } finally { db.close(); }
    return;
  }
  if (args[0] === "routes") {
    printRoutes(dbPath, args.slice(1));
    return;
  }
  if (args[0] === "cloudflare" && args[1] === "read") {
    await printRead(dbPath, args.slice(2));
    return;
  }
  console.error("usage: node packages/cli/src/main.ts routes [--machine id] [--state state] [--db path]");
  console.error("       node packages/cli/src/main.ts cloudflare read [--cloudflare-secret KEY] [--no-cloudflare] [--db path]");
  console.error("       node packages/cli/src/main.ts describe [set|clear|public] [--missing] [--source source] [--machine id] [--db path]");
  console.error("       node packages/cli/src/main.ts describe project list|run [--force] [--only name]|show name [--db path]");
  console.error("       node packages/cli/src/main.ts recipes [--state s] | scan | approve <id> --yes | reject <id> [--db path]");
  console.error("       node packages/cli/src/main.ts control <plan|run|log|protected|uninstall> [arguments] [--db path]");
  console.error("       node packages/cli/src/main.ts alerts [--state state] [--kind kind] [--machine id] [--db path]");
  console.error("       node packages/cli/src/main.ts alerts ack <id|--all> | mute <key> [--reason text] | unmute <key> [--db path]");
  console.error("       node packages/cli/src/main.ts health [refresh] [--state state] [--kind kind] [--db path]");
  console.error("       node packages/cli/src/main.ts ports [next <range>] [--db path]");
  console.error("       node packages/cli/src/main.ts stacks [plan <name> | start <name> --yes] [--db path]");
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(["control", "recipes", "ports", "stacks"].includes(process.argv[2] ?? "") && err instanceof Error ? err.message : "command failed");
    process.exitCode = 1;
  });
}
