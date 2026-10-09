import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { assessUpdate, compareVersions, openCatalog, recordDependencies, recordScan, upsertMachine, type ProbeOutputs } from "@scout/core";
import { brewDepsAdapter, npmEnginesAdapter, pyvenvAdapter } from "../src/index.ts";
import { NPM_GLOBALS_SCRIPT, PYVENV_SCRIPT } from "../src/probes.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../../fixtures/deps/${name}`, import.meta.url), "utf8");
const output = (stdout: string, exitCode = 0) => ({ stdout, exitCode, stderr: "" });
const cfgOutputs = (cfg = fixture("pyvenv-cfg-hub.txt")): ProbeOutputs => ({
  "pipx-list": output(fixture("pipx-list-hub.json")),
  "uv-tool-list": output(fixture("uv-tool-list-hub.txt")),
  "pyvenv-cfg": output(cfg),
});

interface BrewRecording {
  formulae: { name: string; installed: { version: string; runtime_dependencies: { full_name: string; version: string }[] }[] }[];
}

interface NpmRecording {
  node: string;
  root: string;
  packages: { name: string; engines: { node?: string } | null }[];
}

for (const machine of ["mini", "server"]) {
  test(`brew-deps reads the newest kegs in the ${machine} recording and matches the dependency cross-check`, () => {
    const parsed = brewDepsAdapter.parse({ "brew-info": output(fixture(`brew-info-${machine}.json`)) });
    assert.equal(parsed.status, "ok");
    const crossCheck = fixture(`brew-deps-${machine}.txt`).trim().split(/\r?\n/).flatMap((line) => {
      const [name, dependencies] = line.split(":");
      return dependencies!.trim().split(/\s+/).filter(Boolean).map((dependency) => `${name}:${dependency}`);
    }).sort();
    const pairs = parsed.facts.map((fact) => `${fact.from.key}:${fact.to.key}`).sort();
    assert.deepEqual(crossCheck.filter((pair) => !pairs.includes(pair)), []);
    if (machine === "server") assert.deepEqual(pairs, crossCheck);
    else {
      assert.equal(pairs.length, 327);
      assert.equal(crossCheck.length, 238);
    }
    const doc = JSON.parse(fixture(`brew-info-${machine}.json`)) as BrewRecording;
    for (const formula of doc.formulae) {
      const newest = [...formula.installed].sort((a, b) => compareVersions(b.version, a.version) ?? 0)[0];
      assert.deepEqual(parsed.facts.filter((fact) => fact.from.key === formula.name).map((fact) => [fact.to.key, fact.builtAgainst]), newest!.runtime_dependencies.map((dependency) => [dependency.full_name, dependency.version]));
    }
    assert.ok(parsed.facts.every((fact) => fact.kind === "library" && fact.constraint === null && fact.evidence === "Homebrew installed keg runtime dependency"));
  });
}

test("brew-deps uses node's newest keg even when the older keg appears last", () => {
  const doc = JSON.parse(fixture("brew-info-mini.json")) as BrewRecording;
  const node = doc.formulae.find((formula) => formula.name === "node")!;
  node.installed.reverse();
  const facts = brewDepsAdapter.parse({ "brew-info": output(JSON.stringify({ formulae: [node] })) }).facts;
  assert.equal(facts.find((fact) => fact.to.key === "llhttp")!.builtAgainst, "9.4.3");
  assert.equal(facts.find((fact) => fact.to.key === "fmt")!.builtAgainst, "12.2.0");
  assert.ok(facts.some((fact) => fact.to.key === "openssl@3"));
  assert.ok(!facts.some((fact) => fact.to.key === "libnghttp3"));
});

test("brew-deps accepts a formula without dependencies and skips malformed entries", () => {
  const doc = { formulae: [
    { name: "empty", installed: [{ version: "1.0.0", runtime_dependencies: [] }] },
    { name: "new", installed: [] },
  ] };
  assert.deepEqual(brewDepsAdapter.parse({ "brew-info": output(JSON.stringify(doc)) }), { origin: "brew-deps", status: "ok", facts: [] });
  assert.equal(brewDepsAdapter.parse({ "brew-info": output(JSON.stringify({ formulae: [null, { name: "bad", installed: [null] }] })) }).status, "partial");
});

