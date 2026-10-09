import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changelogSummaryFor, listChangelogSummaries, openCatalog, recordChangelogSummary, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { DAILY, summarizeChangelogs, type ChangelogOptions, type Fetcher } from "../src/index.ts";
import { releaseText, summaryText } from "../src/changelog.ts";

const NOW = new Date("2026-09-30T06:00:00.000Z");
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/research/changelog/release.json", import.meta.url), "utf8")) as { status: number; body: string; expectedText: string };
const release = JSON.parse(fixture.body) as { body: string; html_url: string };

function seed(count = 1, ecosystem = "npm") {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "macos", kind: "host" });
  recordScan(db, "test", { sourceKind: "test", location: "", status: "ok", installs: Array.from({ length: count }, (_, index) => ({ ecosystem, key: `tool${index}`, name: `Tool ${index}`, kind: "package", version: "1.0.0", location: `/test/tool${index}`, homepage: `https://github.com/example/tool${index}` })) }, NOW.toISOString());
  for (let packageId = 1; packageId <= count; packageId++) recordResearch(db, packageId, "github", "ok", [{ channel: "stable", version: "2.0.0", installable: false }], null, NOW.toISOString());
  return db;
}

test("research2 release text removes images, comments and contributor lists and caps public notes", () => {
  assert.equal(releaseText(release.body), fixture.expectedText);
  assert.equal(releaseText("x".repeat(9000)).length, 8000);
  assert.equal(releaseText("The release fixes startup.\nhttps://github.com/example/tool/commits/v2.0.0\nhttps://github.com/example/tool/contributors"), "The release fixes startup.");
  assert.equal(releaseText("The release fixes startup.\nhttps://github.com/example/tool/commits?author=person"), "The release fixes startup.");
  assert.equal(releaseText("The release fixes startup.\n![image][screen]\n<!-- unclosed"), "The release fixes startup.");
});

test("research2 summary text replaces non-ASCII punctuation, trims and caps at 600 characters", () => {
  assert.equal(summaryText("  The release\u2019s \u201cportable\u201d build\u2014and \u2018fast\u2019 startup\u2013work\u2026  "), 'The release\'s "portable" build-and \'fast\' startup-work...');
  assert.equal(summaryText("x".repeat(800)).length, 600);
  assert.equal(summaryText(" \n\t "), "");
  assert.equal(summaryText("The \u00abportable\u00bb build\u2011works\u3002"), 'The "portable" build-works');
});

test("research2 changelog has no network request or stored notes without a summarizer", async () => {
  const db = seed(3);
  try {
    const result = await summarizeChangelogs(db, { now: NOW, fetch: async () => { throw new Error("the request must not run"); } });
    assert.deepEqual(result, { stored: 0, skipped: 3, reason: "no summarizer configured" });
    assert.deepEqual(listChangelogSummaries(db, [1, 2, 3]), []);
    assert.equal(db.prepare("SELECT 1 FROM research_log WHERE source LIKE 'changelog:%'").get(), undefined);
  } finally { db.close(); }
});

test("research2 changelog retries a bare tag and stores only the cleaned injected summary once", async () => {
  const db = seed();
  const asked: string[] = [];
  let summaries = 0;
  const fetcher: Fetcher = async (url, init) => {
    asked.push(url);
    assert.equal(init.headers["user-agent"], "Scout");
    assert.equal(init.headers["accept"], "application/vnd.github+json");
    assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(init.redirect, "manual");
    return { status: url.endsWith("/v2.0.0") ? 404 : fixture.status, text: async () => fixture.body };
  };
  const summarize: ChangelogOptions["summarize"] = async (input) => {
    summaries++;
    assert.deepEqual(input, { name: "Tool 0", version: "2.0.0", installed: "1.0.0", text: fixture.expectedText });
    assert.deepEqual(Object.keys(input).sort(), ["installed", "name", "text", "version"]);
    return { summary: `  The release\u2019s changes\u2014fix startup\u2026 ${"x".repeat(700)}  `, model: " fixture " };
  };
  try {
    assert.deepEqual(await summarizeChangelogs(db, { now: NOW, fetch: fetcher, summarize }), { stored: 1, skipped: 0 });
    assert.deepEqual(asked, ["https://api.github.com/repos/example/tool0/releases/tags/v2.0.0", "https://api.github.com/repos/example/tool0/releases/tags/2.0.0"]);
    const stored = changelogSummaryFor(db, 1, "2.0.0");
    assert.equal(stored?.summary.length, 600);
    assert.ok(stored?.summary.startsWith("The release's changes-fix startup..."));
    assert.equal(stored?.sourceUrl, release.html_url);
    assert.equal(stored?.model, "fixture");
    assert.equal(stored?.createdAt, NOW.toISOString());
    assert.deepEqual(await summarizeChangelogs(db, { now: new Date(NOW.getTime() + DAILY), fetch: fetcher, summarize }), { stored: 0, skipped: 0 });
    assert.equal(summaries, 1);
    assert.equal(asked.length, 2);
  } finally { db.close(); }
});

