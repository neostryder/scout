import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordScan, recordUsage, upsertMachine } from "@scout/core";
import { filterFromQuery, installsResponse } from "../src/api.ts";

test("the installs API accepts the usage filter and sort and returns count fields", () => {
  const db = openCatalog(":memory:");
  const now = "2026-09-30T12:00:00.000Z";
  try {
    upsertMachine(db, { id: "synthetic", name: "Synthetic", os: "linux", kind: "host" });
    recordScan(db, "synthetic", { sourceKind: "synthetic", location: "", status: "ok", installs: [
      { ecosystem: "local", key: "git", name: "Git", kind: "binary", version: "1", location: "/tools/git" },
      { ecosystem: "local", key: "rg", name: "Ripgrep", kind: "binary", version: "1", location: "/tools/rg" },
      { ecosystem: "local", key: "unused", name: "Unused", kind: "binary", version: "1", location: "/tools/unused" },
    ] }, now);
    recordUsage(db, "synthetic", { origin: "ai-use", status: "ok", signals: [
      { match: { name: "git" }, kind: "ai_use_7d", value: "2", available: true },
      { match: { name: "git" }, kind: "ai_use_30d", value: "9", available: true },
      { match: { name: "rg" }, kind: "ai_use_7d", value: "3", available: true },
      { match: { name: "rg" }, kind: "ai_use_30d", value: "12", available: true },
    ], completeFor: ["ai_use_7d", "ai_use_30d"] }, now);
    const q = new URLSearchParams("aiUsed=1&sort=aiUse");
    assert.equal(filterFromQuery(q).aiUsed, true);
    assert.equal(filterFromQuery(q).sort, "aiUse");
    assert.equal(filterFromQuery(new URLSearchParams("ai=1")).aiUsed, true);
    const response = installsResponse(db, q) as { total: number; rows: { name: string; aiUse7: number | null; aiUse30: number | null }[] };
    assert.equal(response.total, 2);
    assert.deepEqual(response.rows.map((r) => [r.name, r.aiUse7, r.aiUse30]), [["Ripgrep", 3, 12], ["Git", 2, 9]]);
    const ascending = installsResponse(db, new URLSearchParams("aiUsed=1&sort=aiUse&dir=asc&limit=1")) as typeof response;
    assert.deepEqual(ascending.rows.map((r) => r.name), ["Git"]);
  } finally { db.close(); }
});
