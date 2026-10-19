import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { getIntel, openCatalog, recordScan, upsertMachine, type Db } from "@scout/core";
import { gitclone, github, runResearch, type Fetcher, type ResearchTarget } from "../src/index.ts";
import { cloneBehindRelease, mergeCloneIntel } from "../src/gitclone.ts";

interface Step {
  url: string;
  status: number;
  body: string;
}

interface Fixture {
  target: ResearchTarget;
  steps: Step[];
  expected: unknown;
}

const directory = new URL("../../../fixtures/research/gitclone/", import.meta.url);

for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
  test(`gitclone research parses ${file}`, () => {
    const fixture = JSON.parse(readFileSync(new URL(file, directory), "utf8")) as Fixture;
    const seen: string[] = [];
    const prior: Step[] = [];
    let url = gitclone.url(fixture.target);
    while (url !== null) {
      seen.push(url);
      const step = fixture.steps.find((item) => item.url === url);
      assert.ok(step, url);
      prior.push(step);
      url = gitclone.follow ? gitclone.follow(fixture.target, prior) : null;
    }
    assert.deepEqual(seen, fixture.steps.map((step) => step.url));
    assert.deepEqual(gitclone.parse(fixture.steps[0]?.status ?? 0, JSON.stringify(fixture.steps), fixture.target), fixture.expected);
  });
}

const target = (key: string, details: Record<string, unknown> = {}): ResearchTarget => ({
  id: 1, ecosystem: "gitclone", key, name: "demo", tap: null, homepage: null, details, observedAt: "2026-10-18T12:00:00.000Z",
});

test("gitclone research ignores forges other than GitHub and a missing repository", () => {
  assert.equal(gitclone.url(target("codeberg.org/owner/repo")), null);
  assert.equal(gitclone.url(target("github.com/only-one-segment")), null);
  assert.equal(gitclone.url(target("github.com/owner/../../repo")), null);
  const missing = "https://api.github.com/repos/example/missing";
  const parsed = gitclone.parse(404, JSON.stringify([{ url: missing, status: 404, body: "{\"message\":\"Not Found\"}" }]), target("github.com/example/missing"));
  assert.equal(parsed.status, "notfound");
  assert.equal(parsed.intel, undefined);
  assert.equal(gitclone.parse(200, "not-json", target("github.com/example/demo")).status, "failed");
});

test("a clone is behind a newer release only by compareVersions", () => {
  assert.equal(cloneBehindRelease("v1.0.0", "v1.0.0-0-gabcdef0", "v1.2.0"), true);
  assert.equal(cloneBehindRelease("v1.2.0", "v1.2.0-0-gabcdef0", "v1.2.0"), false);
  assert.equal(cloneBehindRelease("v1.2.0", "v1.2.0-1-gabcdef0", "v1.2.0"), false);
  assert.equal(cloneBehindRelease("v1.2.0", "v1.2.0-1-gabcdef0", "v1.3.0"), true);
  assert.equal(cloneBehindRelease(null, "v1.2.0-1-gabcdef0", "v1.3.0"), true);
  assert.equal(cloneBehindRelease(null, "abcdef0", "v1.3.0"), false);
  assert.equal(cloneBehindRelease("v2.0.0", "v2.0.0-1-gabcdef0", "v1.0.0"), false);
  assert.equal(cloneBehindRelease("v1.0.0", null, null), false);
});

test("clone intel keeps the newest commits and drops past 20", () => {
  const previous = { clones: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`p${index}`, index])) };
  const merged = mergeCloneIntel(previous, { behindBy: 3, clones: { newest: 3 } });
  const keys = Object.keys(merged["clones"] as Record<string, unknown>);
  assert.equal(keys[0], "newest");
  assert.equal(keys.length, 20);
  assert.equal(keys.includes("p0"), true);
  assert.equal(keys.includes("p19"), false);
  const updated = mergeCloneIntel({ clones: { a: 1, b: 2 } }, { clones: { a: 9 } });
  assert.deepEqual(updated["clones"], { a: 9, b: 2 });
});

function seed(): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "windows", kind: "host" });
  return db;
}

const install = (key: string, commit: string, ecosystem = "gitclone") => ({
  ecosystem, key, name: key, kind: "repo" as const, version: "v1.0.0", location: `/tmp/${key}`, details: { commit },
});

