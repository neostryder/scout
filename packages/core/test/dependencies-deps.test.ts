import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { assessUpdate, dependentsOf, needsOf, openCatalog, recordDependencies, recordScan, upsertMachine, type Db, type DependencyFact, type DependencyResult } from "../src/index.ts";

const T = "2026-09-30T12:00:00Z";

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (const machine of ["mini", "hub"]) {
    upsertMachine(db, { id: machine, name: machine, os: machine === "hub" ? "windows" : "macos", kind: "host" });
    recordScan(db, machine, { sourceKind: "test", location: "", status: "ok", installs: [
      { ecosystem: "brew", key: "node", name: "node", kind: "package", version: "26.10.0", location: "" },
      { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
      { ecosystem: "npm", key: "global-tool", name: "global-tool", kind: "package", version: "1", location: "" },
      { ecosystem: "pipx", key: "httpie", name: "httpie", kind: "package", version: "3.2.4", location: "" },
      { ecosystem: "python", key: "3.13", name: "Python 3.13", kind: "runtime", version: "3.13.11", location: "" },
      { ecosystem: "python", key: "3.14", name: "Python 3.14", kind: "runtime", version: "3.14.3", location: "" },
    ] }, T);
  }
  return db;
}

function id(db: Db, ecosystem: string, key: string, machine = "mini"): number {
  return (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.ecosystem = ? AND p.key = ? AND i.machine_id = ? AND i.removed_at IS NULL").get(ecosystem, key, machine) as { id: number }).id;
}

const library: DependencyFact = { from: { ecosystem: "brew", key: "node" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "Homebrew installed keg runtime dependency" };
const runtime: DependencyFact = { from: { ecosystem: "npm", key: "global-tool" }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint: ">=22.19 <23 || >=24 <27", builtAgainst: "v26.10.0", evidence: "Global package engines.node" };
const python: DependencyFact = { from: { ecosystem: "pipx", key: "httpie" }, to: { ecosystem: "runtime", key: "python" }, kind: "runtime", constraint: "==3.14.*", builtAgainst: "3.14.3", evidence: "Tool pyvenv.cfg Python minor line" };
const result = (origin: DependencyResult["origin"], facts: DependencyFact[], status: DependencyResult["status"] = "ok"): DependencyResult => ({ origin, status, facts });

test("dependency storage replaces only the result's source on its machine and counts skipped facts", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("brew-deps", [library]), T);
  recordDependencies(db, "hub", result("brew-deps", [library]), T);
  recordDependencies(db, "mini", result("npm-engines", [runtime]), T);
  const missing = { ...library, from: { ecosystem: "brew", key: "missing" } };
  assert.deepEqual(recordDependencies(db, "mini", result("brew-deps", [library, library, missing]), T), { edges: 1, skipped: 1 });
  recordDependencies(db, "mini", result("brew-deps", []), T);
  assert.equal(needsOf(db, id(db, "brew", "node")).length, 0);
  assert.equal(needsOf(db, id(db, "npm", "global-tool")).length, 1);
  assert.equal(needsOf(db, id(db, "brew", "node", "hub")).length, 1);
});

test("failed and skipped results preserve edges and a partial result replaces its source", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("brew-deps", [library]), T);
  const original = needsOf(db, id(db, "brew", "node"));
  for (const status of ["failed", "skipped"] as const) {
    assert.deepEqual(recordDependencies(db, "mini", result("brew-deps", [], status), T), { edges: 0, skipped: 0 });
    assert.deepEqual(needsOf(db, id(db, "brew", "node")), original);
  }
  recordDependencies(db, "mini", result("brew-deps", [], "partial"), T);
  assert.deepEqual(needsOf(db, id(db, "brew", "node")), []);
});

test("dependency storage retains missing targets and ignores removed dependent installs", (t) => {
  const db = seed(t);
  const nodeId = id(db, "brew", "node");
  assert.deepEqual(recordDependencies(db, "mini", result("brew-deps", [{ ...library, to: { ecosystem: "brew", key: "missing", name: "Missing library" } }]), T), { edges: 1, skipped: 0 });
  const need = needsOf(db, nodeId)[0]!;
  assert.deepEqual(need.to, { id: null, ecosystem: "brew", key: "missing", name: "Missing library", version: null });
  db.prepare("UPDATE installs SET removed_at = ? WHERE id = ?").run(T, nodeId);
  assert.deepEqual(recordDependencies(db, "mini", result("brew-deps", [library]), T), { edges: 0, skipped: 1 });
});

