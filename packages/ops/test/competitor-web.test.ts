import { test } from "node:test";
import assert from "node:assert/strict";
import type { CandidateSource } from "@scout/core";
import { excerpt, firecrawlScraper, gatherWeb, githubRepoFrom, nameFromTitle, webKey, type Scrape } from "../src/index.ts";

const reply = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body });

test("a page is read through the first FireCrawl address that answers, and that address is tried first next time", async () => {
  const asked: string[] = [];
  const scrape = firecrawlScraper({
    bases: ["http://one:3002/", "http://two:3002"],
    post: (url, init) => {
      asked.push(url);
      assert.deepEqual(JSON.parse(init.body), { url: "https://example.com/a", formats: ["markdown"], onlyMainContent: true });
      return url.startsWith("http://one") ? reply({}, false, 503) : reply({ success: true, data: { markdown: "# Hi", links: ["https://x.test/"], metadata: { title: "Mapper | Site", description: "Maps." } } });
    },
  });
  const read = await scrape("https://example.com/a", "markdown");
  assert.deepEqual(read, { title: "Mapper | Site", description: "Maps.", markdown: "# Hi", links: ["https://x.test/"] });
  await scrape("https://example.com/a", "markdown");
  assert.deepEqual(asked, ["http://one:3002/v1/scrape", "http://two:3002/v1/scrape", "http://two:3002/v1/scrape"]);
});

test("when no address can read the page the last reason is thrown", async () => {
  const scrape = firecrawlScraper({ bases: ["http://one:3002"], post: () => reply({ success: false }) });
  await assert.rejects(() => scrape("https://example.com", "links"), /could not read https:\/\/example.com/);
  await assert.rejects(() => firecrawlScraper({ bases: [], post: () => reply({}) })("https://example.com", "links"), /no address/);
});

test("keys, names, and excerpts are plain and stable", () => {
  assert.equal(webKey("https://www.Example.com/Games/Mapper/?utm=1#top"), "web:example.com/games/mapper");
  assert.equal(webKey("ftp://example.com/x"), null);
  assert.equal(nameFromTitle("Mapper | Foundry Virtual Tabletop", "x"), "Mapper");
  assert.equal(nameFromTitle("Top games tagged angband - itch.io", "x"), "Top games tagged angband");
  assert.equal(nameFromTitle("", "example.com"), "example.com");
  assert.equal(excerpt("# Title\n\n![logo](a.png) A **bold** [link](https://x.test) here. https://y.test/z"), "Title A bold link here.");
  assert.equal(excerpt("word ".repeat(400)).length <= 800, true);
});

const facts = (key: string): CandidateSource => ({ key, source: "github", name: key.split("/")[1] ?? key, org: "o", url: `https://github.com/${key.slice(7)}`, repoUrl: `https://github.com/${key.slice(7)}.git`, description: "d", topics: [], stars: 1, pushedAt: null });

test("links into GitHub become repository candidates and other sites become page candidates, skipping noise and what is known", async () => {
  const listing = [
    "https://foundryvtt.com/community/someone", "https://github.com/acme/mapper/tree/main", "https://github.com/acme/mapper/releases", "https://github.com/sponsors/acme",
    "https://github.com/known/thing", "https://www.patreon.com/mapperguy", "https://discord.gg/abc", "https://cdn.example.com/module.json", "https://mapper.example.com/",
    "https://mapper.example.com/?ref=1", "https://foundryvtt.com/packages/tag/audio",
  ];
  const scraped: string[] = [];
  const scrape: Scrape = async (url, want) => {
    scraped.push(`${want} ${url}`);
    if (want === "links") return { title: "", description: "", markdown: "", links: listing };
    return { title: `Name of ${new URL(url).hostname} | Patreon`, description: "A thing for game masters.", markdown: "Some text about maps.", links: [] };
  };
  const lookedUp: string[] = [];
  const found = await gatherWeb({ firecrawl: ["x"], perRun: 10, pages: [{ url: "https://foundryvtt.com/packages/tag/ai-tools", pattern: null, limit: 10 }] },
    { scrape, repoOf: githubRepoFrom, lookupRepo: async (repo) => { lookedUp.push(repo); return facts(`github:${repo.slice("https://github.com/".length).toLowerCase()}`); } },
    new Set(["github:known/thing"]));
  assert.deepEqual(lookedUp, ["https://github.com/acme/mapper"]);
  assert.deepEqual(found.map((item) => item.key).sort(), ["github:acme/mapper", "web:mapper.example.com", "web:patreon.com/mapperguy"]);
  const page = found.find((item) => item.key === "web:patreon.com/mapperguy")!;
  assert.deepEqual({ source: page.source, name: page.name, org: page.org, repoUrl: page.repoUrl }, { source: "web", name: "Name of www.patreon.com", org: "patreon.com", repoUrl: null });
  assert.equal(page.description, "A thing for game masters. Some text about maps.");
  assert.deepEqual(scraped.filter((line) => line.startsWith("markdown")).length, 2);
});

test("a pattern limits which links count, a limit caps them, and a failing page or pattern is logged and skipped", async () => {
  const log: string[] = [];
  const scrape: Scrape = async (url, want) => {
    if (url === "https://down.test/") throw new Error("offline");
    return want === "links" ? { title: "", description: "", markdown: "", links: ["https://a.itch.io/one", "https://b.itch.io/two", "https://c.itch.io/three", "https://other.test/x"] } : { title: "T", description: "d", markdown: "", links: [] };
  };
  const found = await gatherWeb({ firecrawl: ["x"], perRun: 10, pages: [
    { url: "https://down.test/", pattern: null, limit: 5 },
    { url: "https://bad.test/", pattern: "(", limit: 5 },
    { url: "https://itch.io/games/tag-angband", pattern: "itch\\.io/", limit: 2 },
  ] }, { scrape, repoOf: githubRepoFrom, lookupRepo: async () => null }, new Set(), (line) => log.push(line));
  assert.deepEqual(found.map((item) => item.key), ["web:a.itch.io/one", "web:b.itch.io/two"]);
  assert.equal(log.length, 2);
  assert.match(log[0] ?? "", /could not read https:\/\/down.test\/: offline/);
  assert.match(log[1] ?? "", /not a valid expression/);
});
