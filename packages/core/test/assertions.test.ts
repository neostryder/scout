import { test } from "node:test";
import assert from "node:assert/strict";
import { currentAssertions, deriveScanAssertions, openCatalog, packagesDue, recordResearch, recordScan, updatesView, upsertMachine, type Db } from "../src/index.ts";

const T = "2026-09-30T00:00:00Z";
const LATER = "2026-09-30T06:00:00Z";

function seed(): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const brew = (name: string, version: string, pinned = false) => ({ ecosystem: "brew", key: name, name, kind: "package" as const, version, location: `/b/${name}`, details: { tap: "homebrew/core", pinned } });
  recordScan(db, "mini", { sourceKind: "brew", location: "/b", status: "ok", installs: [brew("git", "2.55.0"), brew("node", "24.1.0"), brew("wget", "1.25.0", true), brew("jq", "1.8.1")] }, T);
  const w = (key: string, name: string, version: string, availableVersion: string | null) => ({ ecosystem: "winget", key, name, kind: "package" as const, version, location: "", details: { updateAvailable: availableVersion !== null, availableVersion } });
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [w("7zip.7zip", "7-Zip", "26.01", "26.03"), w("Git.Git", "Git", "2.55.0", null)] }, T);
  return db;
}

const id = (db: Db, key: string): number => (db.prepare("SELECT id FROM packages WHERE key = ?").get(key) as { id: number }).id;

test("a researcher's answer makes an older install updatable, and an equal one not", () => {
  const db = seed();
  recordResearch(db, id(db, "git"), "brew-api", "ok", [{ channel: "stable", version: "2.56.0", installable: true }], null, T);
  recordResearch(db, id(db, "node"), "brew-api", "ok", [{ channel: "stable", version: "24.1.0", installable: true }], null, T);
  const rows = updatesView(db);
  assert.deepEqual(rows.map((r) => [r.name, r.installed, r.available, r.updatable]), [["git", "2.55.0", "2.56.0", true], ["node", "24.1.0", "24.1.0", false]]);
  assert.deepEqual(updatesView(db, { onlyOutdated: true }).map((r) => r.name), ["git"]);
});

test("the newest answer per source wins and the older one stays as history", () => {
  const db = seed();
  const git = id(db, "git");
  recordResearch(db, git, "brew-api", "ok", [{ channel: "stable", version: "2.56.0", installable: true }], null, T);
  recordResearch(db, git, "brew-api", "ok", [{ channel: "stable", version: "2.57.0", installable: true }], null, LATER);
  recordResearch(db, git, "brew-api", "ok", [{ channel: "stable", version: "2.57.0", installable: true }], null, LATER); // same answer again refreshes, never duplicates
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM assertions WHERE package_id = ?").get(git) as { n: number }).n, 2);
  assert.deepEqual(currentAssertions(db).map((a) => a.version), ["2.57.0"]);
});

test("a pinned install is blocked with the reason, not offered", () => {
  const db = seed();
  db.prepare("INSERT INTO constraints (install_id, package_id, type, hard, spec, origin, detail_json, observed_at) VALUES (NULL, ?, 'freeze', 1, '1.25.0', 'brew pin', '{}', ?)").run(id(db, "wget"), T);
  recordResearch(db, id(db, "wget"), "brew-api", "ok", [{ channel: "stable", version: "1.26.0", installable: true }], null, T);
  const [row] = updatesView(db);
  assert.equal(row?.updatable, false);
  assert.equal(row?.blockedBy, "freeze at 1.25.0 (brew pin)");
  assert.deepEqual(updatesView(db, { onlyOutdated: true }).map((r) => r.name), ["wget"]);
});

test("an upstream answer ahead of the owning source is shown apart, and never makes an install updatable", () => {
  const db = seed();
  const jq = id(db, "jq");
  recordResearch(db, jq, "brew-api", "ok", [{ channel: "stable", version: "1.8.1", installable: true }], null, T);
  recordResearch(db, jq, "github", "ok", [{ channel: "stable", version: "1.9.0", installable: false }, { channel: "beta", version: "1.10.0-rc1", installable: false }], null, T);
  const [row] = updatesView(db);
  assert.deepEqual([row?.available, row?.upstream, row?.upstreamSource, row?.beta, row?.updatable], ["1.8.1", "1.9.0", "github", "1.10.0-rc1", false]);
});

test("a vendor-page answer is advisory and never updatable", () => {
  const db = seed();
  recordResearch(db, id(db, "node"), "vendor", "ok", [{ channel: "stable", version: "25.0.0", installable: false, advisory: true }], null, T);
  const [row] = updatesView(db);
  assert.deepEqual([row?.updatable, row?.advisoryOnly, row?.available], [false, true, null]);
});

test("winget's own available version becomes an installable answer and is rebuilt on each scan", () => {
  const db = seed();
  assert.equal(deriveScanAssertions(db, T).assertions, 1);
  const [row] = updatesView(db);
  assert.deepEqual([row?.name, row?.installed, row?.available, row?.availableSource, row?.updatable], ["7-Zip", "26.01", "26.03", "winget-scan", true]);
  db.prepare("UPDATE installs SET details_json = json_set(details_json, '$.availableVersion', NULL) WHERE package_id = ?").run(id(db, "7zip.7zip"));
  assert.equal(deriveScanAssertions(db, LATER).assertions, 0);
  assert.equal(updatesView(db).length, 0);
});

test("packages are due when never checked or checked before the cache lapsed", () => {
  const db = seed();
  const now = new Date(LATER);
  const hour = 3600_000;
  assert.equal(packagesDue(db, ["brew"], "brew-api", 24 * hour, now).length, 4);
  recordResearch(db, id(db, "git"), "brew-api", "ok", [], null, T); // 6 hours old
  recordResearch(db, id(db, "node"), "brew-api", "notfound", [], "no such formula", T);
  assert.deepEqual(packagesDue(db, ["brew"], "brew-api", 24 * hour, now).map((p) => p.key), ["wget", "jq"]);
  assert.deepEqual(packagesDue(db, ["brew"], "brew-api", 1 * hour, now).map((p) => p.key), ["git", "node", "wget", "jq"]);
  assert.equal(packagesDue(db, ["brew"], "brew-api", 24 * hour, now)[0]?.tap, "homebrew/core");
});
