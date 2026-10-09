import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { openCatalog, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { RESEARCHERS, runResearch, vendor, WEEKLY, type Fetcher, type Researched, type ResearchTarget } from "../src/index.ts";
import { vendorEvidence, vendorVersion } from "../src/vendor.ts";
import { fetchPublicPage } from "../src/fetch.ts";

const NOW = new Date("2026-09-30T06:00:00.000Z");
const target: ResearchTarget = { id: 1, ecosystem: "binary", key: "tool", name: "Tool", tap: null, homepage: "https://example.test/tool", details: {} };
const directory = new URL("../../../fixtures/research/vendor/", import.meta.url);
const fixture = (file: string): { url: string; status: number; body: string; target: ResearchTarget; expected: Researched } => JSON.parse(readFileSync(new URL(file, directory), "utf8"));

for (const file of readdirSync(directory)) {
  test(`research2 vendor parses ${file}`, () => {
    const f = fixture(file);
    assert.equal(vendor.url(f.target), f.url);
    assert.deepEqual(vendor.parse(f.status, f.body, f.target), f.expected);
  });
}

function seed(count = 1) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "macos", kind: "host" });
  recordScan(db, "test", { sourceKind: "binary", location: "", status: "ok", installs: Array.from({ length: count }, (_, index) => ({ ecosystem: "binary", key: `tool${index}`, name: `Tool ${index}`, kind: "binary", version: "1.0.0", location: `/test/tool${index}`, homepage: `https://example.test/tool${index}` })) }, NOW.toISOString());
  return db;
}

test("research2 vendor validates versions, ignores remote scripts and requires nearby release text", () => {
  for (const value of ["", "latest", "2", "1.2.3.4.5", "2.0.0\ntext", "2.0.0/evil", "vnext", null]) assert.equal(vendorVersion(value), null);
  assert.equal(vendorVersion(" v2.0.0-rc.1+build.4 "), "2.0.0-rc.1+build.4");
  assert.deepEqual(vendorEvidence(`<p>Download ${"x".repeat(201)} Version 2.0.0</p>`).versions, []);
  assert.deepEqual(vendorEvidence("<p>Current v2.0.0</p><p>Version 2.0.0</p>").versions, ["2.0.0"]);
  assert.deepEqual(vendorEvidence('<meta name="version" content="&#50;.0.0">').versions, ["2.0.0"]);
  assert.deepEqual(vendorEvidence('<script type="application/ld+json">broken</script><p>latest Version 2.0.0</p>').versions, ["2.0.0"]);
  assert.deepEqual(vendorEvidence("<script>Download v99.0.0").versions, []);
  assert.equal(vendorEvidence("x".repeat(8000)).text.length, 6000);
  for (const homepage of [null, "broken", "http://example.test", "https://user:pass@example.test", "file:///test"]) assert.equal(vendor.url({ ...target, homepage }), null);
  assert.equal(vendor.parse(404, "", target).status, "notfound");
  assert.equal(vendor.parse(503, "", target).status, "failed");
  assert.equal(RESEARCHERS.at(-1)?.source, "vendor");
  assert.equal(vendor.ttlMs, WEEKLY);
});

test("research2 vendor skips packages with any other catalog answer, even on forced refresh", async () => {
  const db = seed(3);
  const asked: string[] = [];
  try {
    recordResearch(db, 1, "github", "ok", [{ channel: "beta", version: "3.0.0", installable: false }], null, NOW.toISOString());
    recordResearch(db, 2, "endoflife", "ok", [{ channel: "stable", version: "2.0.0", installable: false, advisory: true }], null, NOW.toISOString());
    const [summary] = await runResearch(db, [vendor], { fetch: async (url, init) => {
      asked.push(url);
      assert.equal(init.headers["user-agent"], "Scout");
      assert.equal(init.redirect, "manual");
      return { status: 200, text: async () => fixture("download.json").body };
    }, force: true, now: NOW });
    assert.deepEqual(asked, ["https://example.test/tool2"]);
    assert.equal(summary?.skipped, 2);
    assert.equal(summary?.answers, 1);
    assert.deepEqual({ ...db.prepare("SELECT advisory, installable FROM assertions WHERE source = 'vendor'").get() }, { advisory: 1, installable: 0 });
  } finally { db.close(); }
});

