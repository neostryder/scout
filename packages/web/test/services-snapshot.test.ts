import { test } from "node:test";
import assert from "node:assert/strict";

const { SNAPSHOT_ROUTES, packSnapshot, unpackSnapshot, snapshotNote } = await import(new URL("../public/services-snapshot.js", import.meta.url).href);

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const machine = { id: "hub", name: "Hub", hub: true, services: { total: 3, running: 2, optionalRunning: 1 }, listeners: { total: 4 }, live: { state: "fresh", cadenceMs: 30000 } };
const raw = () => ({
  overview: { machines: [machine] },
  descriptionOverview: { total: 3 },
  edgeOverview: { reader: { state: "fresh" }, totals: { domains: 1, originDown: 0, dnsDangling: 0 } },
  routes: { reader: { state: "fresh" }, rows: [{ hostname: "a.example.test" }] },
  atlas: { rows: [{ id: 1 }] },
});

test("the routes a snapshot keeps are the ones the map is drawn from", () => {
  assert.deepEqual([...SNAPSHOT_ROUTES].sort(), ["atlas", "descriptionOverview", "edgeOverview", "overview", "routes"]);
});

test("a complete read packs and unpacks to the same reads", () => {
  const text = packSnapshot(raw(), NOW);
  const saved = unpackSnapshot(text, NOW + 60_000);
  assert.equal(saved.at, "2026-10-25T12:00:00.000Z");
  assert.deepEqual(saved.overview, raw().overview);
  assert.deepEqual(saved.routes, raw().routes);
  assert.deepEqual(saved.atlas, raw().atlas);
  assert.deepEqual(saved.edgeOverview, raw().edgeOverview);
  assert.deepEqual(saved.descriptionOverview, { total: 3 });
});

test("an incomplete read is not packed, and a missing description overview is allowed", () => {
  for (const key of ["overview", "edgeOverview", "routes", "atlas"]) {
    const partial: Record<string, unknown> = raw();
    delete partial[key];
    assert.equal(packSnapshot(partial, NOW), null, key);
  }
  assert.equal(packSnapshot({}, NOW), null);
  assert.equal(packSnapshot(undefined, NOW), null);
  const { descriptionOverview: _skipped, ...rest } = raw();
  assert.equal(unpackSnapshot(packSnapshot(rest, NOW), NOW).descriptionOverview, null);
});

test("a read too large for browser storage is not packed", () => {
  const big = raw();
  big.atlas.rows = Array.from({ length: 40_000 }, (_, id) => ({ id, name: "x".repeat(50) }));
  assert.equal(packSnapshot(big, NOW), null);
});

test("a missing, corrupt, foreign, old, future, or malformed snapshot reads as none", () => {
  assert.equal(unpackSnapshot(null, NOW), null);
  assert.equal(unpackSnapshot("", NOW), null);
  assert.equal(unpackSnapshot("{not json", NOW), null);
  assert.equal(unpackSnapshot("[]", NOW), null);
  const text = packSnapshot(raw(), NOW);
  assert.equal(unpackSnapshot(text.replace('"version":1', '"version":2'), NOW), null);
  assert.equal(unpackSnapshot(text, NOW + 8 * 86_400_000), null);
  assert.notEqual(unpackSnapshot(text, NOW + 6 * 86_400_000), null);
  assert.equal(unpackSnapshot(text, NOW - 600_000), null, "a clock that ran backwards");
  const noLive = raw();
  (noLive.overview.machines[0] as Record<string, unknown>)["live"] = null;
  assert.equal(unpackSnapshot(packSnapshot(noLive, NOW), NOW), null);
  const noServices = raw();
  delete (noServices.overview.machines[0] as Record<string, unknown>)["services"];
  assert.equal(unpackSnapshot(packSnapshot(noServices, NOW), NOW), null);
});

test("the note says how old the saved view is", () => {
  const at = "2026-10-25T12:00:00.000Z";
  assert.equal(snapshotNote(at, NOW + 20_000), "saved view from less than a minute ago, refreshing");
  assert.equal(snapshotNote(at, NOW + 4 * 60_000), "saved view from 4 min ago, refreshing");
  assert.equal(snapshotNote(at, NOW + 3 * 3_600_000), "saved view from 3 h ago, refreshing");
  assert.equal(snapshotNote(at, NOW + 2 * 86_400_000), "saved view from 2 days ago, refreshing");
});
