import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, queryUpdates, recordResearch, recordScan, upsertMachine } from "../src/index.ts";

const NOW = "2026-10-18T12:00:00.000Z";
const STATUSES = ["updatable", "blocked", "upstream", "advisory", "current"] as const;

test("queryUpdates returns a status for a model install whose versions are revision hashes", () => {
  const db = openCatalog(":memory:");
  try {
    upsertMachine(db, { id: "host", name: "Host", os: "windows", kind: "host" });
    recordScan(db, "host", { sourceKind: "cogmodels", location: "", status: "ok", installs: [
      { ecosystem: "model", key: "hf:owner/plain", name: "Plain", kind: "model", version: "abcdefabcdef", location: "/models/plain" },
      { ecosystem: "model", key: "hf:owner/digits", name: "Digits", kind: "model", version: "0123456789ab", location: "/models/digits" },
    ] }, NOW);
    const packages = db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[];
    for (const pkg of packages) {
      const version = pkg.key.endsWith("/plain") ? "bbbbbbbbbbbb" : "999999999999";
      recordResearch(db, pkg.id, "huggingface", "ok", [{ channel: "unknown", version, installable: false }], null, NOW);
    }
    queryUpdates(db, { sort: "installed" });
    queryUpdates(db, { sort: "available" });
    const rows = queryUpdates(db, { status: [...STATUSES], sort: "installed" }).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.ecosystem, "model");
      assert.equal(row.installed?.length, 12);
      assert.deepEqual(row.statuses, ["current"]);
    }
  } finally { db.close(); }
});
