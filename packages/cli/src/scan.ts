#!/usr/bin/env node
// Read-only inventory scan. Usage: node packages/cli/src/scan.ts [machine ...] [--db <path>] [--only <sourceKind,...>] (deps reads dependency facts, services reads service state)
// Prints a coverage line per source and stores the results in the catalog. Nothing is installed or launched.
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { proposeMerges, applyCategoryRules, deriveConstraints, inheritDescriptions, deriveScanAssertions, deriveUsage, inheritUsage, linkIdentity, openCatalog, recordDependencies, recordScan, recordUsage, upsertMachine, runProbe, type Transport, type Adapter, type ProbeOutputs, type ScanResult } from "@scout/core";
import { createAdapter as aiUseAdapter, loadCheckpoints, saveCheckpoints } from "@scout/adapter-aiuse";
import { configureHubMachine, collectListeners, collectServices } from "@scout/ops";
import { alertsFileReader, loadTunnelHosts } from "@scout/core";
import { ADAPTERS, DEPENDENCY_ADAPTERS, GUEST_ADAPTERS, GUEST_USAGE_ADAPTERS, PER_PREFIX, PROCESS_GATES, USAGE_ADAPTERS } from "./adapters.ts";
import { GUEST_PS_SCRIPT, runningGuests } from "./guests.ts";

interface MachineConfig {
  id: string;
  name: string;
  os: "windows" | "macos" | "linux";
  address?: string;
  transport: Transport;
  /** Folders that hold projects, for the project-selector scan. A trailing `/*` means each child folder not starting with `_` or `.`. */
  projectRoots?: string[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = resolve(flag("--db") ?? `${root}/.scout-data/catalog.db`);
const only = flag("--only")?.split(",");
const wanted = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));

const config = { machines: configureHubMachine(`${root}/machines.json`) as unknown as MachineConfig[] };
mkdirSync(dirname(dbPath), { recursive: true });
const db = openCatalog(dbPath);
const alerts = { loadMutes: alertsFileReader(resolve(root, ".scout-data/alerts.json")), tunnelHosts: loadTunnelHosts(resolve(root, ".scout-data/tunnel-hosts.json")) };

