import { compareVersions, type DependencyAdapter, type DependencyFact, type DependencyResult, type DependencySource, type ProbeOutputs } from "@scout/core";
import { NPM_GLOBALS_SCRIPT, PYVENV_SCRIPT } from "./probes.ts";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const result = (origin: DependencySource, status: DependencyResult["status"], facts: DependencyFact[] = [], message?: string): DependencyResult => ({ origin, status, facts, ...(message === undefined ? {} : { message }) });

function load(outputs: ProbeOutputs, id: string): { value?: unknown; status?: "failed" | "skipped"; message?: string } {
  const probe = outputs[id];
  if (!probe) return { status: "failed", message: "probe output missing" };
  if (probe.exitCode !== 0) return { status: probe.exitCode === 127 || probe.exitCode === 9009 ? "skipped" : "failed", message: "dependency probe did not run" };
  try { return { value: JSON.parse(probe.stdout) }; }
  catch { return { status: "failed", message: "dependency output is not valid JSON" }; }
}

export const brewDepsAdapter: DependencyAdapter = {
  origin: "brew-deps",
  os: ["macos"],
  probes() {
    return [{ id: "brew-info", argv: ["brew", "info", "--json=v2", "--installed"], optional: true }];
  },
  parse(outputs) {
    const doc = load(outputs, "brew-info");
    if (doc.status) return result("brew-deps", doc.status, [], doc.message);
    if (!object(doc.value) || !Array.isArray(doc.value["formulae"])) return result("brew-deps", "failed", [], "Homebrew formulae could not be read");
    const facts: DependencyFact[] = [];
    let partial = false;
    for (const formula of doc.value["formulae"]) {
      if (!object(formula) || typeof formula["name"] !== "string" || !Array.isArray(formula["installed"])) { partial = true; continue; }
      let newest: Record<string, unknown> | undefined;
      for (const keg of formula["installed"]) {
        if (!object(keg) || typeof keg["version"] !== "string") { partial = true; continue; }
        if (!newest || compareVersions(keg["version"], newest["version"] as string) === 1) newest = keg;
      }
      if (!newest) continue;
      const dependencies = newest["runtime_dependencies"];
      if (!Array.isArray(dependencies)) { partial = true; continue; }
      const seen = new Set<string>();
      for (const dependency of dependencies) {
        if (!object(dependency) || typeof dependency["full_name"] !== "string" || typeof dependency["version"] !== "string") { partial = true; continue; }
        const key = dependency["full_name"].split("/").at(-1)!;
        if (key === "" || seen.has(key)) continue;
        seen.add(key);
        facts.push({ from: { ecosystem: "brew", key: formula["name"] }, to: { ecosystem: "brew", key }, kind: "library", constraint: null, builtAgainst: dependency["version"], evidence: "Homebrew installed keg runtime dependency" });
      }
    }
    return result("brew-deps", partial ? "partial" : "ok", facts, partial ? "some Homebrew dependencies could not be read" : undefined);
  },
};

export const npmEnginesAdapter: DependencyAdapter = {
  origin: "npm-engines",
  os: ["macos", "windows", "linux"],
  probes() {
    return [{ id: "npm-globals", argv: ["node", "-"], stdin: NPM_GLOBALS_SCRIPT, optional: true }];
  },
  parse(outputs) {
    const doc = load(outputs, "npm-globals");
    if (doc.status) return result("npm-engines", doc.status, [], doc.message);
    if (!object(doc.value) || typeof doc.value["node"] !== "string" || !Array.isArray(doc.value["packages"])) return result("npm-engines", "failed", [], "global npm packages could not be read");
    const facts: DependencyFact[] = [];
    let partial = false;
    for (const pkg of doc.value["packages"]) {
      if (!object(pkg) || typeof pkg["name"] !== "string") { partial = true; continue; }
      const engines = pkg["engines"];
      if (engines === undefined || engines === null) continue;
      if (!object(engines)) { partial = true; continue; }
      const range = engines["node"];
      if (range === undefined) continue;
      if (typeof range !== "string") { partial = true; continue; }
      facts.push({ from: { ecosystem: "npm", key: pkg["name"] }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint: range, builtAgainst: doc.value["node"], evidence: "Global package engines.node" });
    }
    return result("npm-engines", partial ? "partial" : "ok", facts, partial ? "some npm requirements could not be read" : undefined);
  },
};

