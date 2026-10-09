import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHub } from "../dev/mock-hub.ts";
const { recipeButtons, recipeCommand, recipeCounts, recipeEventReducer, recipeFilter } = await import(new URL("../public/services-model.js", import.meta.url).href);

const recipe = (id: number, state: string) => ({ id, state, argv: ["pnpm", "run", "dev"], proposedAt: "2026-10-07T00:00:00Z", gone: false });
test("recipe display helpers render command text, filter states, count proposals and choose buttons", () => {
  const rows = [recipe(1, "proposed"), recipe(2, "approved"), recipe(3, "rejected"), recipe(4, "unsupported")];
  assert.equal(recipeCommand(rows[0]), "pnpm run dev");
  assert.deepEqual(recipeFilter(rows).map((row: any) => row.id), [1, 2]);
  assert.equal(recipeFilter(rows, "all").length, 4);
  assert.deepEqual(recipeFilter(rows, "unsupported").map((row: any) => row.id), [4]);
  assert.deepEqual(recipeCounts(rows), { proposed: 1, approved: 1, rejected: 1, unsupported: 1 });
  assert.deepEqual(rows.map(recipeButtons), [["approve", "reject"], ["start"], [], []]);
  assert.deepEqual(recipeButtons({ ...rows[1], gone: true }), []);
});
test("recipe event reduction replaces decisions, preserves rows and reflects gone state", () => {
  const rows = [recipe(1, "proposed"), recipe(2, "approved")];
  const approved = recipeEventReducer(rows, { recipe: { ...rows[0], state: "approved" }, change: "approved" });
  assert.deepEqual(approved.recipes.map((row: any) => row.id), [2, 1]);
  assert.equal(approved.counts.proposed, 0);
  assert.equal(approved.counts.approved, 2);
  const gone = recipeEventReducer(approved.recipes, { recipe: { ...rows[1], gone: true }, change: "gone" });
  assert.deepEqual(recipeButtons(gone.recipes[0]), []);
  assert.equal(recipeEventReducer(gone.recipes, {}).recipes, gone.recipes);
});

async function mock(run: (base: string) => Promise<void>, options: Parameters<typeof createMockHub>[0] = {}) {
  const server = createMockHub(options);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); }
}
test("the recipes mock serves each state and decision statuses plus recipe Start and audit states", async () => mock(async (base) => {
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const listing = (await call("/api/services/recipes")).body;
  assert.deepEqual(new Set(listing.recipes.map((row: any) => row.state)), new Set(["proposed", "approved", "rejected", "unsupported"]));
  for (const state of ["proposed", "approved", "rejected", "unsupported"]) assert.ok((await call(`/api/services/recipes?state=${state}`)).body.recipes.every((row: any) => row.state === state));
  const recipe = listing.recipes.find((row: any) => row.state === "proposed");
  const body = { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true };
  for (const [change, status] of [[{ confirm: false }, 400], [{ id: 999 }, 404], [{ hash: "a".repeat(64) }, 409], [{ id: 4, hash: listing.recipes.find((row: any) => row.id === 4).hash }, 409], [{ id: 5, hash: listing.recipes.find((row: any) => row.id === 5).hash }, 409]] as const) assert.equal((await call("/api/services/recipes/decide", { ...body, ...change })).status, status);
  assert.equal((await call("/api/services/recipes/scan", {})).status, 200);
  assert.equal((await call("/api/services/actions/plan", { target: "recipe", id: recipe.id, action: "start" })).body.plan.allowed, false);
  assert.equal((await call("/api/services/recipes/decide", body)).body.recipe.state, "approved");
  const plan = (await call("/api/services/actions/plan", { target: "recipe", id: recipe.id, action: "start" })).body.plan;
  assert.equal(plan.mechanism, "recipe");
  assert.equal(plan.command, recipe.command);
  assert.deepEqual(plan.effects, [`Runs in ${recipe.cwd}`]);
  assert.equal(plan.admin, "none");
  assert.equal(plan.graceful, true);
  assert.equal((await call("/api/services/actions/run", { planId: plan.id, token: plan.token, confirm: true })).status, 202);
  assert.equal((await call("/api/services/actions")).body.items[0].state, "running");
  await new Promise((done) => setTimeout(done, 400));
  assert.equal((await call("/api/services/actions")).body.items[0].state, "done");
  assert.equal((await call("/api/services/actions/run", { planId: plan.id, token: plan.token, confirm: true })).status, 404);
}, { runScenario: "done" }));

test("the recipes mock supports missing endpoints and no-control", async () => {
  await mock(async (base) => {
    assert.equal((await fetch(`${base}/api/services/recipes`)).status, 404);
    const res = await fetch(`${base}/api/services/recipes/scan`, { method: "POST" });
    assert.equal(res.status, 404);
  }, { recipesMissing: true });
  await mock(async (base) => {
    assert.equal((await fetch(`${base}/api/services/recipes`)).status, 200);
    assert.equal((await fetch(`${base}/api/services/recipes/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  }, { controlOff: true });
});
