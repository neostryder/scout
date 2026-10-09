import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { openCatalog, recordScan, upsertMachine, type Db } from "@scout/core";
import { crates, DAILY, github, goproxy, RESEARCHERS, runResearch, SIX_HOURS, sparkle, WEEKLY, type Fetcher, type Researched, type Researcher, type ResearchTarget, type ResponseHeaders } from "../src/index.ts";
import { githubRepo } from "../src/github.ts";

const target = (ecosystem: string, key: string, extra: Partial<ResearchTarget> = {}): ResearchTarget => ({ id: 1, ecosystem, key, name: key, tap: null, homepage: null, details: {}, ...extra });
const sources = [github, goproxy, crates, sparkle];

interface Fixture {
  url: string;
  status: number;
  body: string;
  target: ResearchTarget;
  headers?: ResponseHeaders;
  expected: Researched;
}

for (const researcher of sources) {
  const directory = new URL(`../../../fixtures/research/${researcher.source}/`, import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    test(`research ${researcher.source} parses ${file}`, () => {
      const fixture = JSON.parse(readFileSync(new URL(file, directory), "utf8")) as Fixture;
      assert.equal(researcher.url(fixture.target), fixture.url);
      assert.deepEqual(researcher.parse(fixture.status, fixture.body, fixture.target, fixture.headers), fixture.expected);
    });
  }
}

test("research registers every source with its cache lifetime", () => {
  assert.deepEqual(RESEARCHERS.map((source) => [source.source, source.ttlMs]), [["brew-api", DAILY], ["npm", DAILY], ["pypi", DAILY], ["goproxy", DAILY], ["crates", DAILY], ["sparkle", SIX_HOURS], ["github", SIX_HOURS], ["endoflife", DAILY], ["vendor", WEEKLY]]);
  assert.deepEqual(crates.ecosystems, ["cargo"]);
});

test("research GitHub repositories come from homepages and Go module paths", () => {
  for (const suffix of ["", "/", "///", ".git", ".git/", "/tree/main/packages/demo", "/releases", "/releases/tag/v2.0.0"]) {
    assert.equal(githubRepo(target("npm", "demo", { homepage: `https://github.com/Example/demo${suffix}` })), "Example/demo");
  }
  for (const homepage of ["https://example.test/Example/demo", "http://github.com/Example/demo", "https://github.com/Example", "https://github.com/Example/demo/issues", "https://github.com.evil.test/Example/demo", "https://user:pass@github.com/Example/demo", "garbage"]) {
    assert.equal(github.url(target("npm", "demo", { homepage })), null);
  }
  assert.equal(githubRepo(target("go-bin", "github.com/Example/demo/cmd/tool")), "Example/demo");
  assert.equal(githubRepo(target("go-bin", "demo", { details: { module: "github.com/Example/demo/v2" } })), "Example/demo");
  assert.equal(githubRepo(target("npm", "github.com/Example/demo")), null);
});

test("research URLs reject missing details and invalid names", () => {
  for (const module of ["", "../bad", "example.test/../bad", "https://example.test/demo", "example.test/bad name", "example.test/demo?x", null]) {
    assert.equal(goproxy.url(target("go-bin", "demo", { details: { module } })), null);
  }
  assert.equal(goproxy.url(target("go-bin", "demo", { details: { module: "example.test/ABC/Tool/v2" } })), "https://proxy.golang.org/example.test/!a!b!c/!tool/v2/@latest");
  assert.equal(crates.url(target("cargo", "bad/name")), null);
  assert.equal(crates.url(target("cargo", "../demo")), null);
  for (const sparkleFeed of [undefined, "", "file:///tmp/feed.xml", "javascript:alert(1)", "ftp://example.test/feed", "https://user:pass@example.test/feed", "garbage"]) {
    assert.equal(sparkle.url(target("bundle", "demo", { details: { sparkleFeed } })), null);
  }
  assert.equal(sparkle.url(target("bundle", "demo", { details: { sparkleFeed: "http://example.test/feed.xml" } })), "http://example.test/feed.xml");
});

