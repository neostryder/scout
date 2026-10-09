import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConstraints, openCatalog, projectSelectorNotes, queryUpdates, recordResearch, recordScan, upsertMachine, type Db, type InstallRecord, type ScanResult } from "../src/index.ts";

const T = "2026-09-30T12:00:00.000Z";
type Selector = NonNullable<ScanResult["selectors"]>[number];

function selector(tool = "node", kind: Selector["kind"] = "node", spec = "24", file = "/home/test/proj/app/.nvmrc"): Selector {
  return { file, project: file.slice(0, file.lastIndexOf("/")), kind, tool, spec };
}

function scan(selectors: Selector[], status: ScanResult["status"] = "ok", location = ""): ScanResult {
  return { sourceKind: "projectsel", status, location, installs: [], selectors };
}

function seed(): Db {
  const db = openCatalog(":memory:");
  for (const id of ["a", "b"]) upsertMachine(db, { id, name: id, os: "macos", kind: "host" });
  return db;
}

function install(db: Db, machineId: string, sourceKind: string, key: string, kind: InstallRecord["kind"] = "runtime", details?: Record<string, unknown>): void {
  recordScan(db, machineId, { sourceKind, status: "ok", location: key, installs: [{ ecosystem: sourceKind, key, name: key, kind, version: "23.0.0", location: `/runtime/${sourceKind}/${key}`, details }] }, T);
}

test("projectsel: selectors bind to live runtimes and package managers on their machine", () => {
  const db = seed();
  try {
    for (const [source, key, kind, details] of [
      ["brew", "node@24", "package", {}], ["nvm", "24.4.0", "runtime", {}],
      ["fnm", "24.5.0", "runtime", {}], ["volta", "24.6.0", "runtime", { tool: "node" }],
      ["python", "3.13", "runtime", {}], ["brew", "rustup", "package", {}],
      ["rustup", "rustc", "runtime", {}], ["brew", "go", "package", {}],
      ["brew", "ruby@3.4", "package", {}], ["npm", "pnpm", "package", {}],
      ["npm", "yarn", "package", {}], ["npm", "npm", "package", {}],
      ["brew", "node-exporter", "package", {}], ["brew", "node", "service", {}],
    ] as const) install(db, "a", source, key, kind, details);
    install(db, "b", "brew", "node");
    install(db, "a", "removed", "node");
    recordScan(db, "a", { sourceKind: "removed", status: "ok", location: "node", installs: [] }, T);
    recordScan(db, "a", scan([
      selector(), selector("python", "python", "3.13", "/home/test/proj/app/.python-version"),
      selector("rust", "rust", "stable", "/home/test/proj/app/rust-toolchain"),
      selector("go", "go", "1.24", "/home/test/proj/app/.tool-versions"),
      selector("ruby", "ruby", "3.4", "/home/test/proj/app/.tool-versions"),
      ...["pnpm", "yarn", "npm"].map((tool) => selector(tool, "packageManager", "10", "/home/test/proj/app/package.json")),
    ]), T);
    const bindings = db.prepare("SELECT p.key, c.type, c.hard, c.origin, json_extract(c.detail_json, '$.tool') AS tool FROM constraints c JOIN installs i ON i.id = c.install_id JOIN packages p ON p.id = i.package_id ORDER BY c.id").all().map((row) => ({ ...row }));
    assert.equal(bindings.length, 12);
    assert.deepEqual(bindings.filter((row) => row["tool"] === "node").map((row) => row["key"]), ["node@24", "24.4.0", "24.5.0", "24.6.0"]);
    assert.deepEqual(bindings.filter((row) => row["tool"] === "rust").map((row) => row["key"]), ["rustup", "rustc"]);
    assert.ok(bindings.every((row) => row["hard"] === 0 && row["type"] === "project_selector" && String(row["origin"]).startsWith("~/proj/app/")));
  } finally { db.close(); }
});

test("projectsel: unmatched selectors remain unbound and origins redact home prefixes", () => {
  const db = seed();
  try {
    const files = ["/Users/test/proj/app/.nvmrc", "C:/Users/test/proj/app/.python-version", "/root/proj/app/rust-toolchain", "C:/Repositories/app/.nvmrc"];
    recordScan(db, "a", scan(files.map((file) => selector("node", "node", "24", file))), T);
    const rows = db.prepare("SELECT install_id, package_id, origin FROM constraints ORDER BY id").all().map((row) => ({ ...row }));
    assert.deepEqual(rows, files.map((file, index) => ({ install_id: null, package_id: null, origin: index < 3 ? `~/proj/app/${file.split("/").at(-1)}` : file })));
    assert.equal((db.prepare("SELECT count(*) AS count FROM installs").get() as { count: number }).count, 0);
  } finally { db.close(); }
});

