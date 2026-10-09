import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openCatalog, recordScan, updatesView, upsertMachine } from "@scout/core";
import { brewApi, npmRegistry, pypi, runResearch, type Fetcher, type Researched, type Researcher, type ResearchTarget } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../fixtures/research", import.meta.url));
const SOURCES: Record<string, Researcher> = { "brew-api": brewApi, npm: npmRegistry, pypi };

interface Fixture {
  url: string;
  status: number;
  body: string;
  target: ResearchTarget;
  expected: Researched;
}

for (const [dir, researcher] of Object.entries(SOURCES)) {
  const cases = readdirSync(join(root, dir)).filter((f) => f.endsWith(".json"));
  test(`${researcher.source}: has fixtures`, () => assert.ok(cases.length > 0));
  for (const file of cases) {
    test(`${researcher.source}: ${file}`, () => {
      const f = JSON.parse(readFileSync(join(root, dir, file), "utf8")) as Fixture;
      assert.equal(researcher.url(f.target), f.url);
      assert.deepEqual(researcher.parse(f.status, f.body, f.target), f.expected);
    });
  }
}

const t = (ecosystem: string, key: string, tap: string | null = null): ResearchTarget => ({ id: 1, ecosystem, key, name: key, tap, homepage: null, details: {} });

test("a package that a source cannot be asked about gets no request", () => {
  assert.equal(brewApi.url(t("brew", "hashicorp/tap/terraform", "hashicorp/tap")), null);
  assert.equal(brewApi.url(t("brew", "weird name")), null);
  assert.equal(brewApi.url(t("brew", "jq", "someone/tap")), null);
  assert.equal(npmRegistry.url(t("npm", "../etc/passwd")), null);
  assert.equal(pypi.url(t("pipx", "bad/name")), null);
});

test("a formula revision is kept so an unchanged install is not called out of date", () => {
  const r = brewApi.parse(200, JSON.stringify({ versions: { stable: "5.3.9" }, revision: 1 }), t("brew", "bash"));
  assert.deepEqual(r.answers, [{ channel: "stable", version: "5.3.9_1", installable: true }]);
});

test("HTTP errors and bad bodies are failures, not answers", () => {
  assert.equal(brewApi.parse(503, "", t("brew", "git")).status, "failed");
  assert.equal(npmRegistry.parse(200, "<html>", t("npm", "x")).status, "failed");
  assert.equal(pypi.parse(200, JSON.stringify({ info: {} }), t("pipx", "x")).status, "failed");
  assert.equal(pypi.parse(200, JSON.stringify({ info: { version: "1.0", yanked: true } }), t("pipx", "x")).answers.length, 0);
});

function seed() {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  const brew = (name: string, version: string, tap = "homebrew/core") => ({ ecosystem: "brew", key: name, name, kind: "package" as const, version, location: `/b/${name}`, details: { tap } });
  recordScan(db, "mini", { sourceKind: "brew", location: "/b", status: "ok", installs: [brew("git", "2.55.0"), brew("gone", "1.0"), brew("terraform", "1.9", "hashicorp/tap"), brew("flaky", "1.0")] }, "2026-09-30T00:00:00Z");
  return db;
}

test("the runner records answers, logs misses, skips unaskable packages and does not repeat a fresh lookup", async () => {
  const db = seed();
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    if (url.endsWith("/git.json")) return { status: 200, text: async () => JSON.stringify({ versions: { stable: "2.56.0" }, revision: 0 }) };
    if (url.endsWith("/gone.json")) return { status: 404, text: async () => "not found" };
    throw new Error("connection reset");
  };
  const now = new Date("2026-09-30T06:00:00Z");
  const [summary] = await runResearch(db, [brewApi], { fetch: fetcher, now, concurrency: 2 });
  assert.deepEqual({ ...summary }, { source: "brew-api", asked: 3, ok: 1, notfound: 1, failed: 1, skipped: 1, answers: 1 });
  assert.deepEqual(updatesView(db, { onlyOutdated: true }).map((r) => [r.name, r.installed, r.available]), [["git", "2.55.0", "2.56.0"]]);
  // Two hours later: git and gone are cached for a day, the failed lookup is retried, the tap package is never asked.
  asked.length = 0;
  await runResearch(db, [brewApi], { fetch: fetcher, now: new Date("2026-09-30T08:00:00Z") });
  assert.deepEqual(asked, ["https://formulae.brew.sh/api/formula/flaky.json"]);
});