test("research parsers reject HTTP failures and malformed response bodies", () => {
  for (const researcher of sources) {
    assert.equal(researcher.parse(503, "", target("cargo", "demo")).status, "failed");
    assert.equal(researcher.parse(200, "broken", target("cargo", "demo")).status, "failed");
  }
  assert.equal(github.parse(200, "{}", target("npm", "demo")).status, "failed");
  assert.deepEqual(github.parse(200, '[null,{},42,{"tag_name":"v2.0.0","draft":false}]', target("npm", "demo")).answers, []);
  assert.equal(github.parse(429, "", target("npm", "demo"), { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "unknown" }).message, "GitHub rate limit resets at unknown");
  assert.equal(github.parse(403, "", target("npm", "demo")).message, "HTTP 403");
  assert.deepEqual(goproxy.parse(200, '{"Version":"v0.0.0-20260929120000-abcdef012345"}', target("go-bin", "demo")).answers, []);
});

test("research Sparkle recognizes known channels and tolerates odd XML", () => {
  const t = target("bundle", "demo");
  for (const channel of ["beta", "rc", "preview", "nightly"]) {
    const body = `<rss><channel><item><enclosure sparkle:version="3.0.0"/><sparkle:channel>${channel}</sparkle:channel></item></channel></rss>`;
    assert.deepEqual(sparkle.parse(200, body, t).answers, [{ channel: "beta", version: "3.0.0", installable: false }]);
  }
  const body = '<rss><channel><item><enclosure sparkle:version="2.0.0"/></item><item><enclosure sparkle:version="2.0.0-rc.1" sparkle:channel="beta"/></item><item><enclosure sparkle:version="9.0.0" sparkle:channel="custom"/></item></channel></rss>';
  assert.deepEqual(sparkle.parse(200, body, t).answers, [{ channel: "stable", version: "2.0.0", installable: false }]);
  for (const body of ["", "<", "<rss>", "<rss><item><enclosure sparkle:version='x'/>", "<rss><item><sparkle:version>&#99999999999999;</sparkle:version>", "<rss><!-- broken", '<rss><item><enclosure sparkle:version="2.0.0" url="a>b"/></item></rss>']) {
    assert.doesNotThrow(() => sparkle.parse(200, body, t));
  }
});

function seed(ecosystem: string, count = 1): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "macos", kind: "host" });
  recordScan(db, "test", { sourceKind: "test", location: "", status: "ok", installs: Array.from({ length: count }, (_, index) => ({ ecosystem, key: `demo${index}`, name: `Demo ${index}`, kind: "package", version: "1.0.0", location: `/test/${index}`, homepage: `https://github.com/example/demo${index}`, details: { module: `github.com/example/demo${index}` } })) }, "2026-09-30T00:00:00Z");
  return db;
}

const NOW = new Date("2026-09-30T06:00:00Z");

test("research runner loads the homepage and newest live install details", async () => {
  const db = seed("go-bin");
  try {
    upsertMachine(db, { id: "newer", name: "Newer", os: "macos", kind: "host" });
    recordScan(db, "newer", { sourceKind: "test", location: "", status: "ok", installs: [{ ecosystem: "go-bin", key: "demo0", name: "demo0", kind: "binary", version: "1.0.0", location: "/newer", details: { module: "example.test/Newer", tap: "new/tap" } }] }, "2026-09-30T01:00:00Z");
    let seen: ResearchTarget | undefined;
    const researcher: Researcher = { source: "metadata", ecosystems: ["go-bin"], ttlMs: DAILY, url(t) { seen = t; return "https://example.test/test"; }, parse: () => ({ status: "ok", answers: [] }) };
    const fetcher: Fetcher = async () => ({ status: 200, text: async () => "{}" });
    await runResearch(db, [researcher], { fetch: fetcher, now: NOW });
    assert.equal(seen?.homepage, "https://github.com/example/demo0");
    assert.deepEqual(seen?.details, { module: "example.test/Newer", tap: "new/tap" });
    assert.equal(seen?.tap, "new/tap");
    recordScan(db, "newer", { sourceKind: "test", location: "", status: "ok", installs: [] }, "2026-09-30T02:00:00Z");
    await runResearch(db, [researcher], { fetch: fetcher, now: NOW, force: true });
    assert.equal(seen?.details.module, "github.com/example/demo0");
  } finally {
    db.close();
  }
});