test("research2 changelog caches release misses and rejected summaries for a day", async () => {
  for (const answer of [null, { summary: " \n ", model: "fixture" }, { summary: "The release fixes startup.", model: "" }]) {
    const db = seed();
    let calls = 0;
    const options: ChangelogOptions = { now: NOW, fetch: async () => { calls++; return { status: 200, text: async () => fixture.body }; }, summarize: async () => answer };
    try {
      assert.deepEqual(await summarizeChangelogs(db, options), { stored: 0, skipped: 1 });
      await summarizeChangelogs(db, { ...options, now: new Date(NOW.getTime() + DAILY - 1) });
      assert.equal(calls, 1);
      await summarizeChangelogs(db, { ...options, now: new Date(NOW.getTime() + DAILY) });
      assert.equal(calls, 2);
      assert.equal(changelogSummaryFor(db, 1, "2.0.0"), null);
    } finally { db.close(); }
  }
  const db = seed();
  let calls = 0;
  let summaries = 0;
  try {
    const options: ChangelogOptions = { now: NOW, fetch: async () => { calls++; return { status: 404, text: async () => "Not Found" }; }, summarize: async () => { summaries++; return null; } };
    await summarizeChangelogs(db, options);
    await summarizeChangelogs(db, options);
    assert.equal(calls, 2);
    assert.equal(summaries, 0);
  } finally { db.close(); }
});

test("research2 changelog caps each run at 20 packages, deduplicates installs and never overwrites", async () => {
  const db = seed(23);
  upsertMachine(db, { id: "second", name: "Second", os: "macos", kind: "host" });
  recordScan(db, "second", { sourceKind: "test", location: "", status: "ok", installs: [{ ecosystem: "npm", key: "tool0", name: "Tool 0", kind: "package", version: "1.5.0", location: "/second/tool" }] }, NOW.toISOString());
  recordChangelogSummary(db, { packageId: 1, version: "2.0.0", summary: "The stored summary stays.", sourceUrl: release.html_url, model: "fixture" }, NOW.toISOString());
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const options: ChangelogOptions = { now: NOW, fetch: async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return { status: fixture.status, text: async () => fixture.body };
  }, summarize: async () => ({ summary: "The release fixes startup.", model: "fixture" }) };
  try {
    assert.deepEqual(await summarizeChangelogs(db, options), { stored: 20, skipped: 2 });
    assert.equal(calls, 20);
    assert.equal(maximum, 1);
    assert.equal(listChangelogSummaries(db, Array.from({ length: 23 }, (_, i) => i + 1)).length, 21);
    assert.equal(changelogSummaryFor(db, 1, "2.0.0")?.summary, "The stored summary stays.");
    assert.deepEqual(await summarizeChangelogs(db, options), { stored: 2, skipped: 0 });
    assert.equal(calls, 22);
  } finally { db.close(); }
});

test("research2 concurrent changelog runs share one request at a time and recheck stored summaries", async () => {
  const db = seed(2);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const options: ChangelogOptions = { now: NOW, fetch: async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return { status: 200, text: async () => fixture.body };
  }, summarize: async () => ({ summary: "The release fixes startup.", model: "fixture" }) };
  try {
    assert.deepEqual(await Promise.all([summarizeChangelogs(db, options), summarizeChangelogs(db, options)]), [{ stored: 2, skipped: 0 }, { stored: 0, skipped: 0 }]);
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
  } finally { db.close(); }
});

