import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCategoryRules, categorize, openCatalog, recordScan, upsertMachine, type RuleInput } from "../src/index.ts";

const base: RuleInput = { ecosystem: "arp", kind: "package", name: "x", key: "x", location: "", details: {} };
const cat = (o: Partial<RuleInput>) => categorize({ ...base, ...o })?.category ?? null;

test("guests, images and runtimes are categorized by what they are", () => {
  assert.equal(cat({ ecosystem: "wsl-distro", kind: "vm" }), "virtual machine");
  assert.equal(cat({ ecosystem: "image", kind: "image" }), "container image");
  assert.equal(cat({ ecosystem: "python", kind: "runtime" }), "language runtime");
  assert.equal(cat({ ecosystem: "brew", key: "python@3.14", name: "python@3.14" }), "language runtime");
  assert.equal(cat({ ecosystem: "winget", key: "OpenJS.NodeJS", name: "Node.js" }), "language runtime");
});

test("redistributables, drivers and system components are recognized by precise patterns", () => {
  assert.equal(cat({ name: "Microsoft Visual C++ 2013 x64 Additional Runtime - 12.0.40664" }), "runtime library");
  assert.equal(cat({ name: "Microsoft .NET Runtime - 8.0.4 (x64)" }), "runtime library");
  assert.equal(cat({ name: "AMD Chipset Software" }), "driver");
  assert.equal(cat({ details: { systemComponent: true } }), "system component");
  assert.equal(cat({ ecosystem: "launchd", key: "com.apple.foo" }), "system component");
  assert.equal(cat({ ecosystem: "service", location: "C:\\Windows\\System32\\spoolsv.exe" }), "system component");
});

test("dependencies nobody asked for are libraries; requested ones are not", () => {
  assert.equal(cat({ ecosystem: "brew", key: "openssl@3", details: { onRequest: false } }), "library dependency");
  assert.equal(cat({ ecosystem: "brew", key: "git", details: { onRequest: true } }), null);
  assert.equal(cat({ ecosystem: "dpkg", key: "libssl3t64" }), "library dependency");
  assert.equal(cat({ ecosystem: "dpkg", key: "curl" }), null);
});

test("an ordinary application is left for the enrichment pass", () => {
  assert.equal(cat({ name: "Mozilla Firefox" }), null);
  assert.equal(cat({ ecosystem: "bundle", kind: "app", name: "Steam" }), null);
});

test("rules set categories in the catalog and never overwrite a generated or manual one", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "m", name: "M", os: "macos", kind: "host" });
  const T = "2026-09-29T12:00:00Z";
  recordScan(db, "m", { sourceKind: "brew", location: "/b", status: "ok", installs: [
    { ecosystem: "brew", key: "openssl@3", name: "openssl@3", kind: "package", version: "3", location: "/b/o", details: { onRequest: false } },
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "2", location: "/b/g", details: { onRequest: true } },
  ] }, T);
  db.prepare("UPDATE packages SET category = 'developer tool', category_source = 'manual' WHERE key = 'openssl@3'").run();
  assert.deepEqual({ ...applyCategoryRules(db) }, { assigned: 0 });
  db.prepare("UPDATE packages SET category = NULL, category_source = NULL WHERE key = 'openssl@3'").run();
  assert.deepEqual({ ...applyCategoryRules(db) }, { assigned: 1 });
  const row = db.prepare("SELECT category, category_source FROM packages WHERE key = 'openssl@3'").get() as { category: string; category_source: string };
  assert.deepEqual({ ...row }, { category: "library dependency", category_source: "rule" });
});
