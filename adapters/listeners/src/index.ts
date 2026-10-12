import { isIP } from "node:net";
import type { ListenerAdapter, ListenerBind, ListenerFact, ListenerResult, ProbeOutput, ProbeOutputs } from "@scout/core";
import { DOCKER_PORTS_SCRIPT, MAC_LISTENERS_SCRIPT, WINDOWS_LISTENERS_SCRIPT } from "./probes.ts";

const result = (origin: string, status: ListenerResult["status"], facts: ListenerFact[] = [], message?: string): ListenerResult => ({ origin, status, facts, ...(message === undefined ? {} : { message }) });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const portNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
const pidNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const path = (value: string): string => value.replaceAll("\\", "/").replace(/((?:[A-Za-z]:)?\/Users\/)[^/]+/gi, "$1USER");

/** Splits a command line into words, honoring double and single quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const VALUE_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--eval", "-e", "--print", "-p", "--env-file", "--conditions", "-c", "--max-old-space-size", "-W", "-X", "-Xmx", "-cp", "-classpath"]);

/** The script, module, or jar a runtime was started with. The other arguments can hold secrets, so they are dropped here. */
export function scriptOf(processName: string | null, commandLine: string | null, cwd: string | null = null): string | null {
  const found = firstScript(processName, commandLine);
  if (found === null || !cwd || /^(?:[A-Za-z]:)?[\\/]/.test(found) || !/\.(?:[cm]?[jt]sx?|py|rb|php|pl|jar)$/i.test(found)) return found;
  return path(`${cwd.replaceAll("\\", "/").replace(/\/+$/, "")}/${found.replace(/^\.\//, "")}`);
}

function firstScript(processName: string | null, commandLine: string | null): string | null {
  if (!processName || !commandLine) return null;
  const runtime = processName.toLowerCase().replace(/\.exe$/, "");
  const args = words(commandLine).slice(1);
  const python = /^python[0-9.]*w?$/.test(runtime);
  const java = runtime === "java" || runtime === "javaw";
  if (!python && !java && !["node", "nodejs", "bun", "deno", "ruby", "php", "perl"].includes(runtime)) return null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (python && arg === "-m" && args[i + 1]) return args[i + 1]!;
    if (java && arg === "-jar" && args[i + 1]) return path(args[i + 1]!);
    if (arg.startsWith("-")) { if (VALUE_FLAGS.has(arg) || python && arg === "-m" || java && arg === "-jar") i++; continue; }
    if (java || ["run", "start", "serve", "task"].includes(arg) && runtime === "deno") continue;
    return path(arg);
  }
  return null;
}

function address(value: string): { address: string; bind: ListenerBind } | null {
  const normalized = value.replace(/^\[(.*)\]$/, "$1").replace(/%[^%]+$/, "").toLowerCase();
  if (["*", "0.0.0.0", "::"].includes(normalized)) return { address: normalized, bind: "all" };
  if (normalized === "localhost") return { address: normalized, bind: "loopback" };
  if (!isIP(normalized)) return null;
  const loopback = /^127\./.test(normalized) || normalized === "::1" || /^::ffff:127\./.test(normalized);
  return { address: normalized, bind: loopback ? "loopback" : "lan" };
}

function unavailable(outputs: ProbeOutputs, id: string, origin: string, optional = false): ListenerResult | null {
  const probe = outputs[id];
  if (!probe) return result(origin, optional ? "skipped" : "failed", [], "probe output missing");
  if (probe.exitCode === 127 || probe.exitCode === 9009) return result(origin, "skipped", [], "listener tool did not run");
  if (probe.exitCode !== 0 && !probe.stdout.trim()) return result(origin, optional ? "skipped" : "failed", [], "listener probe did not run");
  return null;
}

