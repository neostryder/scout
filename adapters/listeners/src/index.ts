import { isIP } from "node:net";
import type { ListenerAdapter, ListenerBind, ListenerFact, ListenerResult, ProbeOutput, ProbeOutputs } from "@scout/core";
import { DOCKER_PORTS_SCRIPT, MAC_LISTENERS_SCRIPT, WINDOWS_LISTENERS_SCRIPT } from "./probes.ts";

const result = (origin: string, status: ListenerResult["status"], facts: ListenerFact[] = [], message?: string): ListenerResult => ({ origin, status, facts, ...(message === undefined ? {} : { message }) });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const portNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
const pidNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const path = (value: string): string => value.replaceAll("\\", "/").replace(/((?:[A-Za-z]:)?\/Users\/)[^/]+/gi, "$1USER");

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
      if (!object(row) || !portNumber(row["port"]) || !pidNumber(row["pid"]) || typeof row["address"] !== "string" || !(row["name"] === null || typeof row["name"] === "string") || !(row["path"] === null || typeof row["path"] === "string")) { malformed = true; continue; }
      const binding = address(row["address"]);
      if (!binding) { malformed = true; continue; }
      facts.push({ port: row["port"], protocol: "tcp", ...binding, pid: row["pid"], processName: row["name"], processPath: row["path"] === null ? null : path(row["path"]), container: null });
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
    const sections = probe.stdout.split(/^---SCOUT-PS---\r?$/m);
    let malformed = sections.length !== 2;
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
        facts.push({ port, protocol: "tcp", ...binding, pid, processName: processPath?.split("/").at(-1) ?? name, processPath, container: null });
      } else if (/^f\d+$/.test(line)) {
        if (filePending) malformed = true;
        filePending = true;
      } else malformed = true;
    }
    if (processPending || filePending) malformed = true;
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
