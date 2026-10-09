import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, decideProposal, linkIdentity, normalizeName, openCatalog, openProposals, proposeMerges, recordScan, upsertMachine, type Db } from "../src/index.ts";

const T = "2026-09-29T12:00:00Z";

function seed(): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  const r = (ecosystem: string, key: string, name: string) => ({ ecosystem, key, name, kind: "package" as const, version: "1", location: "" });
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [r("winget", "Git.Git", "Git"), r("winget", "OpenJS.NodeJS", "Node.js"), r("winget", "X.Y", "Go")] }, T);
  recordScan(db, "mini", { sourceKind: "brew", location: "/b", status: "ok", installs: [r("brew", "git", "git"), r("brew", "node", "nodejs"), r("brew", "go", "go")] }, T);
  linkIdentity(db, T);
  return db;
}

test("names normalize to letters and digits", () => {
  assert.equal(normalizeName("Node.js"), "nodejs");
  assert.equal(normalizeName("  Git-LFS "), "gitlfs");
});

test("equal normalized names across ecosystems are proposed, and very short names are not", () => {
  const db = seed();
  assert.equal(proposeMerges(db, T).proposed, 2);
  assert.deepEqual(openProposals(db).map((p) => p.names.sort().join("/")).sort(), ["Git/git", "Node.js/nodejs"]);
});

test("confirming joins the packages into one item; rejecting is remembered", () => {
  const db = seed();
  proposeMerges(db, T);
  const [git, node] = openProposals(db);
  decideProposal(db, git!.id, true, T);
  decideProposal(db, node!.id, false, T);
  const items = db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM item_links WHERE package_id IN (SELECT id FROM packages WHERE lower(name) = 'git')").get() as { n: number };
  assert.equal(items.n, 1);
  linkIdentity(db, T); // a rebuild keeps confirmed links
  const again = db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM item_links WHERE package_id IN (SELECT id FROM packages WHERE lower(name) = 'git')").get() as { n: number };
  assert.equal(again.n, 1);
  assert.equal(proposeMerges(db, T).proposed, 0);
});

test("registry names lose their version and architecture before matching", () => {
  assert.equal(baseName("7-Zip 26.01 (x64)", ["26.01"]), "7-Zip");
  assert.equal(baseName("Git", ["2.50.0"]), "Git");
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const r = (ecosystem: string, key: string, name: string) => ({ ecosystem, key, name, kind: "package" as const, version: "26.01", location: "" });
  recordScan(db, "hub", { sourceKind: "arp", location: "HKLM", status: "ok", installs: [r("arp", "HKLM/7-Zip", "7-Zip 26.01 (x64)")] }, T);
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [r("winget", "7zip.7zip", "7-Zip")] }, T);
  linkIdentity(db, T);
  assert.equal(proposeMerges(db, T).proposed, 1);
  assert.equal(openProposals(db)[0]?.rule, "equal name after removing version and architecture");
});