async function homebrewPrefixes(m: MachineConfig): Promise<string[]> {
  const out = await runProbe(m.transport, {
    id: "prefixes",
    argv: ["/bin/sh", "-c", 'for p in /opt/homebrew /usr/local "$HOME/.homebrew"; do [ -x "$p/bin/brew" ] && echo "$p"; done'],
  });
  return out.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function scanSource(
  machineId: string,
  os: MachineConfig["os"],
  transport: Transport,
  adapter: Adapter,
  location: string,
  roots: Record<string, string[]> = {},
): Promise<ScanResult> {
  const probes = adapter.probes({ machineId, os, roots }, location);
  const outputs: ProbeOutputs = {};
  for (const probe of probes) outputs[probe.id] = await runProbe(transport, probe);
  return adapter.parse(outputs, location);
}

function report(machineId: string, result: ScanResult): void {
  const summary = recordScan(db, machineId, result, new Date().toISOString());
  const where = result.location ? ` [${result.location}]` : "";
  console.log(
    `  ${result.sourceKind.padEnd(9)}${result.status.padEnd(8)}${String(result.installs.length).padStart(5)} found` +
      `  +${summary.added} ~${summary.updated} -${summary.removed}${where}${result.message ? `  (${result.message})` : ""}`,
  );
}

/** Expand `dir/*` project roots to the child folders, skipping names that start with `_` or `.` (worktrees, vendored copies, hidden folders). */
function projectRootsFor(m: MachineConfig): Record<string, string[]> {
  if (!m.projectRoots) return {};
  const roots: string[] = [];
  for (const entry of m.projectRoots) {
    if (!entry.endsWith("/*")) {
      roots.push(entry);
      continue;
    }
    const base = entry.slice(0, -2);
    if (m.transport.type !== "local") continue;
    for (const child of readdirSync(base, { withFileTypes: true })) {
      if (child.isDirectory() && !child.name.startsWith("_") && !child.name.startsWith(".")) roots.push(`${base}/${child.name}`);
    }
  }
  return { project: roots };
}

async function collectDependencies(m: MachineConfig): Promise<void> {
  for (const adapter of DEPENDENCY_ADAPTERS) {
    if (!adapter.os.includes(m.os)) continue;
    const outputs: ProbeOutputs = {};
    // winget show runs once per installed package, which takes a minute or two.
    const timeout = adapter.origin === "winget-deps" ? 600_000 : undefined;
    for (const probe of adapter.probes({ machineId: m.id, os: m.os, roots: {} })) outputs[probe.id] = await runProbe(m.transport, probe, timeout);
    const result = adapter.parse(outputs);
    const stored = recordDependencies(db, m.id, result, new Date().toISOString());
    console.log(`  deps ${adapter.origin.padEnd(12)}${result.status.padEnd(8)}${String(result.facts.length).padStart(5)} facts  ${stored.edges} stored, ${stored.skipped} matched no install${result.message ? `  (${result.message})` : ""}`);
  }
}

const logLine = (line: string): void => console.log(line);

async function collectUsage(m: MachineConfig): Promise<void> {
  // The AI-use miner keeps a per-machine checkpoint so each scan reads only what the logs gained.
  const adapters = [...USAGE_ADAPTERS, aiUseAdapter(loadCheckpoints(db, m.id))];
  for (const adapter of adapters) {
    if (!adapter.os.includes(m.os)) continue;
    const outputs: ProbeOutputs = {};
    // The first AI-use read covers every log file, which takes minutes; later reads start from the checkpoint.
    const timeout = adapter.origin === "ai-use" ? 900_000 : undefined;
    for (const probe of adapter.probes({ machineId: m.id, os: m.os, roots: {} })) outputs[probe.id] = await runProbe(m.transport, probe, timeout);
    const result = adapter.parse(outputs);
    if (adapter.origin === "ai-use" && result.status !== "failed") saveCheckpoints(db, m.id, outputs, new Date().toISOString());
    const stored = recordUsage(db, m.id, result, new Date().toISOString());
    console.log(`  usage ${adapter.origin.padEnd(11)}${result.status.padEnd(8)}${String(result.signals.length).padStart(5)} readings  ${stored.signals} stored, ${stored.unmatched} matched no install${result.message ? `  (${result.message})` : ""}`);
  }
}

/** Guests of a macOS host. Detected from the process list; a guest's CLI is called only while it is running. */
async function scanGuests(m: MachineConfig): Promise<void> {
  if (m.transport.type !== "ssh") return;
  const ps = await runProbe(m.transport, { id: "guest-ps", argv: ["/bin/sh", "-c", GUEST_PS_SCRIPT] });
  const running = runningGuests(ps.stdout);

  const seed = (guest: string, state: string): string => {
    const id = `${m.id}/${guest}`;
    upsertMachine(db, { id, name: `${m.name} ${guest}`, os: "linux", kind: "guest", parentId: m.id, guestType: guest });
    const seen = state === "reachable" ? new Date().toISOString() : null;
    db.prepare("UPDATE machines SET state = ?, last_seen = COALESCE(?, last_seen) WHERE id = ?").run(state, seen, id);
    return id;
  };

  if (running.includes("colima")) {
    const id = seed("colima", "reachable");
    console.log(`\n${m.name} colima (${id})`);
    // Docker's CLI on the host talks to colima's engine, and the containers belong to the guest.
    for (const adapter of GUEST_ADAPTERS.host) {
      report(id, await scanSource(id, "linux", m.transport, adapter, ""));
    }
    const inside: Transport = { ...m.transport, guest: ["colima", "ssh", "--"] };
    for (const adapter of GUEST_ADAPTERS.linux) {
      report(id, await scanSource(id, "linux", inside, adapter, ""));
    }
    for (const adapter of GUEST_USAGE_ADAPTERS) {
      const outputs: ProbeOutputs = {};
      for (const probe of adapter.probes({ machineId: id, os: "linux", roots: {} })) outputs[probe.id] = await runProbe(inside, probe);
      const result = adapter.parse(outputs);
      const stored = recordUsage(db, id, result, new Date().toISOString());
      console.log(`  usage ${adapter.origin.padEnd(11)}${result.status.padEnd(8)}${String(result.signals.length).padStart(5)} readings  ${stored.signals} stored, ${stored.unmatched} matched no install`);
    }
  }
  if (running.includes("docker-desktop")) console.log(`\n${m.name} docker desktop: running, but no adapter exists yet`);
}

for (const m of config.machines) {
  if (wanted.length > 0 && !wanted.includes(m.id)) continue;
  upsertMachine(db, { id: m.id, name: m.name, os: m.os, kind: "host", ...(m.address ? { address: m.address } : {}) });
  console.log(`\n${m.name} (${m.id})`);
  const reachable = await runProbe(m.transport, {
    id: "ping",
    argv: m.os === "windows" ? ["pwsh", "-NoProfile", "-Command", "1"] : ["/bin/sh", "-c", "true"],
  });
  if (reachable.exitCode !== 0) {
    console.log(`  unreachable: ${reachable.stderr.trim().split("\n")[0] ?? ""}`);
    db.prepare("UPDATE machines SET state = 'unreachable' WHERE id = ?").run(m.id);
    continue;
  }
  db.prepare("UPDATE machines SET state = 'reachable', last_seen = ? WHERE id = ?").run(new Date().toISOString(), m.id);
  const prefixes = m.os === "macos" && (!only || only.some((k) => PER_PREFIX.has(k))) ? await homebrewPrefixes(m) : [];
  for (const adapter of ADAPTERS) {
    if (!adapter.os.includes(m.os)) continue;
    if (only && !only.includes(adapter.sourceKind)) continue;
    const gate = PROCESS_GATES[adapter.sourceKind];
    if (gate && m.os === "windows") {
      const up = await runProbe(m.transport, {
        id: "gate",
        argv: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Name ${gate} -ErrorAction SilentlyContinue | Measure-Object).Count`],
      });
      if (up.stdout.trim() === "0" || up.stdout.trim() === "") {
        report(m.id, { sourceKind: adapter.sourceKind, location: "", status: "skipped", installs: [], message: `${gate} is not running; Scout never starts a service to scan it` });
        continue;
      }
    }
    const locations = PER_PREFIX.has(adapter.sourceKind) ? prefixes : [""];
    for (const location of locations) {
      report(m.id, await scanSource(m.id, m.os, m.transport, adapter, location, adapter.sourceKind === "projectsel" ? projectRootsFor(m) : {}));
    }
  }
  if (!only || only.includes("deps")) await collectDependencies(m);
  if (!only || only.includes("listeners")) await collectListeners(db, m, { log: logLine, alerts });
  if (!only || only.includes("services")) await collectServices(db, m, { log: logLine, alerts });
  if (!only) await collectUsage(m);
  if (m.os === "macos" && !only) await scanGuests(m);
}
const linked = linkIdentity(db);
const proposals = proposeMerges(db);
const constrained = deriveConstraints(db);
const categorized = applyCategoryRules(db);
const derived = deriveUsage(db);
const shared = inheritUsage(db);
deriveScanAssertions(db);
const inherited = inheritDescriptions(db);
console.log(`\nidentity: ${linked.items} items (${linked.merged} joined by rule), ${linked.relations} relations, ${proposals.proposed} merge proposals; constraints: ${constrained.freezes} freezes, ${constrained.gatedRanges} gated tags; ${categorized.assigned} categories by rule; ${derived.signals + shared.signals} usage signals; ${inherited.inherited} descriptions inherited from siblings`);
console.log(`catalog: ${dbPath}`);
