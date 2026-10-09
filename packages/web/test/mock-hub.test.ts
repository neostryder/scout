import { test } from "node:test";
import assert from "node:assert/strict";
import { installs, listResponse, queryRows } from "../dev/mock-hub.ts";

test("update search matches every term across fields", () => {
  const q = new URLSearchParams("q=orion northstar");
  const rows = queryRows("updates", q);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.name.toLowerCase().includes("orion") && row.publisher.toLowerCase().includes("northstar")));
});

test("facet counts exclude their own filter and retain other filters", () => {
  const q = new URLSearchParams("machine=hub&category=editor");
  const data = listResponse("installs", q);
  assert.ok(data.rows.every((row) => row.machineId === "hub" && row.category === "editor"));
  assert.ok(data.facets.machine!.some((facet: { value: string }) => facet.value !== "hub"));
  assert.ok(data.facets.category!.every((facet: { count: number }) => facet.count > 0));
});

test("version sorting compares numbers and direction", () => {
  const asc = queryRows("updates", new URLSearchParams("sort=installed&dir=asc"));
  const desc = queryRows("updates", new URLSearchParams("sort=installed&dir=desc"));
  assert.ok(asc.length > 0);
  assert.equal(asc[0]!.installed, desc.at(-1)!.installed);
});

test("update filters and paging count matching rows", () => {
  const q = new URLSearchParams("status=updatable&bump=major&limit=3&offset=1");
  const data = listResponse("updates", q);
  assert.equal(data.rows.length, 3);
  assert.ok(data.rows.every((row) => row.updatable && row.bump === "major"));
  assert.ok(data.total > data.rows.length);
  assert.equal(data.updatable, data.total);
  assert.equal(installs.length, 300);
});

test("default update status omits current rows and an explicit status includes them", () => {
  const defaults = queryRows("updates", new URLSearchParams());
  assert.ok(defaults.every((row) => row.statuses.some((status: string) => status !== "current")));
  const current = queryRows("updates", new URLSearchParams("status=current"));
  assert.ok(current.length > 0);
  assert.ok(current.every((row) => row.statuses.includes("current")));
});

test("beta, upstream and usage filters combine", () => {
  const rows = queryRows("updates", new URLSearchParams("hasBeta=1&hasUpstream=1&usedWithinDays=120"));
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.beta && row.upstream && row.lastUsed && Date.parse(row.lastUsed) >= Date.now() - 120 * 86400000));
});

test("catalog dates and zero-valued flags filter independently", () => {
  const withoutHomepages = queryRows("installs", new URLSearchParams("hasHomepage=0"));
  assert.ok(withoutHomepages.length > 0);
  assert.ok(withoutHomepages.every((row) => row.homepage === null));
  const recent = queryRows("installs", new URLSearchParams("seenSince=2026-01-01"));
  assert.ok(recent.every((row) => row.lastSeen >= "2026-01-01"));
});
