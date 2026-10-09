import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { filterName as storeName, SAVED_FILTER_PARAMS } from "../../core/src/saved-filters.ts";
import { createMockHub } from "../dev/mock-hub.ts";

const { filterName, filterQuery, matchesFilter, FILTER_PARAMS } = await import(new URL("../public/filters.js", import.meta.url).href);

test("the page retains query values and excludes pagination, view and unsupported parameters", () => {
  const query = new URLSearchParams("view=catalog&q=editor+tools&machine=hub,mini&sort=lastUsed&dir=desc&limit=100&offset=200&unknown=x&path=C%3A%2FTools&status=blocked");
  assert.deepEqual(filterQuery("catalog", query), { q: "editor tools", machine: "hub,mini", sort: "lastUsed", dir: "desc", path: "C:/Tools" });
  assert.deepEqual(filterQuery("updates", query), { q: "editor tools", machine: "hub,mini", sort: "lastUsed", dir: "desc", status: "blocked" });
  for (const view of ["catalog", "updates"] as const) assert.deepEqual(FILTER_PARAMS[view], SAVED_FILTER_PARAMS[view]);
});

test("query matching ignores key order and pagination and requires exact values and keys", () => {
  const filter = { name: "Work", view: "updates", spec: { q: "Editor", machine: "hub,mini", sort: "name", dir: "asc" } };
  assert.equal(matchesFilter(filter, "updates", new URLSearchParams("dir=asc&sort=name&machine=hub,mini&q=Editor&view=updates&limit=200&offset=10")), true);
  assert.equal(matchesFilter(filter, "catalog", new URLSearchParams(filter.spec)), false);
  for (const query of ["q=editor&machine=hub,mini&sort=name&dir=asc", "q=Editor&machine=mini,hub&sort=name&dir=asc", "q=Editor&machine=hub,mini&sort=name", "q=Editor&machine=hub,mini&sort=name&dir=asc&hasBeta=1", "q=Editor+&machine=hub,mini&sort=name&dir=asc"]) {
    assert.equal(matchesFilter(filter, "updates", new URLSearchParams(query)), false);
  }
  assert.equal(matchesFilter({ view: "updates", spec: {} }, "updates", new URLSearchParams("view=updates&limit=100")), true);
  assert.equal(matchesFilter({ view: "updates", spec: {} }, "updates", new URLSearchParams("q=")), false);
  assert.equal(matchesFilter({ view: "updates", spec: { status: "" } }, "updates", new URLSearchParams("status=")), true);
});

test("inline naming follows the store rules for trimming, length and control characters", () => {
  for (const name of [" Work ", "a", "a".repeat(60), "Same name", "<Tools>"]) assert.equal(filterName(name), storeName(name));
  for (const name of ["", "   ", "a".repeat(61), "bad\n", "bad\t", "bad\u0000", "bad\u007f", "bad\u0085", null, 1]) assert.throws(() => filterName(name));
});

test("the mock serves the page modules and implements all four filter routes with view isolation", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (const path of ["/filters.js", "/saved-filters.js"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/javascript");
      await response.text();
    }
    assert.equal((await post("/api/filters", { name: "Work", view: "catalog", params: { q: "Orion", dir: "desc" } })).status, 200);
    assert.equal((await post("/api/filters", { name: "Work", view: "updates", params: { status: "blocked" } })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/filters?view=catalog`)).json(), [{ name: "Work", view: "catalog", spec: { q: "Orion", dir: "desc" } }]);
    assert.equal((await post("/api/filters/rename", { from: "Work", to: "Changed", view: "updates" })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/filters?view=updates`)).json(), [{ name: "Changed", view: "updates", spec: { status: "blocked" } }]);
    assert.equal((await post("/api/filters/delete", { name: "Changed", view: "updates" })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/filters?view=updates`)).json(), []);
    assert.equal((await post("/api/filters/delete", { name: "Work", view: "catalog" }, { origin: "https://evil.example" })).status, 403);
    const refused = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/filters`, { method: "POST", headers: { host: "evil.example", "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(refused, 421);
    assert.equal((await post("/api/filters", { name: "Invalid", view: "catalog", params: { q: 1 } })).status, 400);
  } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
});
