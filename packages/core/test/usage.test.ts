import { test } from "node:test";
import assert from "node:assert/strict";
import { decideProposal, deriveUsage, inheritUsage, linkIdentity, openCatalog, openProposals, proposeMerges, queryInstalls, recordScan, recordUsage, upsertMachine, type Db } from "../src/index.ts";

const T = "2026-09-29T12:00:00Z";

function seed(): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "app", location: "", status: "ok", installs: [
    { ecosystem: "bundle", key: "com.a", name: "Alpha", kind: "app", version: "1", location: "/Applications/Alpha.app" },
    { ecosystem: "bundle", key: "com.b", name: "Beta", kind: "app", version: "1", location: "/Applications/Beta.app" },
    { ecosystem: "bundle", key: "com.c", name: "Gamma", kind: "app", version: "1", location: "/Applications/Gamma.app" },
  ] }, T);
  return db;
}

const lastUsed = (db: Db) => queryInstalls(db, { sort: "name" }).map((r) => `${r.name}:${r.lastUsed}`);

test("a last_used reading attaches to the install at that path, and an unmatched path is counted", () => {
  const db = seed();
  const s = recordUsage(db, "mini", { origin: "spotlight", status: "ok", signals: [
    { match: { path: "/Applications/Alpha.app" }, kind: "last_used", value: "2026-09-20T00:00:00Z", available: true },
    { match: { path: "/Applications/Beta.app" }, kind: "last_used", value: null, available: true },
    { match: { path: "/Applications/Missing.app" }, kind: "last_used", value: "2026-01-01T00:00:00Z", available: true },
  ] }, T);
  assert.deepEqual({ ...s }, { signals: 2, unmatched: 1 });
  assert.deepEqual(lastUsed(db), ["Alpha:2026-09-20T00:00:00Z", "Beta:null", "Gamma:null"]);
});

test("a process inside an app folder marks that app running; complete sources write 0 for the rest", () => {
  const db = seed();
  recordUsage(db, "mini", { origin: "processes", status: "ok", completeFor: ["running"], signals: [
    { match: { path: "/Applications/Alpha.app/Contents/MacOS/Alpha" }, kind: "running", value: "1", available: true },
    { match: { path: "/Applications/Alpha.app/Contents/Helpers/AlphaHelper" }, kind: "running", value: "1", available: true },
  ] }, T);
  assert.deepEqual(queryInstalls(db, { running: true }).map((r) => r.name), ["Alpha"]);
  const zeros = db.prepare("SELECT COUNT(*) AS n FROM usage_signals WHERE kind = 'running' AND value = '0'").get() as { n: number };
  assert.equal(zeros.n, 2);
  const alphaRows = db.prepare("SELECT COUNT(*) AS n FROM usage_signals u JOIN installs i ON i.id = u.install_id JOIN packages p ON p.id = i.package_id WHERE p.name = 'Alpha' AND u.kind = 'running'").get() as { n: number };
  assert.equal(alphaRows.n, 1);
});

test("a rerun replaces the earlier reading from the same origin", () => {
  const db = seed();
  const sig = (v: string) => ({ origin: "spotlight", status: "ok" as const, signals: [{ match: { path: "/Applications/Alpha.app" }, kind: "last_used", value: v, available: true }] });
  recordUsage(db, "mini", sig("2026-09-01T00:00:00Z"), T);
  recordUsage(db, "mini", sig("2026-09-25T00:00:00Z"), T);
  assert.deepEqual(lastUsed(db)[0], "Alpha:2026-09-25T00:00:00Z");
});

test("a failed or skipped source stores nothing", () => {
  const db = seed();
  assert.deepEqual({ ...recordUsage(db, "mini", { origin: "spotlight", status: "skipped", signals: [{ match: { path: "/Applications/Alpha.app" }, kind: "last_used", value: "x", available: true }] }, T) }, { signals: 0, unmatched: 0 });
});

test("service state, start mode, launchd run-at-load and container state become signals", () => {
  const db = seed();
  recordScan(db, "mini", { sourceKind: "services", location: "", status: "ok", installs: [
    { ecosystem: "service", key: "Svc", name: "Svc", kind: "service", version: null, location: "C:\\x.exe", details: { state: "Running", startMode: "Auto" } },
    { ecosystem: "launchd", key: "job", name: "job", kind: "service", version: null, location: "/Library/LaunchDaemons/job.plist", details: { runAtLoad: false, keepAlive: true } },
    { ecosystem: "image", key: "redis", name: "redis", kind: "image", version: "alpine", location: "/c.yaml", details: { state: "exited" } },
  ] }, T);
  deriveUsage(db, T);
  assert.deepEqual(queryInstalls(db, { running: true }).map((r) => r.name), ["Svc"]);
  assert.deepEqual(queryInstalls(db, { autostart: true }).map((r) => r.name).sort(), ["Svc", "job"]);
});

test("an install without a folder takes usage from the same software's other installs on that machine", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const r = (ecosystem: string, key: string, name: string, location: string) => ({ ecosystem, key, name, kind: "package" as const, version: "26.01", location });
  recordScan(db, "hub", { sourceKind: "registry", location: "HKLM", status: "ok", installs: [r("arp", "HKLM/7-Zip", "7-Zip 26.01 (x64)", "C:/Program Files/7-Zip")] }, T);
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [r("winget", "7zip.7zip", "7-Zip", "")] }, T);
  linkIdentity(db, T);
  proposeMerges(db, T);
  recordUsage(db, "hub", { origin: "userassist", status: "ok", signals: [
    { match: { path: "C:/Program Files/7-Zip/7zFM.exe" }, kind: "last_used", value: "2026-09-20T00:00:00Z", available: true },
    { match: { path: "C:/Program Files/7-Zip/7zFM.exe" }, kind: "use_count", value: "12", available: true },
  ] }, T);
  assert.equal(inheritUsage(db, T).signals, 0); // separate items until a person confirms the merge
  decideProposal(db, openProposals(db)[0]!.id, true, T);
  assert.equal(inheritUsage(db, T).signals, 2);
  assert.deepEqual(queryInstalls(db, { sort: "name" }).map((row) => `${row.name}:${row.lastUsed}`), ["7-Zip:2026-09-20T00:00:00Z", "7-Zip 26.01 (x64):2026-09-20T00:00:00Z"]);
  inheritUsage(db, T); // rebuilding twice leaves the same rows
  const n = db.prepare("SELECT COUNT(*) AS n FROM usage_signals WHERE origin = 'item'").get() as { n: number };
  assert.equal(n.n, 2);
});
