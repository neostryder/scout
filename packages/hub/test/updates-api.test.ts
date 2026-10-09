import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { openCatalog, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { createHub } from "../src/server.ts";

test("the loopback updates route parses filters and returns rows, counts and facets", async () => {
  const db = openCatalog(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "scout-updates-"));
  const server = createHub({ db, webRoot: dir });
  try {
    upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
    recordScan(db, "mini", { sourceKind: "brew", location: "/b", status: "ok", installs: [
      { ecosystem: "brew", key: "alpha", name: "Alpha", kind: "package", version: "1.0", location: "/b/alpha" },
      { ecosystem: "brew", key: "beta", name: "Beta", kind: "package", version: "1.0", location: "/b/beta" },
    ] }, "2026-09-30T00:00:00Z");
    for (const [key, version] of [["alpha", "2.0"], ["beta", "1.0"]] as const) {
      const id = (db.prepare("SELECT id FROM packages WHERE key = ?").get(key) as { id: number }).id;
      recordResearch(db, id, "brew-api", "ok", [{ channel: "stable", version, installable: true }], null, "2026-09-30T00:00:00Z");
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const get = (path: string): Promise<{ status: number; body: { total: number; updatable: number; rows: { name: string; job: null }[]; facets: Record<string, { value: string; count: number }[]> } }> => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let raw = "";
        res.on("data", (part) => raw += part);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      });
      req.on("error", reject);
      req.end();
    });
    const result = await get("/api/updates?q=alpha&sort=unknown&limit=9999");
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.total, result.body.updatable, result.body.rows[0]?.name, result.body.rows[0]?.job], [1, 1, "Alpha", null]);
    assert.deepEqual(result.body.facets.machine, [{ value: "mini", count: 1 }]);
    assert.equal((await get("/api/updates?status=current")).body.rows[0]?.name, "Beta");
    assert.equal((await get("/api/summary")).body.updatable, 1);
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