test("dependency storage rolls back the replacement when inserting an edge fails", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("brew-deps", [library]), T);
  const original = needsOf(db, id(db, "brew", "node"));
  db.exec("CREATE TRIGGER reject_dependency BEFORE INSERT ON dependency_edges BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
  assert.throws(() => recordDependencies(db, "mini", result("brew-deps", [library]), T), /test rejection/);
  assert.deepEqual(needsOf(db, id(db, "brew", "node")), original);
});

test("dependency readers return JSON objects with constraints and current target versions", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("npm-engines", [runtime]), T);
  const dependent = dependentsOf(db, id(db, "brew", "node"))[0]!;
  assert.deepEqual(dependent, needsOf(db, id(db, "npm", "global-tool"))[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(dependent)), dependent);
  assert.equal(dependent.from.machine, "mini");
  assert.equal(dependent.to.version, "26.10.0");
  assert.equal(dependent.constraint, runtime.constraint);
  assert.equal(dependent.builtAgainst, "v26.10.0");
  assert.equal(dependent.observedAt, T);
  db.prepare("UPDATE installs SET removed_at = ? WHERE id = ?").run(T, dependent.from.id);
  assert.deepEqual(dependentsOf(db, id(db, "brew", "node")), []);
});

for (const [ecosystem, key, name] of [["brew", "node", "node"], ["winget", "OpenJS.NodeJS", "Node.js"], ["winget", "OpenJS.NodeJS.LTS", "Node.js"], ["binary", "nodejs", "nodejs"], ["binary", "custom-node", "Node.js"]]) {
  test(`runtime node resolves the ${ecosystem} install ${key}`, (t) => {
    const db = seed(t);
    db.prepare("UPDATE installs SET removed_at = ? WHERE machine_id = 'mini' AND package_id IN (SELECT id FROM packages WHERE ecosystem = 'brew' AND key = 'node')").run(T);
    recordScan(db, "mini", { sourceKind: "runtime", location: "", status: "ok", installs: [{ ecosystem: ecosystem!, key: key!, name: name!, kind: "runtime", version: "26.10.0", location: "" }] }, T);
    recordDependencies(db, "mini", result("npm-engines", [runtime]), T);
    assert.equal(needsOf(db, id(db, "npm", "global-tool"))[0]!.to.id, id(db, ecosystem!, key!));
  });
}

test("runtime node chooses the observed version and rejects an unrelated ecosystem", (t) => {
  const db = seed(t);
  recordScan(db, "mini", { sourceKind: "binary", location: "", status: "ok", installs: [
    { ecosystem: "binary", key: "nodejs", name: "Node.js", kind: "runtime", version: "22.23.2", location: "" },
    { ecosystem: "npm", key: "nodejs", name: "node", kind: "package", version: "26.10.0", location: "" },
  ] }, T);
  recordDependencies(db, "mini", result("npm-engines", [{ ...runtime, builtAgainst: "v22.23.2" }]), T);
  assert.equal(needsOf(db, id(db, "npm", "global-tool"))[0]!.to.id, id(db, "binary", "nodejs"));
  db.prepare("UPDATE installs SET removed_at = ? WHERE machine_id = 'mini' AND package_id IN (SELECT id FROM packages WHERE ecosystem IN ('binary', 'brew'))").run(T);
  recordDependencies(db, "mini", result("npm-engines", [runtime]), T);
  assert.equal(needsOf(db, id(db, "npm", "global-tool"))[0]!.to.id, null);
});

test("Python runtime resolution follows the built minor line and keeps an absent line unbound", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("pyvenv", [python]), T);
  assert.equal(needsOf(db, id(db, "pipx", "httpie"))[0]!.to.id, id(db, "python", "3.14"));
  recordDependencies(db, "mini", result("pyvenv", [{ ...python, builtAgainst: "3.15.0", constraint: "==3.15.*" }]), T);
  assert.equal(needsOf(db, id(db, "pipx", "httpie"))[0]!.to.id, null);
});