for (const machine of ["mini", "hub", "server"]) {
  test(`npm-engines reads all engine ranges from the ${machine} recording`, () => {
    const doc = JSON.parse(fixture(`npm-globals-${machine}.json`)) as NpmRecording;
    const parsed = npmEnginesAdapter.parse({ "npm-globals": output(JSON.stringify(doc)) });
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.facts, doc.packages.filter((pkg) => pkg.engines?.node).map((pkg) => ({
      from: { ecosystem: "npm", key: pkg.name }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint: pkg.engines!.node, builtAgainst: doc.node, evidence: "Global package engines.node",
    })));
    assert.ok(!JSON.stringify(parsed).includes(doc.root));
  });
}

test("npm-engines accepts missing engines and peer requirements alone do not create a runtime edge", () => {
  assert.deepEqual(npmEnginesAdapter.parse({ "npm-globals": output(JSON.stringify({ node: "v26.8.1", packages: [
    { name: "empty" }, { name: "peer", engines: null, peerDependencies: { node: ">=20" } }, { name: "other", engines: { npm: ">=10" } },
  ] })) }), { origin: "npm-engines", status: "ok", facts: [] });
  assert.equal(npmEnginesAdapter.parse({ "npm-globals": output(JSON.stringify({ node: "v26.8.1", packages: [null, { name: "bad", engines: { node: 20 } }] })) }).status, "partial");
});

test("pyvenv reads the Hub tool lists and Windows cfg recordings without retaining paths", () => {
  assert.deepEqual(pyvenvAdapter.parse(cfgOutputs()), { origin: "pyvenv", status: "ok", facts: [
    { from: { ecosystem: "uv-tool", key: "lh-harness" }, to: { ecosystem: "runtime", key: "python" }, kind: "runtime", constraint: "==3.13.*", builtAgainst: "3.13.11", evidence: "Tool pyvenv.cfg Python minor line" },
    { from: { ecosystem: "pipx", key: "httpie" }, to: { ecosystem: "runtime", key: "python" }, kind: "runtime", constraint: "==3.14.*", builtAgainst: "3.14.3", evidence: "Tool pyvenv.cfg Python minor line" },
  ] });
});

test("pyvenv accepts an empty list and marks missing or malformed cfgs partial", () => {
  assert.deepEqual(pyvenvAdapter.parse({ "pipx-list": output('{"venvs":{}}'), "uv-tool-list": output(""), "pyvenv-cfg": output("") }), { origin: "pyvenv", status: "ok", facts: [] });
  assert.equal(pyvenvAdapter.parse(cfgOutputs("== httpie\nversion = invalid\n")).status, "partial");
  assert.equal(pyvenvAdapter.parse(cfgOutputs("")).status, "partial");
});

test("pyvenv reads the JSON probe format and matches tools to their owning ecosystem", () => {
  const parsed = pyvenvAdapter.parse(cfgOutputs(JSON.stringify({ venvs: [
    { ecosystem: "pipx", key: "httpie", cfg: "home = C:/Tools/Python\r\nversion = 3.14.3\r\n" },
    { ecosystem: "uv-tool", key: "lh-harness", cfg: "version_info = 3.13.11\n" },
  ], unavailable: [], errors: [] })));
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.facts.map((fact) => [fact.from.ecosystem, fact.constraint]), [["pipx", "==3.14.*"], ["uv-tool", "==3.13.*"]]);
});

test("pyvenv does not guess an ecosystem for duplicate tool names in the text recording", () => {
  const parsed = pyvenvAdapter.parse({ "pipx-list": output('{"venvs":{"same":{}}}'), "uv-tool-list": output("same v1.0.0\n- same\n"), "pyvenv-cfg": output("== same\nversion = 3.14.3\n") });
  assert.equal(parsed.status, "partial");
  assert.deepEqual(parsed.facts, []);
});

