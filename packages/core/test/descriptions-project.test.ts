import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectProjectText, findProjects, listProjectDescriptions, loadDescriptionResolver, loadProjectHints, openCatalog, PROJECT_DESCRIPTION_SCHEMA, PROJECT_DESCRIPTION_SYSTEM, projectSubject, recordScan, runProjectDescriptions, scrubProjectText, setHandDescription, upsertMachine, validateProjectAnswer, type Db, type Project, type ProjectDescriptionClient } from "../src/index.ts";

function fixture(t: TestContext) {
  const folder = mkdtempSync(join(process.cwd(), ".project-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const root = join(folder, "demo");
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "Demo tracks installed versions.\nIt offers local reports.\n");
  const project: Project = { machineId: "hub", name: "demo", root: root.replace(/\\/g, "/") };
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  return { folder, root, project, db };
}

const answer = { summary: "Demo is a tool that tracks installed versions.", evidence: ["Demo tracks installed versions."], kind: "tool" };
const client = (generate: ProjectDescriptionClient["generate"]): ProjectDescriptionClient => ({ role: "scout-describe", probe: async () => ({ state: "idle", serving: "internal-model" }), generate });

test("project expansion uses immediate Hub folders, ignores private names and deduplicates roots", (t) => {
  const { folder, root, project } = fixture(t);
  for (const name of ["_private", ".hidden", "@vault", "node_modules", "empty", "plain"]) {
    mkdirSync(join(folder, name));
    if (name !== "empty") writeFileSync(join(folder, name, "README"), "A project description.");
  }
  mkdirSync(join(folder, "empty", "nested"));
  writeFileSync(join(folder, "empty", "nested", "README.md"), "Nested projects are excluded.");
  assert.deepEqual(findProjects("hub", [`${folder.replace(/\\/g, "/")}/*`, root]).map((item) => item.name), ["demo", "plain"]);
  assert.deepEqual(findProjects("laptop", [root]), []);
  assert.deepEqual(findProjects("hub", [join(folder, "absent")]), []);
  assert.deepEqual(findProjects("hub", [root]), [project]);
});

test("file collection labels the exact allowed sections in order and ignores all other files", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "README"), "Fallback README must not replace README.md.");
  writeFileSync(join(root, "CLAUDE.md"), "The project runs locally.\r\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", description: "Version reports", bin: "cli.js", scripts: { test: "node --test" }, main: "index.js", keywords: ["versions"], dependencies: { private: "private-dependency" }, private: true }));
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "demo"\n[dependencies]\nprivate = "never read"');
  writeFileSync(join(root, "pyproject.toml"), '[build-system]\nrequires = ["never read"]\n[project]\nname = "demo"\n[tool.private]\nsecret = "never read"');
  writeFileSync(join(root, ".env"), "DO_NOT_READ=fixture-value");
  writeFileSync(join(root, "source.ts"), "DO_NOT_READ");
  mkdirSync(join(root, "plans"));
  writeFileSync(join(root, "plans", "README.md"), "DO_NOT_READ");
  const collected = collectProjectText(root);
  assert.equal(collected.text, [
    "--- README.md ---\nDemo tracks installed versions.\nIt offers local reports.\n",
    "--- CLAUDE.md ---\nThe project runs locally.\n",
    '--- package.json ---\n{\n  "name": "demo",\n  "description": "Version reports",\n  "bin": "cli.js",\n  "scripts": {\n    "test": "node --test"\n  },\n  "main": "index.js",\n  "keywords": [\n    "versions"\n  ]\n}',
    '--- Cargo.toml ---\n[package]\nname = "demo"',
    '--- pyproject.toml ---\n[project]\nname = "demo"',
  ].join("\n\n"));
  assert.equal(collected.hash, collectProjectText(root).hash);
  assert.equal(collected.text.includes("DO_NOT_READ"), false);
  assert.equal(collected.text.includes("private-dependency"), false);
});

