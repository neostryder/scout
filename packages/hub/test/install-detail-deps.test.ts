import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { changelogSummaryFor, dependentsOf, needsOf, openCatalog, recordChangelogSummary, recordDependencies, recordResearch, recordScan, recordSupportWindows, supportWindowsOf, upsertMachine } from "@scout/core";
import { installDetail } from "../src/api.ts";
import { createHub } from "../src/server.ts";

const NOW = "2026-09-30T12:00:00.000Z";

function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: [
    { ecosystem: "brew", key: "node", name: "Node", kind: "runtime", version: "26.0.0", location: "/opt/homebrew/bin/node" },
    { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "/opt/homebrew/lib/llhttp" },
    { ecosystem: "npm", key: "tool", name: "Tool", kind: "package", version: "1.0.0", location: "/opt/homebrew/bin/tool" },
  ] }, NOW);
  const ids = db.prepare("SELECT i.id, p.id AS packageId, p.key FROM installs i JOIN packages p ON p.id = i.package_id").all() as { id: number; packageId: number; key: string }[];
  const node = ids.find((row) => row.key === "node")!;
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [{ from: { ecosystem: "brew", key: "node" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "Installed keg dependency" }] }, NOW);
  recordDependencies(db, "mini", { origin: "npm-engines", status: "ok", facts: [{ from: { ecosystem: "npm", key: "tool" }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint: ">=26 <27", builtAgainst: "26.0.0", evidence: "Global runtime requirement" }] }, NOW);
  recordSupportWindows(db, node.packageId, [{ cycle: "26", eol: "2027-04-30", latest: "26.1.0", lts: true }, { cycle: "24", eol: "2026-04-30", latest: "24.0.0", lts: false }], NOW);
  for (const version of ["26.0.0", "26.1.0", "27.0.0"]) recordChangelogSummary(db, { packageId: node.packageId, version, summary: `Release ${version} changes parsing.`, sourceUrl: `https://example.test/releases/${version}`, model: "fixture-summary" }, NOW);
  return { db, node, ids };
}

test("depui install detail returns core edges, support and the installable target summary", async (t) => {
  const { db, node } = seed(t);
  recordResearch(db, node.packageId, "brew", "ok", [{ channel: "stable", version: "26.1.0", installable: true }], null, NOW);
  recordResearch(db, node.packageId, "github", "ok", [{ channel: "stable", version: "27.0.0", installable: false }], null, NOW);
  const server = createHub({ db, webRoot: process.cwd() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/installs/${node.id}`);
    assert.equal(response.status, 200);
    const detail = await response.json() as any;
    assert.deepEqual(detail.dependencies, { needs: needsOf(db, node.id), neededBy: dependentsOf(db, node.id) });
    assert.equal(detail.dependencies.needs[0].builtAgainst, "9.4.3");
    assert.equal(detail.dependencies.neededBy[0].constraint, ">=26 <27");
    assert.deepEqual(detail.supportWindows, supportWindowsOf(db, node.packageId));
    const summary = changelogSummaryFor(db, node.packageId, "26.1.0")!;
    assert.deepEqual(detail.changelog, { summary: summary.summary, sourceUrl: summary.sourceUrl, model: summary.model, createdAt: summary.createdAt });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("depui install detail uses upstream when an installable update is blocked", (t) => {
  const { db, node } = seed(t);
  recordResearch(db, node.packageId, "brew", "ok", [{ channel: "stable", version: "26.1.0", installable: true }], null, NOW);
  recordResearch(db, node.packageId, "github", "ok", [{ channel: "stable", version: "27.0.0", installable: false }], null, NOW);
  db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '26.0.0', 'test', ?)").run(node.id, NOW);
  const detail = installDetail(db, node.id) as any;
  assert.equal(detail.changelog.summary, "Release 27.0.0 changes parsing.");
});

test("depui install detail omits a summary when there is no target or no matching summary", (t) => {
  const { db, node, ids } = seed(t);
  assert.equal((installDetail(db, node.id) as any).changelog, null);
  recordResearch(db, node.packageId, "brew", "ok", [{ channel: "stable", version: "26.0.0", installable: true }], null, NOW);
  assert.equal((installDetail(db, node.id) as any).changelog, null);
  recordResearch(db, node.packageId, "github", "ok", [{ channel: "stable", version: "28.0.0", installable: false }], null, NOW);
  assert.equal((installDetail(db, node.id) as any).changelog, null);
  const tool = ids.find((row) => row.key === "tool")!;
  assert.deepEqual((installDetail(db, tool.id) as any).supportWindows, []);
  assert.deepEqual((installDetail(db, tool.id) as any).dependencies.neededBy, []);
  assert.equal(installDetail(db, 9999), null);
});