function finish(origin: string, probe: ProbeOutput, facts: ListenerFact[], malformed: boolean): ListenerResult {
  const partial = malformed || probe.exitCode !== 0;
  const seen = new Set<string>();
  const unique = facts.filter((fact) => {
    const key = JSON.stringify([fact.port, fact.address, fact.pid, fact.processName, fact.container?.name]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result(origin, partial ? unique.length ? "partial" : "failed" : "ok", unique, partial ? "some listener records could not be read" : undefined);
}

export const windowsListenersAdapter: ListenerAdapter = {
  origin: "netconn",
  os: ["windows"],
  probes() {
    return [{ id: "listeners", argv: ["pwsh", "-NoProfile", "-Command", WINDOWS_LISTENERS_SCRIPT] }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "listeners", "netconn");
    if (missing) return missing;
    const probe = outputs["listeners"]!;
    let doc: unknown;
    try { doc = probe.stdout.trim() ? JSON.parse(probe.stdout) : []; }
    catch { return result("netconn", "failed", [], "listener output is not valid JSON"); }
    if (!Array.isArray(doc) && !object(doc)) return result("netconn", "failed", [], "listener records could not be read");
    const facts: ListenerFact[] = [];
    let malformed = false;
    for (const row of Array.isArray(doc) ? doc : [doc]) {
      if (!object(row) || !portNumber(row["port"]) || !pidNumber(row["pid"]) || typeof row["address"] !== "string" || !(row["name"] === null || typeof row["name"] === "string") || !(row["path"] === null || typeof row["path"] === "string") || !(row["cmd"] === undefined || row["cmd"] === null || typeof row["cmd"] === "string") || !(row["owner"] === undefined || row["owner"] === null || typeof row["owner"] === "string")) { malformed = true; continue; }
      const binding = address(row["address"]);
      if (!binding) { malformed = true; continue; }
      const scriptPath = scriptOf(row["name"], typeof row["cmd"] === "string" ? row["cmd"] : null, typeof row["cwd"] === "string" ? row["cwd"] : null);
      const ppid = pidNumber(row["ppid"]) && row["ppid"] > 0 ? row["ppid"] : null;
      const owner = typeof row["owner"] === "string" && row["owner"].trim() ? row["owner"].trim() : null;
      facts.push({ port: row["port"], protocol: "tcp", ...binding, pid: row["pid"], processName: row["name"], processPath: row["path"] === null ? null : path(row["path"]), ...(scriptPath ? { scriptPath } : {}), ...(ppid ? { ppid } : {}), ...(owner ? { owner } : {}), container: null });
    }
    return finish("netconn", probe, facts, malformed);
  },
};

function command(value: string): string {
  return value.replace(/\\x([0-9a-f]{2})|\\([0-7]{3})|\\([\\ ])/gi, (_, hex: string | undefined, octal: string | undefined, literal: string | undefined) => literal ?? String.fromCharCode(Number.parseInt(hex ?? octal!, hex ? 16 : 8)));
}

export const macListenersAdapter: ListenerAdapter = {
  origin: "lsof",
  os: ["macos"],
  probes() {
    return [{ id: "listeners", argv: ["/bin/sh", "-c", MAC_LISTENERS_SCRIPT] }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "listeners", "lsof");
    if (missing) return missing;
    const probe = outputs["listeners"]!;
    const sections = probe.stdout.split(/^---SCOUT-(?:PS|ARGS|PPID|NETSTAT)---\r?$/m);
    let malformed = sections.length < 2 || sections.length > 5;
    const parents = new Map<number, number>();
    for (const line of (sections[3] ?? "").split(/\r?\n/).filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[2]) > 1) parents.set(Number(match[1]), Number(match[2]));
    }
    const argv = new Map<number, string>();
    for (const line of (sections[2] ?? "").split(/\r?\n/).filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) argv.set(Number(match[1]), match[2]!);
    }
    const paths = new Map<number, string>();
    for (const line of (sections[1] ?? "").split(/\r?\n/).filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) { malformed = true; continue; }
      // ps comm can contain a rewritten process title; only an absolute executable path is safe to keep.
      if (match[2]!.startsWith("/")) paths.set(Number(match[1]), path(match[2]!));
    }
    const facts: ListenerFact[] = [];
    let pid: number | null = null;
    let name: string | null = null;
    let processPending = false;
    let filePending = false;
    for (const line of sections[0]!.split(/\r?\n/).filter(Boolean)) {
      if (line.startsWith("p")) {
        if (processPending || filePending) malformed = true;
        processPending = true;
        filePending = false;
        pid = /^p\d+$/.test(line) && pidNumber(Number(line.slice(1))) ? Number(line.slice(1)) : null;
        name = null;
        if (pid === null) malformed = true;
      } else if (line.startsWith("c")) {
        name = command(line.slice(1));
        if (pid === null || !name) malformed = true;
      } else if (line.startsWith("n")) {
        filePending = false;
        const match = /^n(.+):(\d+)$/.exec(line);
        const binding = match ? address(match[1]!) : null;
        const port = Number(match?.[2]);
        if (pid === null || !name || !binding || !portNumber(port)) { malformed = true; continue; }
        processPending = false;
        const processPath = paths.get(pid) ?? null;
        const processName = processPath?.split("/").at(-1) ?? name;
        const scriptPath = scriptOf(processName, argv.get(pid) ?? null);
        const ppid = parents.get(pid);
        facts.push({ port, protocol: "tcp", ...binding, pid, processName, processPath, ...(scriptPath ? { scriptPath } : {}), ...(ppid ? { ppid } : {}), container: null });
      } else if (/^f\d+$/.test(line)) {
        if (filePending) malformed = true;
        filePending = true;
      } else malformed = true;
    }
    if (processPending || filePending) malformed = true;
    // lsof shows only the sockets of the account that runs it. netstat lists every listening socket with its owner's name and pid, so it adds the system daemons and other accounts' processes.
    for (const line of (sections[4] ?? "").split(/\r?\n/)) {
      const match = /^(tcp4|tcp6|tcp46)\s+\d+\s+\d+\s+(\S+)\s+\S+\s+LISTEN\s+\d+\s+\d+\s+\d+\s+\d+\s+(.+?):(\d+)\s+[0-9a-f]{5}\s/.exec(line);
      if (!match) continue;
      const split = match[2]!.lastIndexOf(".");
      const port = Number(match[2]!.slice(split + 1));
      const host = match[2]!.slice(0, split);
      const owner = Number(match[4]);
      const binding = address(host === "*" && match[1] === "tcp4" ? "0.0.0.0" : host === "*" && match[1] === "tcp6" ? "::" : host);
      if (!binding || !portNumber(port) || !pidNumber(owner) || owner <= 0 || facts.some((fact) => fact.port === port && fact.pid === owner && fact.bind === binding.bind)) continue;
      const processPath = paths.get(owner) ?? null;
      const processName = processPath?.split("/").at(-1) ?? match[3]!.trim();
      const scriptPath = scriptOf(processName, argv.get(owner) ?? null);
      const ppid = parents.get(owner);
      facts.push({ port, protocol: "tcp", ...binding, pid: owner, processName, processPath, ...(scriptPath ? { scriptPath } : {}), ...(ppid ? { ppid } : {}), container: null });
    }
    return finish("lsof", probe, facts, malformed);
  },
};