test("the collector caps each file and the total, handles fallback README and malformed metadata", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "README.md"), "r".repeat(10_000));
  writeFileSync(join(root, "CLAUDE.md"), "c".repeat(10_000));
  writeFileSync(join(root, "package.json"), JSON.stringify({ description: "p".repeat(4000) }));
  writeFileSync(join(root, "Cargo.toml"), `[package]\nx = "${"t".repeat(4000)}"`);
  writeFileSync(join(root, "pyproject.toml"), `[project]\nx = "${"y".repeat(4000)}"`);
  const { text } = collectProjectText(root);
  assert.equal(text.length, 24_000);
  assert.ok(text.includes("r".repeat(9000)));
  assert.equal(text.includes("r".repeat(9001)), false);
  assert.ok(text.includes("c".repeat(9000)));
  assert.equal(text.includes("c".repeat(9001)), false);
  assert.equal(text.includes("--- pyproject.toml ---"), false);
  rmSync(join(root, "README.md"));
  writeFileSync(join(root, "README"), "The fallback README describes the project.");
  writeFileSync(join(root, "package.json"), "invalid JSON");
  writeFileSync(join(root, "Cargo.toml"), "[dependencies]\nx = 1");
  const fallback = collectProjectText(root).text;
  assert.ok(fallback.startsWith("--- README ---\nThe fallback README"));
  assert.equal(fallback.includes("--- package.json ---"), false);
  assert.equal(fallback.includes("--- Cargo.toml ---"), false);
});

test("the scrubber removes credentials and high entropy strings before collection and hashing", (t) => {
  const { root } = fixture(t);
  const fixtures = ["api_key: fixtureCredentialLongValue", '"accessToken": "fixtureCredentialLongValue"', "client_secret=fixtureCredentialLongValue", "password: fixtureCredentialLongValue", "Authorization: Bearer fixtureCredentialLongValue", "authBearer: fixtureCredentialLongValue", "opaque f7KzW4xN9pQ2mR8tV6yB3cD1sH5jL0aE", "opaque f7!Kz#W4$x%N9&p*Q2(m)R8t@V6y^B3c", "FOO=fixtureCredentialLongValue", "SHORT=abc", "-----BEGIN RSA PRIVATE KEY-----"];
  writeFileSync(join(root, "README.md"), ["Demo tracks installed versions.", ...fixtures].join("\n"));
  assert.equal(scrubProjectText(fixtures.join("\n")), fixtures.map((line) => line.startsWith("opaque ") ? "opaque [credential removed]" : "[credential removed]").join("\n"));
  const prose = ["Run [the guide](docs/ARCHITECTURE.md) first.", "The model protectai/deberta-v3-base-prompt-injection-v2 runs locally.", "Set `STRUCTURED_JUDGE_AUTHORITATIVE` when ready and read https://docs.example.test/library/typing.html#typing.Protocol too."].join("\n");
  assert.equal(scrubProjectText(prose), prose);
  const collected = collectProjectText(root);
  for (const fixture of fixtures) assert.equal(collected.text.includes(fixture), false);
  assert.ok(collected.text.includes("Demo tracks installed versions."));
  assert.equal(collected.hash, collectProjectText(root).hash);
});

test("evidence verification accepts whitespace differences and computes confidence from every returned quote", () => {
  const text = "Demo tracks\n installed  versions. It offers local reports.";
  assert.deepEqual(validateProjectAnswer({ ...answer, confidence: 0, maker: "ignored" }, "demo", text), { summary: answer.summary, evidence: answer.evidence, confidence: 0.9 });
  const mixed = { ...answer, evidence: ["Demo tracks installed versions.", "It offers local reports.", "invented quote"] };
  assert.equal(validateProjectAnswer(mixed, "demo", text)?.confidence, 0.6);
  assert.deepEqual(validateProjectAnswer(mixed, "demo", text)?.evidence, mixed.evidence.slice(0, 2));
  assert.equal(validateProjectAnswer({ ...answer, evidence: ["Demo tracks installed versions.", "short"] }, "demo", text), null);
  assert.equal(validateProjectAnswer({ ...answer, evidence: ["invented quote"] }, "demo", text), null);
  assert.equal(validateProjectAnswer({ ...answer, evidence: ["Demo"] }, "demo", text), null);
  assert.equal(validateProjectAnswer({ ...answer, evidence: ["[credential removed]"] }, "demo", "[credential removed]"), null);
  for (const summary of ["Demo", "x".repeat(201), "Demo\ntracks versions.", "Demo\u2019s version tracker."]) assert.equal(validateProjectAnswer({ ...answer, summary }, "demo", text), null);
  for (const invalid of [null, [], {}, { ...answer, kind: "unknown" }, { ...answer, evidence: [4] }, { ...answer, evidence: [] }, { ...answer, evidence: Array(5).fill("Demo tracks installed versions.") }]) assert.equal(validateProjectAnswer(invalid, "demo", text), null);
});

