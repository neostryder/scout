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
  const applePath = appleDirectories.some((directory) => path.startsWith(directory));
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

export function classifyListener(row: Listener, serviceFacts: (ServiceFact & { machineId?: string })[] = []): Classification {
  if (row.containerName !== null) {
    return { class: "third-party", vendor: "other", official: false, hidden: false, evidence: ["container listener"], whatBreaks: null, confidence: "rule" };
  }
  const samePath = (path: string | null): boolean => {
    if (row.processPath === null || path === null) return false;
    const windows = /^[a-z]:[\\/]/i.test(row.processPath);
    return windows ? row.processPath.toLowerCase() === path.toLowerCase() : row.processPath === path;
  };
  const sameMachine = (fact: ServiceFact & { machineId?: string }): boolean => fact.machineId === undefined || fact.machineId === row.machineId;
  const service = serviceFacts.find((fact) => sameMachine(fact) && row.pid !== null && fact.pid === row.pid) ?? serviceFacts.find((fact) => sameMachine(fact) && fact.pid === null && samePath(fact.program));
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