test("llhttp changes put node at risk unless node moves in the same plan and packaging revisions do not break it", (t) => {
  const db = seed(t);
  const llhttpId = id(db, "brew", "llhttp");
  const nodeId = id(db, "brew", "node");
  recordDependencies(db, "mini", result("brew-deps", [library]), T);
  const broken = assessUpdate(db, llhttpId, "9.5.0");
  assert.equal(broken.hard.length, 0);
  assert.equal(broken.soft.length, 1);
  assert.equal(broken.soft[0]!.dependent.id, nodeId);
  assert.match(broken.soft[0]!.reason, /node.*llhttp 9.4.3.*9.5.0/);
  assert.deepEqual(assessUpdate(db, llhttpId, "9.5.0", { alsoUpdating: [nodeId] }), { hard: [], soft: [] });
  assert.deepEqual(assessUpdate(db, llhttpId, "9.4.3_1"), { hard: [], soft: [] });
  recordDependencies(db, "mini", result("brew-deps", [{ ...library, builtAgainst: "9.4.3_1" }]), T);
  assert.deepEqual(assessUpdate(db, llhttpId, "9.4.3_2"), { hard: [], soft: [] });
});

test("global npm requirements accept Node 26.9.0 and reject Node 27.0.0", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("npm-engines", [runtime]), T);
  assert.deepEqual(assessUpdate(db, id(db, "brew", "node"), "26.9.0"), { hard: [], soft: [] });
  const broken = assessUpdate(db, id(db, "brew", "node"), "27.0.0");
  assert.equal(broken.hard[0]!.dependent.key, "global-tool");
  assert.equal(broken.hard[0]!.constraint, runtime.constraint);
  assert.deepEqual(broken.soft, []);
});

test("Python venv requirements accept a patch update and reject a minor update", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("pyvenv", [python]), T);
  assert.deepEqual(assessUpdate(db, id(db, "python", "3.14"), "3.14.5"), { hard: [], soft: [] });
  assert.equal(assessUpdate(db, id(db, "python", "3.14"), "3.15.0").hard[0]!.dependent.key, "httpie");
});

test("unreadable requirements produce a soft break and assessment never writes to the catalog", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("npm-engines", [{ ...runtime, constraint: "broken range" }]), T);
  const before = db.prepare("SELECT * FROM dependency_edges").all();
  const broken = assessUpdate(db, id(db, "brew", "node"), "27.0.0");
  assert.equal(broken.soft[0]!.reason, "the range could not be read");
  assert.deepEqual(broken.hard, []);
  assert.deepEqual(db.prepare("SELECT * FROM dependency_edges").all(), before);
  assert.deepEqual(assessUpdate(db, id(db, "brew", "llhttp"), "10.0.0"), { hard: [], soft: [] });
});

test("dependency evidence redacts usernames from home paths", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("brew-deps", [{ ...library, evidence: "Recorded at C:/Users/First Last/tool and /Users/person/lib" }]), T);
  assert.equal(needsOf(db, id(db, "brew", "node"))[0]!.evidence, "Recorded at ~/tool and ~/lib");
});

test("dependency needs retain target identity after the target install is removed", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("brew-deps", [library]), T);
  const target = id(db, "brew", "llhttp");
  db.prepare("UPDATE installs SET removed_at = ? WHERE id = ?").run(T, target);
  assert.deepEqual(needsOf(db, id(db, "brew", "node"))[0]!.to, { id: null, ecosystem: "brew", key: "llhttp", name: "llhttp", version: null });
  assert.deepEqual(dependentsOf(db, target), []);
});

test("a library self-edge does not report a break and a runtime edge without a constraint does not block", (t) => {
  const db = seed(t);
  recordDependencies(db, "mini", result("brew-deps", [{ ...library, from: library.to }]), T);
  assert.deepEqual(assessUpdate(db, id(db, "brew", "llhttp"), "10.0.0"), { hard: [], soft: [] });
  recordDependencies(db, "mini", result("npm-engines", [{ ...runtime, constraint: null }]), T);
  assert.deepEqual(assessUpdate(db, id(db, "brew", "node"), "27.0.0"), { hard: [], soft: [] });
});
