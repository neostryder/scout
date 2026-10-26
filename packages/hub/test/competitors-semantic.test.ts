import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openCatalog, syncCompetitors } from "@scout/core";
import { createHub } from "../src/server.ts";
import type { SemanticRanker } from "../src/competitors-api.ts";

async function serve(t: TestContext, semantic?: SemanticRanker) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  syncCompetitors(db, [{ id: "alpha", name: "Alpha", org: "Wolf", remoteUrl: null, mirrorPath: null, packageUrl: null, dossierDir: null, dossierReviewed: null, flags: ["atlas"], baseline: null }]);
  const server = createHub({ db, webRoot: t.name, control: false, health: false, ...(semantic ? { semantic } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const port = (server.address() as AddressInfo).port;
  return (body: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/competitors/semantic", method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the meaning route hands the ranker the list and returns its ids", async (t) => {
  let seen: { query: string; items: unknown[] } | null = null;
  const post = await serve(t, async (query, items) => { seen = { query, items }; return ["alpha"]; });
  const answer = await post(JSON.stringify({ query: "map helper" }));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { ids: ["alpha"] });
  assert.deepEqual(seen, { query: "map helper", items: [{ id: "alpha", name: "Alpha", org: "Wolf", products: ["atlas"], about: null }] });
});

test("the meaning route refuses a bad query and reports a failed model as 502", async (t) => {
  const post = await serve(t, async () => { throw new Error("MiniMax answered 500"); });
  assert.equal((await post(JSON.stringify({ query: "" }))).status, 400);
  assert.equal((await post(JSON.stringify({ query: "x".repeat(201) }))).status, 400);
  assert.equal((await post(JSON.stringify({ query: "a", extra: 1 }))).status, 400);
  const failed = await post(JSON.stringify({ query: "map helper" }));
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /similar-meaning search failed: MiniMax answered 500/);
});

test("without a ranker the meaning route answers 404", async (t) => {
  const post = await serve(t);
  assert.equal((await post(JSON.stringify({ query: "map helper" }))).status, 404);
});