test("research2 changelog uses Go module repositories and skips current, incomparable and non-GitHub packages", async () => {
  const db = seed(5, "go-bin");
  db.prepare("UPDATE packages SET homepage = NULL WHERE id = 1").run();
  db.prepare("UPDATE installs SET details_json = ? WHERE package_id = 1").run(JSON.stringify({ module: "github.com/example/module/v2" }));
  db.prepare("UPDATE installs SET version = '2.0.0' WHERE package_id = 2").run();
  db.prepare("UPDATE installs SET version = 'unknown' WHERE package_id = 3").run();
  db.prepare("UPDATE installs SET version = NULL WHERE package_id = 4").run();
  db.prepare("UPDATE packages SET homepage = 'https://example.test/tool' WHERE id = 5").run();
  const asked: string[] = [];
  try {
    assert.deepEqual(await summarizeChangelogs(db, { now: NOW, fetch: async (url) => { asked.push(url); return { status: 200, text: async () => fixture.body }; }, summarize: async () => ({ summary: "The release fixes startup.", model: "fixture" }) }), { stored: 1, skipped: 1 });
    assert.deepEqual(asked, ["https://api.github.com/repos/example/module/releases/tags/v2.0.0"]);
  } finally { db.close(); }
});

test("research2 changelog skips malformed, failed, empty and unsafe release notes without stopping the run", async () => {
  const bodies = ["broken", JSON.stringify({ body: "", html_url: release.html_url }), JSON.stringify({ body: "notes", html_url: "http://github.com/example/tool" }), JSON.stringify({ body: "notes", html_url: "https://evil.example/tool" }), fixture.body];
  const db = seed(bodies.length);
  let summaries = 0;
  try {
    const result = await summarizeChangelogs(db, { now: NOW, fetch: async (url) => {
      const index = Number(/tool(\d+)/.exec(url)?.[1]);
      return { status: index === 3 ? 503 : 200, text: async () => bodies[index] ?? "" };
    }, summarize: async () => { summaries++; return { summary: "The release fixes startup.", model: "fixture" }; } });
    assert.deepEqual(result, { stored: 1, skipped: 4 });
    assert.equal(summaries, 1);
    assert.equal(listChangelogSummaries(db, [1, 2, 3, 4, 5]).length, 1);
  } finally { db.close(); }
});

test("research2 changelog caps notes before summarization and retries a new version despite an older miss", async () => {
  const db = seed();
  let calls = 0;
  try {
    const options: ChangelogOptions = { now: NOW, fetch: async () => { calls++; return { status: 200, text: async () => JSON.stringify({ body: "x".repeat(9000), html_url: release.html_url }) }; }, summarize: async (input) => { assert.equal(input.text.length, 8000); return null; } };
    await summarizeChangelogs(db, options);
    recordResearch(db, 1, "github", "ok", [{ channel: "stable", version: "3.0.0", installable: false }], null, new Date(NOW.getTime() + 1).toISOString());
    await summarizeChangelogs(db, options);
    assert.equal(calls, 2);
  } finally { db.close(); }
});

test("research2 changelog keeps a prefixed upstream version in storage without doubling the tag prefix", async () => {
  const db = seed(1, "go-bin");
  const asked: string[] = [];
  try {
    recordResearch(db, 1, "github", "ok", [{ channel: "stable", version: "v3.0.0", installable: false }], null, new Date(NOW.getTime() + 1).toISOString());
    await summarizeChangelogs(db, { now: NOW, fetch: async (url) => { asked.push(url); return { status: 200, text: async () => fixture.body }; }, summarize: async (input) => {
      assert.equal(input.version, "v3.0.0");
      return { summary: "The release fixes startup.", model: "fixture" };
    } });
    assert.deepEqual(asked, ["https://api.github.com/repos/example/tool0/releases/tags/v3.0.0"]);
    assert.ok(changelogSummaryFor(db, 1, "v3.0.0"));
  } finally { db.close(); }
});
