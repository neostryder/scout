import { test } from "node:test";
import assert from "node:assert/strict";
import { listCompetitorRuns, listCompetitors, openCatalog, seedWatchBaseline, startPullingRun, syncCompetitors, type CompetitorIdentity, type CompetitorWatch } from "@scout/core";
import { checkWatchSource, fetchWatchSource, jsonVersion, pageText, pageToken, researchForWatch, runWatchUpdate, textVersion, type WatchFetcher } from "../src/index.ts";

const NOW = "2026-05-20T00:00:00.000Z";

function reply(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function fetcherFor(pages: Record<string, () => Response>, seen: string[] = []): WatchFetcher {
  return async (url) => {
    seen.push(url);
    const page = pages[url];
    if (!page) throw new Error(`unexpected request to ${url}`);
    return page();
  };
}

function identity(watch: CompetitorWatch, over: Partial<CompetitorIdentity> = {}): CompetitorIdentity {
  return { id: "solo-tool", name: "Solo Tool", org: "Solo", remoteUrl: null, mirrorPath: null, packageUrl: null, dossierDir: "D:/dossiers/Solo", dossierReviewed: null, flags: ["forge"], baseline: null, watch, ...over };
}

test("page text drops markup, scripts, and comments", () => {
  const html = "<html><head><style>.a{}</style><script>var v='9.9.9'</script></head><body><!-- 8.8.8 --><h1>Solo&nbsp;Tool &amp; Co</h1><p>Version 2.4.1</p></body></html>";
  assert.equal(pageText(html), "Solo Tool & Co Version 2.4.1");
});

test("a version comes out of JSON by dotted path, and a bad path or value gives none", () => {
  const text = JSON.stringify({ data: { releases: [{ version: "v2.1.0" }, { version: "2.0.0" }] }, build: 14 });
  assert.equal(jsonVersion(text, "data.releases.0.version"), "2.1.0");
  assert.equal(jsonVersion(text, "data.releases.5.version"), null);
  assert.equal(jsonVersion(text, "data.nope"), null);
  assert.equal(jsonVersion(text, "data.releases"), null);
  assert.equal(jsonVersion("not json", "a"), null);
  assert.equal(jsonVersion(JSON.stringify({ version: "latest" }), "version"), null);
});

test("a version comes out of page text, highest first, with the default or a custom pattern", () => {
  const text = "Changelog Version 2.4.1 fixes things. Version 2.3.0 added things. v2.10.0 is the newest. Version 2.4.0-beta.1 was tried.";
  assert.equal(textVersion(text), "2.10.0");
  assert.equal(textVersion("Release 7.1 out now. Release 7.0 before.", "Release (\\d+\\.\\d+)"), "7.1");
  assert.equal(textVersion("nothing numbered here"), null);
  assert.equal(textVersion("Release 1.0", "["), null);
});

test("the page token follows the words and not the markup", () => {
  assert.equal(pageToken(pageText("<p>Plans: $5 per month</p>")), pageToken(pageText("<div><span>Plans:</span>  $5 per month</div>")));
  assert.notEqual(pageToken("Plans: $5 per month"), pageToken("Plans: $7 per month"));
  assert.match(pageToken("x"), /^page:[0-9a-f]{16}$/);
});

test("a fetch follows a redirect to another public address and refuses an unsafe one", async () => {
  const seen: string[] = [];
  const ok = await fetchWatchSource("https://example.com/a", fetcherFor({
    "https://example.com/a": () => reply("", 301, { location: "/b" }),
    "https://example.com/b": () => reply("hello"),
  }, seen));
  assert.deepEqual(ok, { text: "hello" });
  assert.deepEqual(seen, ["https://example.com/a", "https://example.com/b"]);
  for (const target of ["http://example.com/x", "https://localhost/x", "https://10.0.0.5/x", "https://[::1]/x"]) {
    const refused = await fetchWatchSource("https://example.com/a", fetcherFor({ "https://example.com/a": () => reply("", 302, { location: target }) }));
    assert.deepEqual(refused, { error: "the watch address is not a public https address" }, target);
  }
  assert.deepEqual(await fetchWatchSource("http://example.com/a", fetcherFor({})), { error: "the watch address is not a public https address" });
});

test("a fetch reports a status, a redirect loop, and a network failure in plain words", async () => {
  assert.deepEqual(await fetchWatchSource("https://example.com/a", fetcherFor({ "https://example.com/a": () => reply("no", 404) })), { error: "the watch address answered 404" });
  assert.deepEqual(await fetchWatchSource("https://example.com/a", fetcherFor({ "https://example.com/a": () => reply("", 302, { location: "/a" }) })), { error: "the watch address redirected too many times" });
  assert.deepEqual(await fetchWatchSource("https://example.com/a", fetcherFor({ "https://example.com/a": () => reply("", 302) })), { error: "the watch address redirected without a usable location" });
  const failed = await fetchWatchSource("https://example.com/a", async () => { throw new Error("getaddrinfo ENOTFOUND example.com"); });
  assert.deepEqual(failed, { error: "getaddrinfo ENOTFOUND example.com" });
});

test("a fetch stops reading after the size cap", async () => {
  const big = "x".repeat(2_000_000);
  const result = await fetchWatchSource("https://example.com/a", fetcherFor({ "https://example.com/a": () => reply(big) }));
  assert.ok("text" in result && result.text.length === 1_500_000);
});

test("each kind of watch reads its own signal", async () => {
  const pages = {
    "https://example.com/api.json": () => reply(JSON.stringify({ version: "3.2.0" })),
    "https://example.com/changes": () => reply("<h2>Version 3.2.0</h2><p>New things</p>"),
    "https://example.com/pricing": () => reply("<p>Pro: $9 per month</p>"),
    "https://example.com/empty": () => reply("<script>x</script>"),
    "https://example.com/missing": () => reply("<p>Nothing numbered</p>"),
  };
  const fetcher = fetcherFor(pages);
  const json = await checkWatchSource({ kind: "json", url: "https://example.com/api.json", versionPath: "version" }, fetcher);
  assert.deepEqual({ version: json.version, commit: json.commit, error: json.error }, { version: "3.2.0", commit: null, error: null });
  const page = await checkWatchSource({ kind: "page", url: "https://example.com/changes" }, fetcher);
  assert.deepEqual({ version: page.version, commit: page.commit, error: page.error }, { version: "3.2.0", commit: null, error: null });
  assert.match(page.excerpt, /Version 3\.2\.0 New things/);
  const hash = await checkWatchSource({ kind: "hash", url: "https://example.com/pricing" }, fetcher);
  assert.equal(hash.version, null);
  assert.match(hash.commit ?? "", /^page:[0-9a-f]{16}$/);
  assert.equal((await checkWatchSource({ kind: "hash", url: "https://example.com/empty" }, fetcher)).error, "the watched page has no text");
  assert.equal((await checkWatchSource({ kind: "page", url: "https://example.com/missing" }, fetcher)).error, "no version found on the page");
  assert.equal((await checkWatchSource({ kind: "json", url: "https://example.com/api.json", versionPath: "nope" }, fetcher)).error, "no version at the watched path");
  assert.match((await checkWatchSource({ kind: "json", url: "http://example.com/api.json", versionPath: "version" }, fetcher)).error ?? "", /https/);
});

test("research for a watch reads the source, names the change, and says there is nothing to diff", async () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity({ kind: "json", url: "https://example.com/api.json", versionPath: "version" }, { baseline: { version: "3.1.0", commit: null, at: NOW, source: "analysis" } })]);
  let version = "3.2.0";
  const fetcher = fetcherFor({ "https://example.com/api.json": () => reply(JSON.stringify({ version })) });
  const found = await researchForWatch(db, "solo-tool", { now: NOW, fetcher });
  assert.ok(!("error" in found));
  if ("error" in found) return;
  assert.equal(found.toVersion, "3.2.0");
  assert.equal(found.delta.newStableTag, true);
  assert.equal(found.delta.pageChanged, false);
  assert.deepEqual(found.request["from"], { version: "3.1.0", commit: null });
  assert.deepEqual(found.request["to"], { version: "3.2.0", commit: null });
  assert.equal(found.request["mirrorPath"], null);
  assert.deepEqual((found.request["watch"] as { kind: string }).kind, "json");
  assert.equal(((found.request["analysis"] as { flags: { reaRecommended: boolean } }).flags).reaRecommended, false);
  version = "3.1.0";
  const same = await researchForWatch(db, "solo-tool", { now: NOW, fetcher });
  assert.ok(!("error" in same) && same.delta.newStableTag === false);
  const failing = await researchForWatch(db, "solo-tool", { now: NOW, fetcher: async () => reply("down", 503) });
  assert.deepEqual(failing, { error: "the watch address answered 503" });
  db.close();
});