test("gitclone research sends the GitHub token, stores intel, and merges a later commit", async () => {
  const db = seed();
  const first = "a".repeat(40);
  const second = "d".repeat(40);
  recordScan(db, "test", { sourceKind: "gitclone", location: "", status: "ok", installs: [install("github.com/example/demo", first)] }, "2026-10-18T00:00:00Z");
  const urls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers["accept"], "application/vnd.github+json");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(init.headers["authorization"], "Bearer fixture-value");
    const hash = url.includes(second) ? second : first;
    const ahead = hash === second ? 1 : 4;
    let status = 200;
    let body = "{\"default_branch\":\"main\",\"archived\":false,\"pushed_at\":\"2026-10-01T00:00:00Z\"}";
    if (url.endsWith("/releases/latest")) body = "{\"tag_name\":\"v2.0.0\",\"draft\":false,\"prerelease\":false,\"published_at\":\"2026-10-02T00:00:00Z\",\"html_url\":\"https://github.com/example/demo/releases/tag/v2.0.0\"}";
    else if (url.includes("/commits/")) body = "{\"sha\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"commit\":{\"committer\":{\"date\":\"2026-10-03T00:00:00Z\"}}}";
    else if (url.includes("/compare/")) body = `{"status":"ahead","ahead_by":${ahead},"behind_by":0,"total_commits":${ahead}}`;
    return { status, text: async () => body, headers: { get: () => null } };
  };
  const now = new Date("2026-10-18T12:00:00.000Z");
  try {
    await runResearch(db, [gitclone], { fetch: fetcher, now, env: { SCOUT_GITHUB_TOKEN: "fixture-value" } });
    assert.deepEqual(urls, [
      "https://api.github.com/repos/example/demo",
      "https://api.github.com/repos/example/demo/releases/latest",
      "https://api.github.com/repos/example/demo/commits/main",
      `https://api.github.com/repos/example/demo/compare/${first}...main`,
    ]);
    recordScan(db, "test", { sourceKind: "gitclone", location: "", status: "ok", installs: [install("github.com/example/demo", second)] }, "2026-10-18T13:00:00.000Z");
    urls.length = 0;
    await runResearch(db, [gitclone], { fetch: fetcher, now: new Date("2026-10-18T14:00:00.000Z"), env: { SCOUT_GITHUB_TOKEN: "fixture-value" }, force: true });
    const row = db.prepare("SELECT id FROM packages WHERE ecosystem = 'gitclone'").get() as { id: number };
    const intel = getIntel(db, row.id, "gitclone");
    const clones = intel?.data["clones"] as Record<string, number>;
    assert.deepEqual(Object.keys(clones), [second, first]);
    assert.equal(clones[second], 1);
    assert.equal(clones[first], 4);
    assert.equal(intel?.data["behindBy"], 1);
    const stored = db.prepare("SELECT version, installable FROM assertions WHERE source = 'gitclone'").get() as { version: string; installable: number };
    assert.equal(stored.version, "v2.0.0");
    assert.equal(stored.installable, 0);
  } finally {
    db.close();
  }
});

test("gitclone research stops on the shared GitHub rate limit and does not record the token", async () => {
  const db = seed();
  recordScan(db, "test", {
    sourceKind: "gitclone", location: "", status: "ok",
    installs: [
      install("github.com/example/demo", "a".repeat(40)),
      install("github.com/example/other", "b".repeat(40)),
      { ecosystem: "npm", key: "demo", name: "demo", kind: "package", version: "1.0.0", location: "/tmp/npm", homepage: "https://github.com/example/demo", details: {} },
    ],
  }, "2026-10-18T00:00:00Z");
  let calls = 0;
  const fetcher: Fetcher = async (_url, init) => {
    calls++;
    assert.equal(init.headers["authorization"], undefined);
    return { status: 429, headers: { get: (name) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790726400" })[name] ?? null }, text: async () => { throw new Error("fixture-value"); } };
  };
  try {
    const summaries = await runResearch(db, [gitclone, github], { fetch: fetcher, now: new Date("2026-10-18T12:00:00.000Z"), env: {} });
    assert.equal(calls, 1);
    assert.deepEqual(summaries.map((summary) => [summary.source, summary.asked, summary.failed, summary.skipped]), [
      ["gitclone", 1, 1, 1],
      ["github", 0, 0, 1],
    ]);
    const log = db.prepare("SELECT status, message FROM research_log").get() as { status: string; message: string };
    assert.equal(log.status, "failed");
    assert.equal(log.message, "GitHub rate limit resets at 2026-09-30T00:00:00.000Z");
    const count = db.prepare("SELECT COUNT(*) AS n FROM source_intel").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
});

test("a thrown gitclone request records request failed", async () => {
  const db = seed();
  recordScan(db, "test", { sourceKind: "gitclone", location: "", status: "ok", installs: [install("github.com/example/demo", "a".repeat(40))] }, "2026-10-18T00:00:00Z");
  const fetcher: Fetcher = async () => { throw new Error("fixture-value"); };
  try {
    await runResearch(db, [gitclone], { fetch: fetcher, now: new Date("2026-10-18T12:00:00.000Z"), env: { SCOUT_GITHUB_TOKEN: "fixture-value" } });
    assert.equal((db.prepare("SELECT message FROM research_log").get() as { message: string }).message, "request failed");
  } finally {
    db.close();
  }
});

test("a non-GitHub clone is not requested", async () => {
  const db = seed();
  recordScan(db, "test", { sourceKind: "gitclone", location: "", status: "ok", installs: [install("codeberg.org/owner/repo", "a".repeat(40))] }, "2026-10-18T00:00:00Z");
  let calls = 0;
  const fetcher: Fetcher = async () => { calls++; return { status: 200, text: async () => "{}" }; };
  try {
    const summaries = await runResearch(db, [gitclone], { fetch: fetcher, now: new Date("2026-10-18T12:00:00.000Z"), env: {} });
    assert.equal(calls, 0);
    assert.equal(summaries[0]?.skipped, 1);
    assert.equal(summaries[0]?.asked, 0);
  } finally {
    db.close();
  }
});