test("a project job sends the exact collected text, probes each attempt, retries once and stores internal provenance", async (t) => {
  const { db, project } = fixture(t);
  let requests = 0;
  let probes = 0;
  const fake = client(async (role, system, user, schema) => {
    requests++;
    assert.equal(role, "scout-describe");
    assert.equal(system, PROJECT_DESCRIPTION_SYSTEM);
    assert.equal(user, collectProjectText(project.root).text);
    assert.deepEqual(schema, PROJECT_DESCRIPTION_SCHEMA);
    return { answer: requests === 1 ? { ...answer, evidence: ["invented evidence"] } : answer, servedBy: "internal-model" };
  });
  fake.probe = async () => { probes++; return {}; };
  const result = await runProjectDescriptions(db, [project], fake);
  assert.equal(result.applied, 1);
  assert.equal(result.rejected, 1);
  assert.equal(probes, 2);
  const stored = db.prepare("SELECT * FROM descriptions WHERE subject = ?").get(projectSubject(project))!;
  assert.equal(stored.source, "project");
  assert.equal(stored.generated, 1);
  assert.equal(stored.confidence, 0.9);
  assert.equal(stored.model_label, "internal-model");
  assert.equal(stored.input_hash, collectProjectText(project.root).hash);
  assert.equal(stored.evidence_json, JSON.stringify(answer.evidence));
  assert.equal((await runProjectDescriptions(db, [project], fake)).total, 0);
  assert.equal(requests, 2);
  assert.equal((await runProjectDescriptions(db, [project], fake, { force: true })).applied, 1);
  writeFileSync(join(project.root, "README.md"), "Demo tracks installed versions. Changed text.");
  assert.equal(listProjectDescriptions(db, [project])[0]!.hashState, "changed");
  assert.equal((await runProjectDescriptions(db, [project], fake)).applied, 1);
  assert.equal(requests, 4);
  assert.equal((await runProjectDescriptions(db, [project], fake, { force: true, only: "absent" })).total, 0);
});

test("a second invalid answer skips a project and empty files do not call the client", async (t) => {
  const { db, project } = fixture(t);
  let calls = 0;
  const fake = client(async () => { calls++; return { answer: {}, servedBy: null }; });
  const result = await runProjectDescriptions(db, [project], fake);
  assert.equal(calls, 2);
  assert.equal(result.rejected, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.done, 1);
  writeFileSync(join(project.root, "README.md"), "");
  assert.equal((await runProjectDescriptions(db, [project], fake)).skipped, 1);
  assert.equal(calls, 2);
});

test("busy probes and deferred requests stop after three failures with two 30 second waits", async (t) => {
  const { db, project } = fixture(t);
  for (const kind of ["busy", "deferred"]) {
    let probes = 0;
    const waits: number[] = [];
    const fake = client(async () => { throw { kind }; });
    fake.probe = async () => { probes++; if (kind === "busy") throw { kind }; return {}; };
    const result = await runProjectDescriptions(db, [project], fake, { wait: async (ms) => { waits.push(ms); } });
    assert.equal(result.state, "failed");
    assert.equal(result.error, "Cogitator is busy");
    assert.equal(probes, 3);
    assert.deepEqual(waits, [30_000, 30_000]);
  }
});

function store(db: Db, subject: string, text: string): void {
  db.prepare("INSERT INTO descriptions (subject, source, text, generated, confidence, evidence_json, at) VALUES (?, 'project', ?, 1, 0.9, '[\"verified quote\"]', ?)").run(subject, text, new Date().toISOString());
}

