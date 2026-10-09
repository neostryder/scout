import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryInput, confirmDependencyProposal, discoveryPrompt, openCatalog, parseDiscovery, recordDependencies, recordResearch, recordScan, rejectDependencyProposal, runDiscovery, upsertMachine, type Db, type DiscoveryProposal } from "../src/index.ts";

const T = "2026-09-30T12:00:00Z";
const proposal: DiscoveryProposal = { from: "npm:language-server", to: "brew:node", kind: "runtime", constraint: ">=26 <27", together: false, evidence: "The language server requires Node 26.", confidence: "high" };
const keys = [proposal.from, proposal.to, "brew:git", "cask:editor"];

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (const machine of ["host-a", "host-b", "host-c"]) {
    upsertMachine(db, { id: machine, name: `private-hostname-${machine}`, os: "windows", kind: "host", address: "192.0.2.123" });
    recordScan(db, machine, { sourceKind: "test", location: "C:/Users/alice-private/tools", status: "ok", installs: [
      { ecosystem: "brew", key: "node", name: "Node", kind: "runtime", version: "26.1.0", location: "C:/Users/alice-private/tools/node" },
      { ecosystem: "brew", key: "git", name: "Git", kind: "package", version: "2.1.0", location: "C:/Tools/git" },
      { ecosystem: "cask", key: "editor", name: "Editor", kind: "app", version: "1.0.0", location: "C:/Tools/editor" },
      ...(machine === "host-c" ? [] : [{ ecosystem: "npm", key: "language-server", name: "Language server", kind: "package" as const, version: "1.0.0", location: "C:/Repositories/private-project/bin/server" }]),
    ] }, T);
  }
  const node = (db.prepare("SELECT id FROM packages WHERE key = 'node'").get() as { id: number }).id;
  recordResearch(db, node, "brew-api", "ok", [{ channel: "stable", version: "26.2.0", installable: true }], null, T);
  const install = (db.prepare("SELECT id FROM installs WHERE machine_id = 'host-a' LIMIT 1").get() as { id: number }).id;
  db.prepare("INSERT INTO constraints (install_id, type, spec, origin, observed_at) VALUES (?, 'project_selector', '26', 'C:/Repositories/private-project/.node-version', ?)").run(install, T);
  return db;
}

function findings(db: Db, state = "open"): { id: number; subject_json: string; state: string }[] {
  return db.prepare("SELECT id, subject_json, state FROM findings WHERE kind = 'dependency_proposal' AND state = ? ORDER BY id").all(state) as { id: number; subject_json: string; state: string }[];
}

test("discovery input contains public identities, versions, machine counts and pending updates", (t) => {
  const input = buildDiscoveryInput(seed(t));
  assert.deepEqual([input.included, input.omitted], [4, 0]);
  const data = JSON.parse(input.text);
  assert.equal(data.packages.find((row: any) => row.id === "brew:node").machines, 3);
  assert.deepEqual(data.packages.find((row: any) => row.id === "brew:node").version, ["26.1.0"]);
  assert.deepEqual(data.pendingUpdates, [{ id: "brew:node", installed: "26.1.0", target: "26.2.0" }]);
  for (const privateText of ["alice-private", "private-project", "private-hostname", "host-a", "host-b", "host-c", "192.0.2.123", "C:/Users", "C:/Repositories"]) assert.ok(!input.text.includes(privateText), privateText);
  const prompt = discoveryPrompt(input);
  for (const instruction of ["strict JSON array", "Never invent a package", "knownEdges", "Return []", "public fact", "together"]) assert.ok(prompt.includes(instruction));
  assert.ok(prompt.endsWith(input.text));
});

test("discovery input omits private identities and values even when they occur in package fields", (t) => {
  const db = seed(t);
  db.prepare("UPDATE packages SET name = 'alice-private custom tool' WHERE key = 'editor'").run();
  db.prepare("UPDATE packages SET key = 'C:/Repositories/private-project/tool' WHERE key = 'git'").run();
  db.prepare("UPDATE installs SET version = 'private-hostname-host-a' WHERE package_id IN (SELECT id FROM packages WHERE key = 'language-server')").run();
  const input = buildDiscoveryInput(db);
  assert.deepEqual([input.included, input.omitted], [1, 3]);
  for (const value of ["alice-private", "private-project", "private-hostname"]) assert.ok(!input.text.includes(value));
  db.prepare("UPDATE constraints SET detail_json = ?").run(JSON.stringify({ project: "/work/custom-project" }));
  db.prepare("UPDATE packages SET name = 'custom-project tool' WHERE key = 'node'").run();
  assert.equal(buildDiscoveryInput(db).included, 0);
});