for (const [adapter, probe] of [[brewDepsAdapter, "brew-info"], [npmEnginesAdapter, "npm-globals"]] as const) {
  test(`${adapter.origin} returns statuses for missing tools, malformed JSON and invalid documents`, () => {
    assert.equal(adapter.parse({}).status, "failed");
    assert.equal(adapter.parse({ [probe]: output("", 127) }).status, "skipped");
    assert.equal(adapter.parse({ [probe]: output("", 1) }).status, "failed");
    for (const text of ["{", "null", "[]", "42", '"text"', "{}"]) assert.equal(adapter.parse({ [probe]: output(text) }).status, "failed");
  });
}

test("pyvenv returns statuses for missing tools and malformed JSON", () => {
  assert.equal(pyvenvAdapter.parse({}).status, "failed");
  assert.equal(pyvenvAdapter.parse({ "pyvenv-cfg": output("", 127) }).status, "skipped");
  assert.equal(pyvenvAdapter.parse(cfgOutputs("{")).status, "failed");
  assert.equal(pyvenvAdapter.parse({ ...cfgOutputs(), "pipx-list": output("{") }).status, "partial");
  assert.equal(pyvenvAdapter.parse({ "pipx-list": output("", 127), "uv-tool-list": output("", 127), "pyvenv-cfg": output("") }).status, "skipped");
});

test("dependency adapters name fixed probes on every declared platform", () => {
  for (const adapter of [brewDepsAdapter, npmEnginesAdapter, pyvenvAdapter]) {
    for (const os of adapter.os) {
      const probes = adapter.probes({ machineId: "test", os, roots: {} });
      assert.deepEqual(probes, adapter.probes({ machineId: "other", os, roots: { unexpected: ["C:/untrusted"] } }));
    }
  }
  assert.deepEqual(brewDepsAdapter.probes({ machineId: "test", os: "macos", roots: {} })[0]!.argv, ["brew", "info", "--json=v2", "--installed"]);
  assert.deepEqual(npmEnginesAdapter.probes({ machineId: "test", os: "windows", roots: {} })[0]!.argv, ["node", "-"]);
  assert.deepEqual(pyvenvAdapter.probes({ machineId: "test", os: "windows", roots: {} }).map((probe) => probe.argv), [["pipx", "list", "--json"], ["uv", "tool", "list"], ["node", "-"]]);
});

test("the npm probe retains the committed script with the required hidden-window option", () => {
  assert.equal(NPM_GLOBALS_SCRIPT, fixture("npm-globals-script.mjs").replace(/\r\n/g, "\n").replace('shell: process.platform === "win32"', 'shell: process.platform === "win32", windowsHide: true'));
});

function runScript(script: string, bindings: Record<string, unknown>): unknown {
  let printed = "";
  runInNewContext(script.replace(/^import .*;\r?\n/gm, ""), { ...bindings, console: { log(text: string) { printed = text; } } });
  return JSON.parse(printed);
}

test("the npm probe reads scoped packages with injected filesystem and subprocess functions", () => {
  const doc = runScript(NPM_GLOBALS_SCRIPT, {
    process: { platform: "win32", version: "v26.8.1" },
    execFileSync(command: string, args: string[], options: { windowsHide: boolean }) {
      assert.equal(command, "npm");
      assert.deepEqual(Array.from(args), ["root", "-g"]);
      assert.equal(options.windowsHide, true);
      return "C:/tools/node_modules\n";
    },
    readdirSync(path: string) { return path.endsWith("@scope") ? ["tool"] : ["@scope", "empty", "skip"]; },
    existsSync(path: string) { return !path.includes("/skip/"); },
    readFileSync(path: string) { return JSON.stringify({ name: path.includes("@scope") ? "@scope/tool" : "empty", version: "1.0.0", engines: path.includes("@scope") ? { node: ">=20" } : null }); },
  });
  const parsed = npmEnginesAdapter.parse({ "npm-globals": output(JSON.stringify(doc)) });
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0]!.from.key, "@scope/tool");
});

