import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { openCatalog, recordScan, supportWindowsOf, upsertMachine } from "@scout/core";
import { DAILY, endoflife, RESEARCHERS, runResearch, type Researched, type ResearchTarget } from "../src/index.ts";
import { supportProduct } from "../src/endoflife.ts";

const NOW = new Date("2026-09-30T06:00:00.000Z");
const target = (key: string, name = key): ResearchTarget => ({ id: 1, ecosystem: "brew", key, name, tap: null, homepage: null, details: {}, observedAt: NOW.toISOString() });
const directory = new URL("../../../fixtures/research/endoflife/", import.meta.url);

for (const file of readdirSync(directory)) {
  test(`research2 endoflife parses ${file}`, () => {
    const fixture = JSON.parse(readFileSync(new URL(file, directory), "utf8")) as { url: string; status: number; body: string; target: ResearchTarget; expected: Researched };
    assert.equal(endoflife.url(fixture.target), fixture.url);
    assert.deepEqual(endoflife.parse(fixture.status, fixture.body, fixture.target), fixture.expected);
  });
}

test("research2 support products normalize package keys, vendor prefixes and cycle hints", () => {
  const products: Record<string, string> = { node: "nodejs", nodejs: "nodejs", "OpenJS.NodeJS": "nodejs", "OpenJS.NodeJS.LTS": "nodejs", python: "python", "python@3.14": "python", "Python.Python.3.14": "python", go: "go", golang: "go", "GoLang.Go": "go", ruby: "ruby", php: "php", "postgresql@17": "postgresql", mysql: "mysql", mariadb: "mariadb", redis: "redis", nginx: "nginx", openssl: "openssl", git: "git", dotnet: "dotnet", java: "oracle-jdk", openjdk: "openjdk-builds-from-oracle", rust: "rust", "docker-engine": "docker-engine", kubernetes: "kubernetes" };
  for (const [key, slug] of Object.entries(products)) assert.equal(supportProduct(target(key))?.slug, slug, key);
  assert.deepEqual(supportProduct(target("Python.Python.3.14.exe")), { slug: "python", cycle: "3.14" });
  assert.deepEqual(supportProduct(target("postgresql@17")), { slug: "postgresql", cycle: "17" });
  assert.deepEqual(supportProduct(target("Vendor.Node.EXE")), { slug: "nodejs", cycle: null });
  assert.equal(supportProduct(target("unknown", "Node.js"))?.slug, "nodejs");
  for (const key of ["macos", "windows", "Microsoft.Windows", "Apple.macOS", "unmapped", "docker-desktop", "constructor", "__proto__"]) assert.equal(endoflife.url(target(key)), null);
  assert.equal(RESEARCHERS.find((source) => source.source === "endoflife")?.ttlMs, DAILY);
});

test("research2 support calendars tolerate incomplete rows and preserve boolean EOL", () => {
  const body = JSON.stringify([null, {}, { cycle: "" }, { cycle: 24, eol: "2026-09-29", latest: "24.99.0", lts: true }, { cycle: "20", eol: true, latest: "20.20.0", lts: "2023-10-24" }, { cycle: "22", eol: "bad", latest: "22.20.0", lts: false }, { cycle: "26", eol: "2026-09-30", latest: "26.8.0", lts: false }, { cycle: "28", latest: null, lts: "2026-02-30" }]);
  assert.equal(endoflife.parse(200, body, target("node")).answers[0]?.version, "26.8.0");
  assert.equal(endoflife.parse(200, body, target("node@20")).answers[0]?.version, "20.20.0");
  assert.deepEqual(endoflife.parse(200, body, target("node@27")).answers, []);
  assert.deepEqual(endoflife.parse(200, '[{"cycle":"20","eol":true,"latest":"20.0.0"}]', target("node")).answers, []);
  assert.equal(endoflife.extra?.(target("node"), 200, body).length, 5);
  assert.deepEqual(endoflife.extra?.(target("node"), 200, body)[1], { cycle: "20", eol: true, latest: "20.20.0", lts: true });
  assert.equal(endoflife.extra?.(target("node"), 200, body).at(-1)?.lts, false);
  assert.deepEqual(endoflife.extra?.(target("node"), 503, body), []);
  assert.equal(endoflife.parse(503, "", target("node")).status, "failed");
  assert.equal(endoflife.parse(200, "{}", target("node")).status, "failed");
  assert.equal(endoflife.parse(200, body, { ...target("node"), observedAt: undefined }).status, "failed");
});

test("research2 support runner stores observations, caches for a day and keeps facts after a failed parse", async () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "macos", kind: "host" });
  recordScan(db, "test", { sourceKind: "brew", location: "", status: "ok", installs: [{ ecosystem: "brew", key: "node", name: "Node", kind: "runtime", version: "24.0.0", location: "/test/node" }] }, NOW.toISOString());
  const fixture = JSON.parse(readFileSync(new URL("node.json", directory), "utf8")) as { body: string };
  let calls = 0;
  try {
    const fetcher = async () => { calls++; return { status: 200, text: async () => fixture.body }; };
    await runResearch(db, [endoflife], { now: NOW, fetch: fetcher });
    const before = supportWindowsOf(db, 1);
    assert.equal(before.length, 3);
    assert.equal(before[0]?.eolPassed, true);
    assert.ok(before.every((row) => row.observedAt === NOW.toISOString()));
    assert.deepEqual({ ...db.prepare("SELECT advisory, installable FROM assertions").get() }, { advisory: 1, installable: 0 });
    await runResearch(db, [endoflife], { now: new Date(NOW.getTime() + DAILY - 1), fetch: fetcher });
    assert.equal(calls, 1);
    await runResearch(db, [endoflife], { now: new Date(NOW.getTime() + DAILY), fetch: fetcher });
    assert.equal(calls, 2);
    const refreshed = supportWindowsOf(db, 1);
    const [failed] = await runResearch(db, [endoflife], { now: new Date(NOW.getTime() + DAILY + 1), force: true, fetch: async () => ({ status: 200, text: async () => "broken" }) });
    assert.equal(failed?.failed, 1);
    assert.deepEqual(supportWindowsOf(db, 1), refreshed);
  } finally { db.close(); }
});