test("discovery input caps bytes and prioritizes updates, edges and readable use flags", (t) => {
  const db = seed(t);
  recordDependencies(db, "host-a", { origin: "brew-deps", status: "ok", facts: [{ from: { ecosystem: "cask", key: "editor" }, to: { ecosystem: "brew", key: "git" }, kind: "library", constraint: null, builtAgainst: null, evidence: "test" }] }, T);
  const install = (db.prepare("SELECT id FROM installs WHERE machine_id = 'host-a' AND package_id IN (SELECT id FROM packages WHERE key = 'language-server')").get() as { id: number }).id;
  const pkg = (db.prepare("SELECT package_id AS id FROM installs WHERE id = ?").get(install) as { id: number }).id;
  recordResearch(db, pkg, "npm", "ok", [{ channel: "stable", version: "1.0.0", installable: true }], null, T);
  db.prepare("INSERT INTO usage_signals (install_id, kind, value, origin, observed_at) VALUES (?, 'running', '1', 'test', ?)").run(install, T);
  const source = (db.prepare("SELECT source_id AS id FROM installs LIMIT 1").get() as { id: number }).id;
  const addPkg = db.prepare("INSERT INTO packages (ecosystem, key, name) VALUES ('npm', ?, ?)");
  const addInstall = db.prepare("INSERT INTO installs (machine_id, source_id, package_id, kind, version, first_seen, last_seen) VALUES ('host-a', ?, ?, 'package', '1.0.0', ?, ?)");
  for (let i = 0; i < 1600; i++) {
    const row = addPkg.run(`aaa-${i.toString().padStart(4, "0")}`, `Package ${i} ${"x".repeat(60)}`);
    addInstall.run(source, row.lastInsertRowid, T, T);
  }
  const input = buildDiscoveryInput(db);
  assert.ok(Buffer.byteLength(input.text) <= 60000);
  assert.ok(input.omitted > 0);
  assert.equal(input.included + input.omitted, 1604);
  const data = JSON.parse(input.text);
  assert.equal(data.omitted, input.omitted);
  const included = data.packages.map((row: any) => row.id);
  for (const key of keys) assert.ok(included.includes(key), key);
  assert.equal(included[3], "npm:language-server");
  assert.deepEqual(data.knownEdges, [{ from: "cask:editor", to: "brew:git", kind: "library", constraint: null }]);
});

test("discovery parser accepts an array, a fence and an empty answer", () => {
  for (const answer of [JSON.stringify([proposal]), `\n\u0060\u0060\u0060json\n${JSON.stringify([proposal])}\n\u0060\u0060\u0060\n`]) assert.deepEqual(parseDiscovery(answer, keys), { proposals: [proposal], rejected: 0 });
  assert.deepEqual(parseDiscovery("[]", keys), { proposals: [], rejected: 0 });
});

test("discovery parser rejects unknown identities, self edges, invalid types and excessive text", () => {
  const bad = [null, [], { ...proposal, from: "npm:unknown" }, { ...proposal, to: proposal.from }, { ...proposal, kind: "project" }, { ...proposal, kind: ["runtime"] }, { ...proposal, confidence: ["high"] }, { ...proposal, confidence: "certain" }, { ...proposal, constraint: "x".repeat(81) }, { ...proposal, constraint: 1 }, { ...proposal, evidence: "x".repeat(301) }, { ...proposal, evidence: "   " }, { ...proposal, together: "yes" }, { ...proposal, extra: true }];
  assert.deepEqual(parseDiscovery(JSON.stringify(bad), new Set(keys)), { proposals: [], rejected: bad.length });
  for (const answer of ["garbage", "{}", "null", "prefix []", "```json\n[]\n``` suffix"]) assert.deepEqual(parseDiscovery(answer, keys), { proposals: [], rejected: 1 });
});

test("discovery parser cleans punctuation and caps accepted entries at sixty", () => {
  const parsed = parseDiscovery(JSON.stringify([{ ...proposal, evidence: "Node\u2019s runtime \u2014 \u201ccompatible\u201d\u2026", constraint: "\u226525" }]), keys);
  assert.equal(parsed.proposals[0]?.evidence, 'Node\'s runtime - "compatible"...');
  assert.equal(parsed.proposals[0]?.constraint, ">=25");
  assert.ok(!/[^\x20-\x7e]/.test(parsed.proposals[0]!.constraint!));
  const capped = parseDiscovery(JSON.stringify(Array.from({ length: 65 }, () => proposal)), keys);
  assert.deepEqual([capped.proposals.length, capped.rejected], [60, 5]);
});