function cfgVersion(cfg: string): string | null {
  const values = new Map<string, string>();
  for (const line of cfg.split(/\r?\n/)) {
    const match = /^\s*(version|version_info)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const version = values.get("version") ?? values.get("version_info");
  return version && /^\d+\.\d+\.\d+(?:[A-Za-z0-9.+-]*)$/.test(version) ? version : null;
}

export const pyvenvAdapter: DependencyAdapter = {
  origin: "pyvenv",
  os: ["macos", "windows", "linux"],
  probes() {
    return [
      { id: "pipx-list", argv: ["pipx", "list", "--json"], optional: true },
      { id: "uv-tool-list", argv: ["uv", "tool", "list"], optional: true },
      { id: "pyvenv-cfg", argv: ["node", "-"], stdin: PYVENV_SCRIPT, optional: true },
    ];
  },
  parse(outputs) {
    const cfgProbe = outputs["pyvenv-cfg"];
    if (!cfgProbe || cfgProbe.exitCode !== 0) return result("pyvenv", cfgProbe?.exitCode === 127 ? "skipped" : "failed", [], "Python environment configs could not be read");
    const tools = new Map<string, Set<string>>([["pipx", new Set()], ["uv-tool", new Set()]]);
    let partial = false;
    let readable = 0;
    const pipx = load(outputs, "pipx-list");
    if (!pipx.status && object(pipx.value) && object(pipx.value["venvs"])) {
      readable++;
      for (const name of Object.keys(pipx.value["venvs"])) tools.get("pipx")!.add(name);
    } else if (pipx.status !== "skipped") partial = true;
    const uv = outputs["uv-tool-list"];
    if (uv?.exitCode === 0) {
      readable++;
      for (const line of uv.stdout.split(/\r?\n/)) {
        if (line.trim() === "" || /^\s*- /.test(line) || line.trim() === "No tools installed") continue;
        const match = /^(\S+) v\S+(?:\s.*)?$/.exec(line);
        if (match) tools.get("uv-tool")!.add(match[1]!);
        else partial = true;
      }
    } else if (!uv || ![127, 9009].includes(uv.exitCode)) partial = true;
    if (readable === 0) return result("pyvenv", partial ? "failed" : "skipped", [], "Python tool lists could not be read");
    const configs: { ecosystem: string; key: string; cfg: string }[] = [];
    const text = cfgProbe.stdout.trim();
    if (text.startsWith("{")) {
      let doc: unknown;
      try { doc = JSON.parse(text); } catch { return result("pyvenv", "failed", [], "Python environment output is not valid JSON"); }
      if (!object(doc) || !Array.isArray(doc["venvs"])) return result("pyvenv", "failed", [], "Python environment output could not be read");
      if (Array.isArray(doc["errors"]) && doc["errors"].length > 0) partial = true;
      if (Array.isArray(doc["unavailable"]) && doc["unavailable"].some((ecosystem) => typeof ecosystem === "string" && (tools.get(ecosystem)?.size ?? 0) > 0)) partial = true;
      for (const entry of doc["venvs"]) {
        if (!object(entry) || typeof entry["ecosystem"] !== "string" || typeof entry["key"] !== "string" || typeof entry["cfg"] !== "string") { partial = true; continue; }
        configs.push({ ecosystem: entry["ecosystem"], key: entry["key"], cfg: entry["cfg"] });
      }
    } else {
      let current: { key: string; cfg: string } | undefined;
      const sections: { key: string; cfg: string }[] = [];
      for (const line of cfgProbe.stdout.split(/\r?\n/)) {
        const header = /^== (\S+)\s*$/.exec(line);
        if (header) { current = { key: header[1]!, cfg: "" }; sections.push(current); }
        else if (current) current.cfg += `${line}\n`;
        else if (line.trim() !== "") partial = true;
      }
      for (const section of sections) {
        const ecosystems = [...tools].filter(([, names]) => names.has(section.key)).map(([ecosystem]) => ecosystem);
        // The old text recording lacks ecosystem labels, so duplicate tool names cannot establish ownership.
        if (ecosystems.length !== 1) { partial = true; continue; }
        configs.push({ ecosystem: ecosystems[0]!, ...section });
      }
    }
    const facts: DependencyFact[] = [];
    const seen = new Set<string>();
    for (const entry of configs) {
      if (!tools.get(entry.ecosystem)?.has(entry.key)) continue;
      const version = cfgVersion(entry.cfg);
      if (!version) { partial = true; continue; }
      const identity = JSON.stringify([entry.ecosystem, entry.key]);
      if (seen.has(identity)) { partial = true; continue; }
      seen.add(identity);
      const minor = version.split(".").slice(0, 2).join(".");
      facts.push({ from: { ecosystem: entry.ecosystem, key: entry.key }, to: { ecosystem: "runtime", key: "python" }, kind: "runtime", constraint: `==${minor}.*`, builtAgainst: version, evidence: "Tool pyvenv.cfg Python minor line" });
    }
    for (const [ecosystem, names] of tools) for (const name of names) if (!seen.has(JSON.stringify([ecosystem, name]))) partial = true;
    return result("pyvenv", partial ? "partial" : "ok", facts, partial ? "some Python environments could not be read" : undefined);
  },
};
export { wingetDepsAdapter, WINGET_DEPS_SCRIPT } from "./winget.ts";