test("the resolver chooses the longest machine prefix, guards broad roots and keeps hand and install order", (t) => {
  const { db } = fixture(t);
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "other", name: "Other", os: "linux", kind: "host" });
  store(db, "project:hub:c:/work/demo", "The parent project tracks versions.");
  store(db, "project:hub:c:/work/demo/nested", "The nested project runs a version service.");
  store(db, "project:hub:c:/windows", "The broad root must not match.");
  store(db, "project:other:c:/work/demo", "The other machine owns another project.");
  const row = { machineId: "hub", kind: "windows-service", name: "Demo", program: "C:\\WORK\\Demo\\nested\\run.exe" };
  recordScan(db, "hub", { sourceKind: "test", location: "demo", status: "ok", installs: [{ ecosystem: "test", key: "demo", name: "Demo", kind: "app", version: "1", location: "C:/work/demo/nested", description: "The installed package runs a server." }] }, new Date().toISOString());
  const resolver = loadDescriptionResolver(db, { hints: [] });
  assert.equal(resolver.describe(row)?.text, "The nested project runs a version service.");
  assert.equal(resolver.describe({ ...row, program: "C:/work/demo/run.exe" })?.text, "The parent project tracks versions.");
  assert.equal(resolver.describe({ ...row, program: "C:/work/demolition/run.exe" }), null);
  assert.equal(resolver.describe({ ...row, program: "C:/Windows/System32/run.exe" }), null);
  assert.equal(resolver.describe({ ...row, machineId: "other", program: "C:/WORK/demo/run.exe" }), null);
  setHandDescription(db, "service:windows-service:Demo", "The hand edit describes the version service.");
  assert.equal(loadDescriptionResolver(db, { hints: [] }).describe(row)?.source, "hand");
  setHandDescription(db, "service:windows-service:Demo", null);
  db.prepare("DELETE FROM descriptions WHERE source = 'project'").run();
  assert.equal(loadDescriptionResolver(db, { hints: [] }).describe(row)?.source, "install");
});

test("project hints match service names, process names and port strings on their own machine", (t) => {
  const { folder, db } = fixture(t);
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  store(db, "project:hub:c:/work/demo", "The project runs a version service.");
  const path = join(folder, "hints.json");
  writeFileSync(path, JSON.stringify({ hints: [{ machine: "hub", match: "Demo", root: "C:/WORK/demo" }, { machine: "hub", match: "node", root: "C:/work/demo" }, { machine: "hub", match: "8181", root: "C:/work/demo" }, { machine: 1 }] }));
  const hints = loadProjectHints(path);
  assert.equal(hints.length, 3);
  const resolver = loadDescriptionResolver(db, { hints });
  assert.equal(resolver.describe({ machineId: "hub", kind: "windows-service", name: "demo", program: "C:/Shared/node.exe" })?.source, "project");
  assert.equal(resolver.describe({ machineId: "hub", processName: "NODE", processPath: "C:/Shared/node.exe" })?.source, "project");
  assert.equal(resolver.describe({ machineId: "hub", port: 8181, processPath: "C:/Shared/runtime.exe" })?.source, "project");
  assert.equal(resolver.describe({ machineId: "other", port: 8181, processPath: "C:/Shared/runtime.exe" }), null);
  assert.deepEqual(loadProjectHints(join(folder, "missing.json")), []);
});

test("an existing descriptions table gains the input hash without a schema version change", (t) => {
  const { folder } = fixture(t);
  const path = join(folder, "old.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE descriptions (subject TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, generated INTEGER NOT NULL, confidence REAL, evidence_json TEXT NOT NULL DEFAULT '[]', model_label TEXT, at TEXT NOT NULL, PRIMARY KEY (subject, source))");
  old.close();
  const migrated = openCatalog(path);
  assert.ok((migrated.prepare("PRAGMA table_info(descriptions)").all() as { name: string }[]).some((column) => column.name === "input_hash"));
  migrated.close();
  assert.ok(readFileSync(path).length > 0);
});

test("evidence verification ignores markdown emphasis and code ticks on either side", () => {
  const text = "Angband is built by the separate `Adapter` project and **runs** locally.";
  assert.deepEqual(validateProjectAnswer({ ...answer, evidence: ["Angband is built by the separate Adapter project", "and `runs` locally"] }, "demo", text)?.evidence, ["Angband is built by the separate Adapter project", "and `runs` locally"]);
  assert.equal(validateProjectAnswer({ ...answer, evidence: ["Angband is built by a different project"] }, "demo", text), null);
});