test("discovery calls one injected runner and stores only machines that share both packages", async (t) => {
  const db = seed(t);
  let calls = 0;
  const result = await runDiscovery(db, async (request) => {
    calls++;
    assert.equal(request.task, "dependency-discovery");
    assert.equal(request.dataClass, "internal");
    assert.ok(!request.prompt.includes("alice-private"));
    return JSON.stringify([proposal, proposal]);
  }, T);
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "ok", proposed: 1, skipped: 1, omitted: 0 });
  assert.equal(findings(db).length, 1);
  assert.deepEqual(JSON.parse(findings(db)[0]!.subject_json), { ...proposal, from: { ecosystem: "npm", key: "language-server" }, to: { ecosystem: "brew", key: "node" }, machines: ["host-a", "host-b"] });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dependency_edges").get() as { n: number }).n, 0);
});

test("discovery suppresses rejected and confirmed pairs regardless of changed evidence or constraint", async (t) => {
  const db = seed(t);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  rejectDependencyProposal(db, findings(db)[0]!.id);
  const result = await runDiscovery(db, async () => JSON.stringify([{ ...proposal, evidence: "Another fact.", constraint: null }]), T);
  assert.deepEqual([result.proposed, result.skipped, findings(db).length], [0, 1, 0]);
  assert.equal(findings(db, "rejected").length, 1);
  db.exec("UPDATE findings SET state = 'confirmed'");
  assert.equal((await runDiscovery(db, async () => JSON.stringify([proposal]), T)).proposed, 0);
});

test("discovery skips known edge pairs and packages that never share a machine", async (t) => {
  const db = seed(t);
  recordDependencies(db, "host-a", { origin: "npm-engines", status: "ok", facts: [{ from: { ecosystem: "npm", key: "language-server" }, to: { ecosystem: "brew", key: "node" }, kind: "runtime", constraint: ">=20", builtAgainst: null, evidence: "test" }] }, T);
  assert.equal((await runDiscovery(db, async () => JSON.stringify([proposal]), T)).skipped, 1);
  db.exec("DELETE FROM dependency_edges");
  db.prepare("UPDATE installs SET removed_at = ? WHERE package_id IN (SELECT id FROM packages WHERE key = 'node') AND machine_id != 'host-c'").run(T);
  assert.deepEqual(await runDiscovery(db, async () => JSON.stringify([proposal]), T), { status: "ok", proposed: 0, skipped: 1, omitted: 0 });
});

test("null and unusable discovery answers preserve the queue and valid empty answers clear it", async (t) => {
  const db = seed(t);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  const original = findings(db);
  assert.equal((await runDiscovery(db, async () => null, T)).status, "no_model");
  assert.deepEqual(findings(db), original);
  for (const answer of ["garbage", "{}", JSON.stringify([{ ...proposal, to: "brew:unknown" }])]) {
    assert.equal((await runDiscovery(db, async () => answer, T)).status, "unusable");
    assert.deepEqual(findings(db), original);
  }
  assert.equal((await runDiscovery(db, async () => "[]", T)).status, "ok");
  assert.deepEqual(findings(db), []);
});