test("research runner uses per-source caches and an explicit refresh bypasses them", async () => {
  const db = seed("go-bin");
  let calls = 0;
  const fetcher: Fetcher = async (url) => {
    calls++;
    return { status: 200, text: async () => url.includes("proxy.golang.org") ? '{"Version":"v2.0.0"}' : '[{"tag_name":"v2.0.0","draft":false,"prerelease":false}]' };
  };
  try {
    await runResearch(db, [github, goproxy], { fetch: fetcher, now: NOW, env: {} });
    assert.equal(calls, 2);
    await runResearch(db, [github, goproxy], { fetch: fetcher, now: new Date(NOW.getTime() + SIX_HOURS), env: {} });
    assert.equal(calls, 3);
    await runResearch(db, [github, goproxy], { fetch: fetcher, now: new Date(NOW.getTime() + SIX_HOURS), force: true, env: {} });
    assert.equal(calls, 5);
    const assertions = db.prepare("SELECT installable FROM assertions").all() as { installable: number }[];
    assert.ok(assertions.every((row) => row.installable === 0));
  } finally {
    db.close();
  }
});

test("research runner sends GitHub headers, stops after a rate limit and resumes in a new run", async () => {
  const db = seed("go-bin", 3);
  let calls = 0;
  const lines: string[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    calls++;
    assert.equal(init.headers["accept"], "application/vnd.github+json");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.ok(!("authorization" in init.headers));
    return { status: 429, headers: { get: (name) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790726400" })[name] ?? null }, text: async () => { throw new Error("a rate-limit body need not be read"); } };
  };
  try {
    const summaries = await runResearch(db, [github, github], { fetch: fetcher, now: NOW, env: {}, concurrency: 40, onProgress: (line) => lines.push(line) });
    assert.equal(calls, 1);
    assert.deepEqual(summaries.map((summary) => [summary.asked, summary.failed, summary.skipped]), [[1, 1, 2], [0, 0, 2]]);
    const log = db.prepare("SELECT status, message FROM research_log").get() as { status: string; message: string };
    assert.equal(log.status, "failed");
    assert.equal(log.message, "GitHub rate limit resets at 2026-09-30T00:00:00.000Z");
    await runResearch(db, [github], { fetch: fetcher, now: new Date(NOW.getTime() + 3_600_000), env: {} });
    assert.equal(calls, 2);
    assert.equal(lines.length, 1);
  } finally {
    db.close();
  }
});

test("research runner uses only the named GitHub environment value and never records request errors", async () => {
  const db = seed("go-bin");
  try {
    const fetcher: Fetcher = async (_url, init) => {
      assert.equal(init.headers["authorization"], "Bearer fixture-value");
      throw new Error("fixture-value");
    };
    await runResearch(db, [github], { fetch: fetcher, now: NOW, env: { SCOUT_GITHUB_TOKEN: "fixture-value" } });
    assert.equal((db.prepare("SELECT message FROM research_log").get() as { message: string }).message, "request failed");
  } finally {
    db.close();
  }
});

test("research runner caps all requests at four and GitHub requests at one", async () => {
  const db = seed("npm", 12);
  let active = 0;
  let maximum = 0;
  let githubMaximum = 0;
  const fetcher: Fetcher = async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    if (url.includes("api.github.com")) githubMaximum = Math.max(githubMaximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return { status: 200, text: async () => url.includes("api.github.com") ? "[]" : '{"latest":"2.0.0"}' };
  };
  try {
    const npm = RESEARCHERS.find((researcher) => researcher.source === "npm") as Researcher;
    await runResearch(db, [npm, github], { fetch: fetcher, now: NOW, concurrency: 40, env: {} });
    assert.equal(maximum, 4);
    assert.equal(githubMaximum, 1);
    assert.equal(active, 0);
  } finally {
    db.close();
  }
});