test("a hash watch with a new snapshot is a page change and not a version", async () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity({ kind: "hash", url: "https://example.com/pricing" })]);
  const first = await checkWatchSource({ kind: "hash", url: "https://example.com/pricing" }, fetcherFor({ "https://example.com/pricing": () => reply("<p>$9</p>") }));
  seedWatchBaseline(db, "solo-tool", first, NOW);
  const changed = await researchForWatch(db, "solo-tool", { now: NOW, fetcher: fetcherFor({ "https://example.com/pricing": () => reply("<p>$12</p>") }) });
  assert.ok(!("error" in changed));
  if ("error" in changed) return;
  assert.equal(changed.delta.pageChanged, true);
  assert.equal(changed.delta.newStableTag, false);
  const unchanged = await researchForWatch(db, "solo-tool", { now: NOW, fetcher: fetcherFor({ "https://example.com/pricing": () => reply("<p>$9</p>") }) });
  assert.ok(!("error" in unchanged) && unchanged.delta.pageChanged === false);
  db.close();
});

test("the Update action for a watched competitor reads the source and queues research", async () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity({ kind: "page", url: "https://example.com/changes" }, { baseline: { version: "1.0.0", commit: null, at: NOW, source: "analysis" } })]);
  const run = startPullingRun(db, "solo-tool", NOW);
  await runWatchUpdate(db, run.id, { now: NOW, fetcher: fetcherFor({ "https://example.com/changes": () => reply("<p>Version 1.1.0</p>") }) });
  const [queued] = listCompetitorRuns(db, ["queued"], NOW);
  assert.equal(queued?.id, run.id);
  assert.equal(queued?.toVersion, "1.1.0");
  assert.equal(queued?.trigger, "manual");
  assert.equal(listCompetitors(db, NOW)[0]?.latest.version, "1.1.0");
  assert.equal(listCompetitors(db, NOW)[0]?.status, "new");
  db.close();
});

test("the Update action records a failure when the source cannot be read", async () => {
  const db = openCatalog(":memory:");
  syncCompetitors(db, [identity({ kind: "page", url: "https://example.com/changes" })]);
  const run = startPullingRun(db, "solo-tool", NOW);
  await runWatchUpdate(db, run.id, { now: NOW, fetcher: fetcherFor({ "https://example.com/changes": () => reply("gone", 404) }) });
  const [failed] = listCompetitorRuns(db, ["failed"], NOW);
  assert.equal(failed?.error, "the watch address answered 404");
  db.close();
});
