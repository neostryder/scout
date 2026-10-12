import { readFileSync } from "node:fs";
import type { Listener } from "./listeners.ts";
import type { ServiceFact } from "./services.ts";

export type ServiceClass = "essential" | "optional" | "third-party";
export type ServiceVendor = "apple" | "microsoft" | "other";

export interface Classification {
  class: ServiceClass;
  vendor: ServiceVendor;
  official: boolean;
  hidden: boolean;
  evidence: string[];
  whatBreaks: string | null;
  confidence: "curated" | "rule" | "default";
}

interface Rule {
  match: { kind: ServiceFact["kind"]; name?: string; namePrefix?: string; namePattern?: string };
  class: ServiceClass;
  whatBreaks: string;
}

const rules = JSON.parse(readFileSync(new URL("../data/service-rules.json", import.meta.url), "utf8")) as Rule[];
const windowsSystemProcesses = new Set(["system", "wininit", "services", "lsass", "smss", "csrss", "winlogon", "svchost", "spoolsv", "vmms", "wudfhost"]);
const appleDirectories = ["/system/", "/usr/libexec/", "/usr/sbin/", "/usr/bin/", "/sbin/", "/bin/", "/library/apple/"];

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function curated(kind: ServiceFact["kind"], name: string): Rule | undefined {
  return rules.find((rule) => rule.match.kind === kind && (
    rule.match.name === name ||
    (rule.match.namePrefix !== undefined && name.startsWith(rule.match.namePrefix)) ||
    (rule.match.namePattern !== undefined && new RegExp(rule.match.namePattern).test(name))
  ));
}

function unusual(path: string | null): boolean {
  if (path === null) return false;
  const value = normalizePath(path);
  return /(?:^|\/)(?:users|home)\/[^/]+\//.test(value) || /(?:^|\/)(?:temp|tmp|downloads?)\//.test(value);
}

function classify(kind: ServiceFact["kind"], name: string, program: string | null, exposed: boolean): Classification {
  const path = program === null ? "" : normalizePath(program);
  const taskPath = name.replace(/\\/g, "/").toLowerCase();
  const windowsTask = kind === "scheduled-task" && (taskPath.startsWith("/microsoft/windows/") || taskPath.startsWith("/microsoft/"));
  const windowsPath = path.startsWith("c:/windows/") || path.startsWith("c:/program files/windowsapps/microsoft.");
  const appleLabel = kind === "launchd" && name.startsWith("com.apple.");
  // A systemd unit under /usr/bin belongs to a Linux package, not to Apple; only the curated systemd rules call one essential.
  const applePath = kind !== "systemd" && appleDirectories.some((directory) => path.startsWith(directory));
  const microsoft = windowsPath || windowsTask;
  const apple = appleLabel || applePath;
  const vendor: ServiceVendor = microsoft ? "microsoft" : apple ? "apple" : "other";
  const official = vendor !== "other";
  const evidence: string[] = [];
  if (windowsPath) evidence.push("path under Windows system or Microsoft application directory");
  if (windowsTask) evidence.push("task path under /Microsoft/");
  if (appleLabel) evidence.push("label prefix com.apple. (by label)");
  if (applePath) evidence.push("program under Apple system directory (by path)");
  if (unusual(program)) evidence.push("unusual location");
  const entry = curated(kind, name);
  if (entry) {
    evidence.push(`curated ${entry.class}: ${name}`);
    return { class: entry.class, vendor, official, hidden: entry.class === "essential" && !exposed && !unusual(program), evidence, whatBreaks: entry.whatBreaks, confidence: "curated" };
  }
  const insideOs = microsoft || apple;
  if (insideOs) {
    if (evidence.length === 0) evidence.push("program under OS directory");
    return { class: "essential", vendor, official, hidden: !exposed && !unusual(program), evidence, whatBreaks: null, confidence: "rule" };
  }
  evidence.push("program outside OS directories");
  return { class: "third-party", vendor, official: false, hidden: false, evidence, whatBreaks: null, confidence: "default" };
}

export function classifyService(fact: ServiceFact, exposed = false): Classification {
  return classify(fact.kind, fact.name, fact.program, exposed);
}

type JoinFact = ServiceFact & { machineId?: string };
interface ServiceIndex { byPid: Map<string, number>; byPath: Map<string, number>; byLowerPath: Map<string, number> }

// A listing joins every listener to the services on its machine. Scanning the whole service list per listener took seconds of CPU on a busy machine, so the list is indexed once per array. Each entry keeps the position of its first fact, so the first match in list order still wins.
const indexes = new WeakMap<JoinFact[], ServiceIndex>();

function serviceIndex(facts: JoinFact[]): ServiceIndex {
  const cached = indexes.get(facts);
  if (cached) return cached;
  const index: ServiceIndex = { byPid: new Map(), byPath: new Map(), byLowerPath: new Map() };
  facts.forEach((fact, position) => {
    const machine = fact.machineId ?? "*";
    if (fact.pid !== null) {
      const key = `${machine}|${fact.pid}`;
      if (!index.byPid.has(key)) index.byPid.set(key, position);
    } else if (fact.program !== null) {
      const exact = `${machine}|${fact.program}`;
      if (!index.byPath.has(exact)) index.byPath.set(exact, position);
      const lower = `${machine}|${fact.program.toLowerCase()}`;
      if (!index.byLowerPath.has(lower)) index.byLowerPath.set(lower, position);
    }
  });
  indexes.set(facts, index);
  return index;
}

function earliest(map: Map<string, number>, machineId: string, value: string): number | undefined {
  const own = map.get(`${machineId}|${value}`);
  const any = map.get(`*|${value}`);
  return own === undefined ? any : any === undefined ? own : Math.min(own, any);
}

/** The first service fact that owns this listener: the same pid, else a pid-less fact with the same program path. */
function joinedService(row: Listener, facts: JoinFact[]): JoinFact | undefined {
  if (facts.length === 0) return undefined;
  const index = serviceIndex(facts);
  if (row.pid !== null) {
    const byPid = earliest(index.byPid, row.machineId, String(row.pid));
    if (byPid !== undefined) return facts[byPid];
  }
  if (row.processPath === null) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(row.processPath);
  const position = windows ? earliest(index.byLowerPath, row.machineId, row.processPath.toLowerCase()) : earliest(index.byPath, row.machineId, row.processPath);
  return position === undefined ? undefined : facts[position];
}

export function classifyListener(row: Listener, serviceFacts: (ServiceFact & { machineId?: string })[] = []): Classification {
  if (row.containerName !== null) {
    return { class: "third-party", vendor: "other", official: false, hidden: false, evidence: ["container listener"], whatBreaks: null, confidence: "rule" };
  }
  const service = joinedService(row, serviceFacts);
  const exposed = row.bind !== "loopback";
  if (service) {
    const result = classifyService(service, exposed);
    result.evidence.unshift(`joined service: ${service.name}`);
    result.hidden = result.class === "essential" && !exposed && !unusual(row.processPath);
    return result;
  }
  // Protected Windows processes report no path, so the name stands in for it; only these kernel and session processes are trusted by name.
  if (row.processPath === null && row.processName !== null && windowsSystemProcesses.has(row.processName.toLowerCase())) {
    return { class: "essential", vendor: "microsoft", official: true, hidden: !exposed, evidence: ["protected Windows process, path unreadable (by name)"], whatBreaks: null, confidence: "rule" };
  }
  const result = classify("windows-service", row.processName ?? "", row.processPath, exposed);
  if (row.processPath === null) result.evidence.unshift("program path unreadable");
  return result;
}
