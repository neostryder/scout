import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openCatalog, recordScan, upsertMachine } from "@scout/core";
import { filterFromQuery } from "../src/api.ts";
import { createHub } from "../src/server.ts";

const db = openCatalog(":memory:");
upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
recordScan(db, "mini", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: [
  { ecosystem: "brew", key: "alpha", name: "Alpha", kind: "package", version: "2.0", location: "/a", publisher: "Acme", description: "An app", homepage: "https://example.com", details: { scope: "user" } },
  { ecosystem: "brew", key: "beta", name: "Beta", kind: "package", version: null, location: "/b", details: { scope: "machine" } },
] }, "2026-09-29T12:00:00.000Z");
const root = mkdtempSync(join(tmpdir(), "scout-catalog-api-"));
const server = createHub({ db, webRoot: root });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
after(() => { server.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (part) => (body += part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("catalog parameters trim lists, validate dates, and clamp paging", () => {
  const f = filterFromQuery(new URLSearchParams("publisher=Acme,%20Bravo%20&scope=user,invalid&sort=unknown&dir=bad&seenSince=wrong&limit=9999&offset=-4"));
  assert.deepEqual(f.publishers, ["Acme", "Bravo"]);
  assert.deepEqual(f.scopes, ["user"]);
  assert.equal(f.sort, undefined);
  assert.equal(f.dir, undefined);
  assert.equal(f.seenSince, undefined);
  assert.equal(f.limit, 500);
  assert.equal(f.offset, 0);
  assert.equal(filterFromQuery(new URLSearchParams("hasHomepage=0&versionKnown=1&constrained=1&dir=desc")).hasHomepage, false);
});

test("the loopback installs route filters, sorts, pages, and returns added facets", async () => {
  const response = await get("/api/installs?publisher=Acme&scope=user&sort=version&dir=desc&limit=1");
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as { total: number; rows: { name: string; ecosystem: string; publisher: string; firstSeen: string; lastSeen: string; useCount: number | null }[]; facets: Record<string, { value: string; count: number }[]> };
  assert.equal(body.total, 1);
  assert.equal(body.rows[0]?.name, "Alpha");
  assert.equal(body.rows[0]?.ecosystem, "brew");
  assert.equal(body.rows[0]?.publisher, "Acme");
  assert.equal(body.rows[0]?.firstSeen, "2026-09-29T12:00:00.000Z");
  assert.equal(body.rows[0]?.lastSeen, "2026-09-29T12:00:00.000Z");
  assert.equal(body.rows[0]?.useCount, null);
  for (const key of ["ecosystem", "publisher", "scope", "descriptionSource"]) assert.ok(Array.isArray(body.facets[key]), key);
  assert.deepEqual(body.facets.publisher?.map((x) => x.value), ["Acme"]);
  const publisherFacet = JSON.parse((await get("/api/installs?publisher=Acme")).body) as { facets: { publisher: { value: string }[] } };
  assert.ok(publisherFacet.facets.publisher.some((x) => x.value === "(none)"));
  const page = JSON.parse((await get("/api/installs?sort=version&dir=desc&limit=1&offset=1")).body) as { rows: { name: string }[] };
  assert.equal(page.rows[0]?.name, "Beta");
});