test("research2 vendor caches answers and misses for a week and failures for an hour", async () => {
  const db = seed(3);
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    if (url.endsWith("tool2")) throw new Error("fixture failure");
    return { status: 200, text: async () => fixture(url.endsWith("tool0") ? "download.json" : "none.json").body };
  };
  try {
    const [summary] = await runResearch(db, [vendor], { fetch: fetcher, now: NOW });
    assert.deepEqual(summary, { source: "vendor", asked: 3, ok: 2, notfound: 0, failed: 1, skipped: 0, answers: 1 });
    asked.length = 0;
    await runResearch(db, [vendor], { fetch: fetcher, now: new Date(NOW.getTime() + 3_600_000 - 1) });
    assert.deepEqual(asked, []);
    await runResearch(db, [vendor], { fetch: fetcher, now: new Date(NOW.getTime() + 3_600_000) });
    assert.deepEqual(asked, ["https://example.test/tool2"]);
    asked.length = 0;
    await runResearch(db, [vendor], { fetch: fetcher, now: new Date(NOW.getTime() + WEEKLY) });
    assert.equal(asked.length, 3);
  } finally { db.close(); }
});

test("research2 vendor requests and extractor calls wait for their turn", async () => {
  const db = seed(5);
  let active = 0;
  let maximum = 0;
  try {
    const [summary] = await runResearch(db, [vendor], { now: NOW, concurrency: 4, fetch: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { status: 200, text: async () => fixture("none.json").body };
    }, extractVersion: async (page) => {
      assert.deepEqual(Object.keys(page).sort(), ["name", "text", "url"]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return "v2.0.0";
    } });
    assert.equal(maximum, 1);
    assert.equal(active, 0);
    assert.equal(summary?.answers, 5);
  } finally { db.close(); }
});

test("research2 vendor extractor runs only for readable pages with no deterministic candidate", async () => {
  const pages = [fixture("jsonld.json").body, fixture("competing.json").body, "<script>latest v99.0.0</script><style>x</style>", `<script>private script</script><p>${"x".repeat(7000)}</p>`, fixture("none.json").body, fixture("none.json").body];
  const db = seed(pages.length);
  let extractions = 0;
  try {
    const [summary] = await runResearch(db, [vendor], { now: NOW, fetch: async (url) => ({ status: url.endsWith("tool5") ? 404 : 200, text: async () => pages[Number(url.at(-1))] ?? "" }), extractVersion: async (page) => {
      extractions++;
      assert.ok(!page.text.includes("private script"));
      assert.ok(!page.text.includes("<p>"));
      if (page.url.endsWith("tool3")) { assert.equal(page.text.length, 6000); return "2.5.0"; }
      return "latest";
    } });
    assert.equal(extractions, 2);
    assert.equal(summary?.answers, 2);
    assert.equal(summary?.notfound, 1);
  } finally { db.close(); }
});

test("research2 public fetching rejects oversized bodies and HTTP redirects without another request", async () => {
  let calls = 0;
  const redirect: Fetcher = async () => { calls++; return { status: 302, headers: { get: (key) => key === "location" ? "http://example.test/downgrade" : null }, text: async () => "" }; };
  await assert.rejects(fetchPublicPage(redirect, "https://example.test", 1000), /requires https/);
  assert.equal(calls, 1);
  await assert.rejects(fetchPublicPage(async () => ({ status: 200, text: async () => "x".repeat(1_048_577) }), "https://example.test", 1000), /too large/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchPublicPage(async () => ({ status: 200, body, text: async () => { throw new Error("the stream must be read"); } }), "https://example.test", 1000), /too large/);
  assert.equal(cancelled, true);
  await assert.rejects(fetchPublicPage(async () => ({ status: 200, url: "http://example.test", text: async () => "" }), "https://example.test", 1000), /requires https/);
});

test("research2 public fetching refuses IP literals and local names, including through a redirect", async () => {
  let calls = 0;
  for (const location of ["https://127.0.0.1/admin", "https://localhost/admin", "https://[::1]/admin", "https://192.168.1.1/"]) {
    calls = 0;
    const redirect: Fetcher = async () => { calls++; return { status: 302, headers: { get: (key) => key === "location" ? location : null }, text: async () => "" }; };
    await assert.rejects(fetchPublicPage(redirect, "https://example.test", 1000), /public address/);
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchPublicPage(async () => ({ status: 200, text: async () => "" }), "https://10.0.0.5/", 1000), /public address/);
});

test("research2 public fetching follows HTTPS redirects and caps announced and streamed bodies", async () => {
  const asked: string[] = [];
  const page = await fetchPublicPage(async (url) => {
    asked.push(url);
    return url.endsWith("/first") ? { status: 302, headers: { get: (name) => name === "location" ? "/next" : null }, text: async () => "" } : { status: 200, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("page")); controller.close(); } }), text: async () => "" };
  }, "https://example.test/first", 1000);
  assert.deepEqual(asked, ["https://example.test/first", "https://example.test/next"]);
  assert.deepEqual(page, { status: 200, body: "page" });
  let read = false;
  await assert.rejects(fetchPublicPage(async () => ({ status: 200, headers: { get: (name) => name === "content-length" ? "1048577" : null }, text: async () => { read = true; return ""; } }), "https://example.test", 1000), /too large/);
  assert.equal(read, false);
});