test("the pyvenv probe reads nested cfg files through injected functions and hides subprocess windows", () => {
  const files = new Map<string, string>([["C:/pipx/httpie/pyvenv.cfg", "version = 3.14.3\n"], ["C:/uv/lh-harness/pyvenv.cfg", "version_info = 3.13.11\n"]]);
  const doc = runScript(PYVENV_SCRIPT, {
    join: (...parts: string[]) => join(...parts).replaceAll("\\", "/"),
    execFileSync(command: string, args: string[], options: { windowsHide: boolean }) {
      assert.equal(options.windowsHide, true);
      assert.deepEqual(Array.from(args), command === "pipx" ? ["environment", "--value", "PIPX_LOCAL_VENVS"] : ["tool", "dir"]);
      return command === "pipx" ? "C:/pipx" : "C:/uv";
    },
    readdirSync(path: string) {
      const isRoot = ["C:/pipx", "C:/uv"].includes(path);
      return [{ name: isRoot ? path === "C:/pipx" ? "httpie" : "lh-harness" : "pyvenv.cfg", isDirectory: () => isRoot, isFile: () => !isRoot }];
    },
    readFileSync(path: string) { assert.ok(files.has(path)); return files.get(path); },
  });
  assert.equal(pyvenvAdapter.parse(cfgOutputs(JSON.stringify(doc))).status, "ok");
  assert.equal(pyvenvAdapter.parse(cfgOutputs(JSON.stringify(doc))).facts.length, 2);
});

test("the pyvenv probe distinguishes unavailable commands from read failures with injected errors", () => {
  const doc = runScript(PYVENV_SCRIPT, {
    execFileSync(command: string) { throw Object.assign(new Error("test failure"), { code: command === "pipx" ? "ENOENT" : "EACCES" }); },
  });
  assert.deepEqual(doc, { venvs: [], unavailable: ["pipx"], errors: ["uv-tool"] });
});

test("fixture facts drive library, Node and Python update assessment in an in-memory catalog", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const T = "2026-09-30T12:00:00Z";
  upsertMachine(db, { id: "test", name: "test", os: "windows", kind: "host" });
  const brew = brewDepsAdapter.parse({ "brew-info": output(fixture("brew-info-mini.json")) });
  const npm = npmEnginesAdapter.parse({ "npm-globals": output(fixture("npm-globals-hub.json")) });
  const py = pyvenvAdapter.parse(cfgOutputs());
  const npmFact = npm.facts.find((fact) => fact.constraint === ">=22.19 <23 || >=24 <27")!;
  recordScan(db, "test", { sourceKind: "test", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "node", name: "node", kind: "package", version: "26.8.1", location: "" },
    { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
    { ecosystem: "npm", key: npmFact.from.key, name: "Global tool", kind: "package", version: "1", location: "" },
    { ecosystem: "pipx", key: "httpie", name: "httpie", kind: "package", version: "3.2.4", location: "" },
    { ecosystem: "python", key: "3.14", name: "Python 3.14", kind: "runtime", version: "3.14.3", location: "" },
  ] }, T);
  for (const parsed of [brew, npm, py]) recordDependencies(db, "test", parsed, T);
  const id = (ecosystem: string, key: string): number => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.ecosystem = ? AND p.key = ?").get(ecosystem, key) as { id: number }).id;
  assert.equal(assessUpdate(db, id("brew", "llhttp"), "9.5.0").soft[0]!.dependent.key, "node");
  assert.deepEqual(assessUpdate(db, id("brew", "llhttp"), "9.5.0", { alsoUpdating: [id("brew", "node")] }), { hard: [], soft: [] });
  assert.equal(assessUpdate(db, id("brew", "node"), "27.0.0").hard.length, 1);
  assert.equal(assessUpdate(db, id("brew", "node"), "26.9.0").hard.length, 0);
  assert.equal(assessUpdate(db, id("python", "3.14"), "3.14.5").hard.length, 0);
  assert.equal(assessUpdate(db, id("python", "3.14"), "3.15.0").hard[0]!.dependent.key, "httpie");
});
