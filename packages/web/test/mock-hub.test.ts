import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHub, installs, listResponse, queryRows } from "../dev/mock-hub.ts";

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

test("mock fleet incidents include evidence and events and actions update the in-memory catalog", async (t) => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const asset of ["incidents.js", "incidents-model.js"]) assert.equal((await fetch(`${base}/${asset}`)).status, 200);
  const listing = await get("/api/fleet/incidents?limit=200");
  assert.equal(listing.incidents.length, 6);
  assert.deepEqual(new Set(listing.incidents.map((row: any) => row.host)), new Set(["eru", "bilbo", "gamemaster", "faramir", "bazzite"]));
  assert.deepEqual(new Set(listing.incidents.map((row: any) => row.state)), new Set(["open", "acknowledged", "resolved"]));
  assert.deepEqual(new Set(listing.incidents.map((row: any) => row.severity)), new Set(["critical", "warning", "info"]));
  assert.ok(listing.incidents.some((row: any) => row.muted));
  assert.ok(listing.incidents.some((row: any) => row.snoozedUntil));
  const open = await get("/api/fleet/incidents?state=open&host=eru&class=dead");
  assert.equal(open.incidents.length, 1);
  const id = open.incidents[0].id;
  const detail = await get(`/api/fleet/incidents/${id}`);
  assert.ok(detail.incident.packet.evidence.journalTail);
  assert.ok(detail.incident.packet.evidence.recentChanges.length);
  assert.ok(detail.events.some((event: any) => event.kind === "opened"));
  const post = async (action: string, body: unknown) => {
    const response = await fetch(`${base}/api/fleet/incidents/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post("snooze", { minutes: 0 })).status, 400);
  assert.equal((await post("mute", { reason: " " })).status, 400);
  assert.equal((await post("mute", { reason: "x".repeat(501) })).status, 400);
  assert.equal((await post("ack", {})).body.incident.state, "acknowledged");
  assert.equal((await post("snooze", { minutes: 240 })).status, 200);
  assert.equal((await post("mute", { reason: "Scheduled maintenance" })).body.incident.muted, true);
  assert.deepEqual((await post("investigate", {})).body, { ok: true, reference: `mock-investigation-${id}`, error: null });
  const updated = await get(`/api/fleet/incidents/${id}`);
  assert.equal(updated.incident.state, "acknowledged");
  assert.equal(updated.incident.muted, true);
  assert.ok(Date.parse(updated.incident.snoozedUntil) > Date.now() + 239 * 60_000);
  assert.ok(updated.events.some((event: any) => event.kind === "acknowledged"));
  assert.ok(updated.events.some((event: any) => event.kind === "snoozed"));
  assert.ok(updated.events.some((event: any) => event.kind === "investigate"));
  assert.deepEqual(updated.events.map((event: any) => event.at), updated.events.map((event: any) => event.at).sort());
  assert.equal((await fetch(`${base}/api/fleet/incidents/999`)).status, 404);
  assert.equal((await fetch(`${base}/api/fleet/incidents/${id}`, { method: "POST" })).status, 405);
});

test("mock fleet incidents can be unsupported and an investigator can be absent", async (t) => {
  for (const options of [{ incidentsMissing: true }, { investigatorMissing: true }]) {
    const server = createMockHub(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = options.incidentsMissing ? await fetch(`${base}/api/fleet/incidents`) : await fetch(`${base}/api/fleet/incidents/1/investigate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, options.incidentsMissing ? 404 : 501);
  }
});