test("a second discovery replaces open dependency proposals and preserves other findings", async (t) => {
  const db = seed(t);
  db.prepare("INSERT INTO findings (kind, subject_json, state, created_at) VALUES ('merge_proposal', '{}', 'open', ?)").run(T);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  await runDiscovery(db, async () => JSON.stringify([{ ...proposal, from: "cask:editor", to: "brew:git", kind: "library" }]), T);
  assert.equal(findings(db).length, 1);
  assert.equal(JSON.parse(findings(db)[0]!.subject_json).from.key, "editor");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM findings WHERE kind = 'merge_proposal'").get() as { n: number }).n, 1);
  const original = findings(db);
  db.exec("CREATE TRIGGER reject_discovery BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
  await assert.rejects(runDiscovery(db, async () => JSON.stringify([proposal]), T), /test rejection/);
  assert.deepEqual(findings(db), original);
});

test("confirmation inserts reviewed edges only on listed live machines and is idempotent", async (t) => {
  const db = seed(t);
  await runDiscovery(db, async () => JSON.stringify([{ ...proposal, together: true, constraint: null }]), T);
  const finding = findings(db)[0]!;
  confirmDependencyProposal(db, finding.id, T);
  const edges = db.prepare("SELECT machine_id, to_install_id, source, evidence, \"constraint\" FROM dependency_edges ORDER BY machine_id").all() as any[];
  assert.deepEqual(edges.map((edge) => edge.machine_id), ["host-a", "host-b"]);
  for (const edge of edges) {
    assert.ok(edge.to_install_id);
    assert.equal(edge.source, "ai-reviewed");
    assert.equal(edge.evidence, `reviewed: ${proposal.evidence}`);
    assert.equal(edge.constraint, "updates together");
  }
  confirmDependencyProposal(db, finding.id, "2026-10-01T00:00:00Z");
  rejectDependencyProposal(db, finding.id);
  assert.deepEqual(db.prepare("SELECT machine_id, to_install_id, source, evidence, \"constraint\" FROM dependency_edges ORDER BY machine_id").all(), edges);
  assert.equal(findings(db, "confirmed").length, 1);
});

test("confirmation ignores removed dependents and retains the identity of a removed target", async (t) => {
  const db = seed(t);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  const finding = findings(db)[0]!;
  db.prepare("UPDATE installs SET removed_at = ? WHERE machine_id = 'host-a' AND package_id IN (SELECT id FROM packages WHERE key = 'language-server')").run(T);
  db.prepare("UPDATE installs SET removed_at = ? WHERE machine_id = 'host-b' AND package_id IN (SELECT id FROM packages WHERE key = 'node')").run(T);
  confirmDependencyProposal(db, finding.id, T);
  const edges = db.prepare("SELECT machine_id, to_install_id, to_key FROM dependency_edges").all();
  assert.equal(edges.length, 1);
  assert.deepEqual({ ...edges[0] }, { machine_id: "host-b", to_install_id: null, to_key: "node" });
});

test("confirmation handles every live dependent copy and prefers a target from its source", async (t) => {
  const db = seed(t);
  recordScan(db, "host-a", { sourceKind: "other", location: "C:/Other", status: "ok", installs: [
    { ecosystem: "brew", key: "node", name: "Node", kind: "runtime", version: "26.1.0", location: "C:/Other/node" },
    { ecosystem: "npm", key: "language-server", name: "Language server", kind: "package", version: "1.0.0", location: "C:/Other/server" },
  ] }, T);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  confirmDependencyProposal(db, findings(db)[0]!.id, T);
  const copies = db.prepare("SELECT f.source_id AS fromSource, t.source_id AS toSource FROM dependency_edges e JOIN installs f ON f.id = e.from_install_id JOIN installs t ON t.id = e.to_install_id WHERE e.machine_id = 'host-a'").all() as { fromSource: number; toSource: number }[];
  assert.equal(copies.length, 2);
  for (const copy of copies) assert.equal(copy.fromSource, copy.toSource);
});

test("confirmation rolls back both edge writes and finding state when a later insert fails", async (t) => {
  const db = seed(t);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  db.exec("CREATE TRIGGER reject_reviewed BEFORE INSERT ON dependency_edges WHEN NEW.machine_id = 'host-b' BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
  const original = findings(db);
  assert.throws(() => confirmDependencyProposal(db, original[0]!.id, T), /test rejection/);
  assert.deepEqual(findings(db), original);
  assert.equal(db.prepare("SELECT id FROM dependency_edges").all().length, 0);
});

test("rejection is idempotent and rolls back a failed finding update", async (t) => {
  const db = seed(t);
  await runDiscovery(db, async () => JSON.stringify([proposal]), T);
  const finding = findings(db)[0]!;
  db.exec("CREATE TRIGGER reject_decision BEFORE UPDATE ON findings BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
  assert.throws(() => rejectDependencyProposal(db, finding.id), /test rejection/);
  assert.equal(findings(db).length, 1);
  db.exec("DROP TRIGGER reject_decision");
  rejectDependencyProposal(db, finding.id);
  rejectDependencyProposal(db, finding.id);
  confirmDependencyProposal(db, finding.id, T);
  assert.equal(findings(db, "rejected").length, 1);
  assert.equal(db.prepare("SELECT id FROM dependency_edges").all().length, 0);
  assert.throws(() => rejectDependencyProposal(db, 9999), /no dependency proposal/);
});
