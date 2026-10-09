import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { openCatalog, recordResearch, recordScan, upsertMachine, type PriorityPart } from "@scout/core";
import { createHub } from "../src/server.ts";

test("the loopback updates route defaults to priority for default statuses and accepts explicit directions", async () => {
  const db = openCatalog(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "scout-priority-api-"));
  const server = createHub({ db, webRoot: dir });
  const T = "2026-09-30T00:00:00.000Z";
  try {
    for (const machine of ["a", "b"]) {
      upsertMachine(db, { id: machine, name: machine, os: "macos", kind: "host" });
      recordScan(db, machine, { sourceKind: "brew", location: "/b", status: "ok", installs: [
        { ecosystem: "brew", key: "alpha", name: "Alpha", kind: "package", version: "1.0.0", location: "/b/alpha" },
        { ecosystem: "brew", key: "zed", name: "Zed", kind: "package", version: "1.0.0", location: "/b/zed" },
        { ecosystem: "brew", key: "blocked", name: "Blocked", kind: "package", version: "1.0.0", location: "/b/blocked" },
        { ecosystem: "brew", key: "advisory", name: "Advisory", kind: "package", version: "1.0.0", location: "/b/advisory" },
        { ecosystem: "brew", key: "unknown", name: "Unknown", kind: "package", version: null, location: "/b/unknown" },
        { ecosystem: "brew", key: "current", name: "Current", kind: "package", version: "1.0.0", location: "/b/current" },
      ] }, T);
    }
    for (const row of db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[]) recordResearch(db, row.id, "test", "ok", [{ channel: "stable", version: row.key === "zed" ? "2.0.0" : row.key === "current" ? "1.0.0" : "1.0.1", installable: row.key !== "advisory" && row.key !== "unknown", advisory: row.key === "advisory" }], null, T);
    db.prepare("INSERT INTO constraints (package_id, type, hard, spec, origin, observed_at) SELECT id, 'freeze', 1, '1.0.0', 'test', ? FROM packages WHERE key = 'blocked'").run(T);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    interface Response { total: number; updatable: number; rows: { name: string; machineId: string; priority: number | null; priorityParts: PriorityPart[] }[]; facets: Record<string, { value: string; count: number }[]> }
    const get = (path: string): Promise<{ status: number; body: Response }> => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let raw = "";
        res.on("data", (part) => raw += part);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      });
      req.on("error", reject);
      req.end();
    });
    const result = await get("/api/updates");
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.total, result.body.updatable], [10, 4]);
    assert.deepEqual(result.body.rows.map((row) => [row.name, row.machineId]), [["Zed", "a"], ["Zed", "b"], ["Alpha", "a"], ["Alpha", "b"], ["Advisory", "a"], ["Advisory", "b"], ["Blocked", "a"], ["Blocked", "b"], ["Unknown", "a"], ["Unknown", "b"]]);
    assert.deepEqual((await get("/api/updates?sort=priority")).body, result.body);
    assert.deepEqual((await get("/api/updates?status=advisory,blocked,updatable,upstream")).body, result.body);
    assert.deepEqual((await get("/api/updates?sort=priority&dir=asc")).body.rows.map((row) => row.name), ["Alpha", "Alpha", "Zed", "Zed", "Advisory", "Advisory", "Blocked", "Blocked", "Unknown", "Unknown"]);
    assert.equal((await get("/api/updates?sort=name")).body.rows[0]?.name, "Advisory");
    assert.equal((await get("/api/updates?sort=invalid")).body.rows[0]?.name, "Advisory");
    assert.equal((await get("/api/updates?status=updatable")).body.rows[0]?.name, "Alpha");
    assert.equal((await get("/api/updates?status=updatable,current")).body.rows[0]?.name, "Alpha");
    assert.equal((await get("/api/updates?sort=priority&limit=1&offset=1")).body.rows[0]?.machineId, "b");
    const filtered = (await get("/api/updates?sort=priority&machine=a")).body;
    assert.equal(filtered.total, 5);
    assert.deepEqual(filtered.facets.machine, [{ value: "a", count: 5 }, { value: "b", count: 5 }]);
    for (const row of result.body.rows) {
      assert.ok(Object.hasOwn(row, "priority") && Object.hasOwn(row, "priorityParts"));
      if (row.name === "Unknown") assert.deepEqual([row.priority, row.priorityParts], [null, []]);
      if (row.name === "Blocked" || row.name === "Advisory") assert.equal(row.priority, 0);
    }
    db.prepare("INSERT INTO priority_flags (package_id, version, flags_json, source, observed_at) SELECT id, '1.0.1', '{\"security\":true}', 'fake', ? FROM packages WHERE key = 'alpha'").run(T);
    const security = (await get("/api/updates")).body.rows[0];
    assert.equal(security?.name, "Alpha");
    assert.equal(security?.priorityParts.find((part) => part.name === "security")?.value, 1);
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