export const dockerPortsAdapter: ListenerAdapter = {
  origin: "docker-ports",
  os: ["macos"],
  probes() {
    return [{ id: "ports", argv: ["/bin/sh", "-c", DOCKER_PORTS_SCRIPT], optional: true }];
  },
  parse(outputs) {
    const missing = unavailable(outputs, "ports", "docker-ports", true);
    if (missing) return missing;
    const probe = outputs["ports"]!;
    if (!probe.stdout.trim()) return result("docker-ports", "skipped", [], "no published container ports were reported");
    const facts: ListenerFact[] = [];
    let malformed = false;
    for (const line of probe.stdout.split(/\r?\n/).filter(Boolean)) {
      const fields = line.split("|");
      const [name, image, ports, status] = fields;
      if (fields.length !== 4 || !name || !image || !status || ports === undefined) { malformed = true; continue; }
      for (const mapping of ports.split(",").map((port) => port.trim()).filter(Boolean)) {
        if (/^\d+(?:-\d+)?\/(tcp|udp)$/.test(mapping)) continue;
        const match = /^(.+):(\d+)->(\d+)\/(tcp|udp)$/.exec(mapping);
        const binding = match ? address(match[1]!) : null;
        const port = Number(match?.[2]);
        const containerPort = Number(match?.[3]);
        if (!match || !binding || !portNumber(port) || !portNumber(containerPort)) { malformed = true; continue; }
        if (match[4] === "udp") continue;
        facts.push({ port, protocol: "tcp", ...binding, pid: null, processName: null, processPath: null, container: { name, image, containerPort } });
      }
    }
    return finish("docker-ports", probe, facts, malformed);
  },
};
