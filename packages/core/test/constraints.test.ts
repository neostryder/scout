import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConstraints, openCatalog, recordScan, upsertMachine } from "../src/index.ts";

test("brew pins and exact image tags become hard constraints, and a rerun does not duplicate them", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "gm", name: "Server", os: "macos", kind: "host" });
  const T = "2026-09-29T12:00:00Z";
  recordScan(db, "gm", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: [
    { ecosystem: "brew", key: "node", name: "node", kind: "package", version: "25.8.1", location: "/x/node", details: { pinned: true } },
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "2.48", location: "/x/git", details: { pinned: false } },
  ] }, T);
  recordScan(db, "gm", { sourceKind: "image", location: "", status: "ok", installs: [
    { ecosystem: "image", key: "foundationdb/foundationdb", name: "fdb", kind: "image", version: "7.3.63", location: "/compose.yaml", details: { tagKind: "exact" } },
    { ecosystem: "image", key: "redis", name: "redis", kind: "image", version: "alpine", location: "/compose.yaml", details: { tagKind: "floating" } },
  ] }, T);
  assert.deepEqual({ ...deriveConstraints(db, T) }, { freezes: 1, gatedRanges: 1 });
  deriveConstraints(db, T);
  const rows = db.prepare("SELECT type, spec, origin, hard FROM constraints ORDER BY type").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { type: "freeze", spec: "25.8.1", origin: "brew pin", hard: 1 },
    { type: "gated_range", spec: "7.3.63", origin: "/compose.yaml", hard: 1 },
  ]);
});