test("projectsel: successful scans replace selectors and partial scans preserve unread files", () => {
  const db = seed();
  try {
    const first = selector();
    const other = selector("python", "python", "3.13", "/home/test/proj/other/.python-version");
    recordScan(db, "a", scan([first, first, other]), T);
    recordScan(db, "b", scan([first]), T);
    recordScan(db, "a", scan([first], "ok", "/other-root"), T);
    recordScan(db, "a", scan([{ ...first, spec: "26" }], "partial"), T);
    const specs = () => db.prepare("SELECT spec FROM constraints ORDER BY id").all().map((row) => row["spec"]);
    assert.deepEqual(specs(), ["3.13", "24", "24", "26"]);
    recordScan(db, "a", scan([], "failed"), T);
    recordScan(db, "a", scan([], "skipped"), T);
    assert.deepEqual(specs(), ["3.13", "24", "24", "26"]);
    recordScan(db, "a", scan([{ ...first, spec: "26" }]), T);
    assert.deepEqual(specs(), ["24", "24", "26"]);
    recordScan(db, "a", scan([]), T);
    assert.deepEqual(specs(), ["24", "24"]);
  } finally { db.close(); }
});

test("projectsel: a partial scan retains multiple Python versions from one file", () => {
  const db = seed();
  try {
    const python = selector("python", "python", "3.12", "/projects/app/.python-version");
    recordScan(db, "a", scan([python, { ...python, spec: "3.13" }], "partial"), T);
    assert.deepEqual(db.prepare("SELECT spec FROM constraints ORDER BY id").all().map((row) => row["spec"]), ["3.12", "3.13"]);
  } finally { db.close(); }
});

test("projectsel: notes warn about incompatible versions without blocking updates", () => {
  const db = seed();
  try {
    install(db, "a", "brew", "node", "package");
    const id = (db.prepare("SELECT id FROM packages WHERE key = 'node'").get() as { id: number }).id;
    recordResearch(db, id, "brew-api", "ok", [{ channel: "stable", version: "27.0.0", installable: true }], null, T);
    recordScan(db, "a", scan([selector(), selector("node", "engines", ">=24 <27", "/home/test/proj/app/package.json")]), T);
    const result = queryUpdates(db);
    assert.equal(result.updatable, 1);
    assert.equal(result.rows[0]?.updatable, true);
    assert.equal(result.rows[0]?.blockedBy, null);
    assert.deepEqual(result.rows[0]?.notes, ["nvmrc in ~/proj/app wants node 24", "engines.node >=24 <27 in ~/proj/app excludes 27.0.0"]);
    recordResearch(db, id, "brew-api", "ok", [{ channel: "stable", version: "26.0.0", installable: true }], null, "2026-09-30T13:00:00.000Z");
    assert.deepEqual(queryUpdates(db).rows[0]?.notes, ["nvmrc in ~/proj/app wants node 24"]);
    deriveConstraints(db, T);
    assert.equal((db.prepare("SELECT count(*) AS count FROM constraints").get() as { count: number }).count, 2);
  } finally { db.close(); }
});

test("projectsel: compatibility notes handle common numeric ranges and leave unknown ranges quiet", () => {
  const db = seed();
  try {
    install(db, "a", "brew", "node");
    const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
    const cases: [string, string, boolean][] = [
      [">=24", "23.9.0", true], [">=24", "24.0.0", false], [">=24", "26.0.0", false],
      ["^24.1", "25.0.0", true], ["^24.1", "24.9.0", false],
      ["~24.1", "24.2.0", true], ["~24.1", "24.1.9", false],
      ["24.x", "25.0.0", true], ["24.x", "24.9.0", false],
      [">= 24 < 27", "27.0.0", true], ["^24 || ^26", "26.1.0", false],
      ["^24 || ^26", "25.1.0", true], ["24 - 26", "26.9.0", false], ["24 - 26", "27.0.0", true],
      ["24.1.0 - 24.2.0", "24.2.0", false], ["24.1.0 - 24.2.0", "24.2.1", true],
      ["^0.2.3", "0.3.0", true], ["^0.0.3", "0.0.4", true],
      ["<=24", "24.9.0", false], [">24", "24.9.0", true],
      ["*", "27.0.0", false], [">=24", "25.0.0-rc.1", true],
      ["vendor-range", "27.0.0", false], [">=24", "nightly", false],
    ];
    for (const [spec, available, warns] of cases) {
      recordScan(db, "a", scan([selector("node", "engines", spec, "/projects/app/package.json")]), T);
      assert.equal(projectSelectorNotes(db)(id, available).length > 0, warns, `${spec} against ${available}`);
      assert.deepEqual(projectSelectorNotes(db)(id, null), []);
    }
  } finally { db.close(); }
});

test("projectsel: advisory selectors preserve existing hard freezes", () => {
  const db = seed();
  try {
    install(db, "a", "brew", "node", "package", { pinned: true });
    const id = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
    recordResearch(db, id, "brew-api", "ok", [{ channel: "stable", version: "26.0.0", installable: true }], null, T);
    deriveConstraints(db, T);
    const before = queryUpdates(db).rows[0]!;
    recordScan(db, "a", scan([selector()]), T);
    const after = queryUpdates(db).rows[0]!;
    assert.equal(after.blockedBy, before.blockedBy);
    assert.equal(after.updatable, false);
    assert.deepEqual(after.notes, ["nvmrc in ~/proj/app wants node 24"]);
    deriveConstraints(db, T);
    assert.deepEqual(queryUpdates(db).rows[0]?.notes, after.notes);
  } finally { db.close(); }
});
