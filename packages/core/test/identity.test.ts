import { test } from "node:test";
import assert from "node:assert/strict";
import { linkIdentity, openCatalog, recordScan, upsertMachine, wingetArpToRegistryKey, type Db, type InstallRecord } from "../src/index.ts";

const T = "2026-09-29T12:00:00Z";
const rec = (o: Partial<InstallRecord> & { ecosystem: string; key: string }): InstallRecord => ({ name: o.key, kind: "package", version: "1", location: "", ...o });

function itemOf(db: Db, ecosystem: string, key: string): number {
  return (db.prepare("SELECT l.item_id AS id FROM item_links l JOIN packages p ON p.id = l.package_id WHERE p.ecosystem = ? AND p.key = ?").get(ecosystem, key) as { id: number }).id;
}

const WA = "5319275A.WhatsAppDesktop_2.2637.100.0_x64__cv1g1gvanyjgm";

function hub(): Db {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordScan(db, "hub", { sourceKind: "registry", location: "", status: "ok", installs: [
    rec({ ecosystem: "arp", key: "HKLM\\Mozilla Firefox", name: "Mozilla Firefox", location: "C:\\Program Files\\Mozilla Firefox" }),
    rec({ ecosystem: "arp", key: "HKLM-WOW6432\\Old Tool", name: "Old Tool" }),
    rec({ ecosystem: "arp", key: "HKCU\\Per User", name: "Per User" }),
  ] }, T);
  recordScan(db, "hub", { sourceKind: "appx", location: "", status: "ok", installs: [
    rec({ ecosystem: "appx", key: "5319275A.WhatsAppDesktop", kind: "app", location: "C:\\Program Files\\WindowsApps\\WA", details: { packageFullName: WA } }),
  ] }, T);
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [
    rec({ ecosystem: "winget-local", key: "ARP\\Machine\\X64\\Mozilla Firefox", name: "Mozilla Firefox" }),
    rec({ ecosystem: "winget-local", key: "ARP\\Machine\\X86\\Old Tool", name: "Old Tool" }),
    rec({ ecosystem: "winget-local", key: "ARP\\User\\X64\\Per User", name: "Per User" }),
    rec({ ecosystem: "winget-local", key: "ARP\\Machine\\X64\\No Such Key", name: "No Such Key" }),
    rec({ ecosystem: "winget-local", key: `MSIX\\${WA}`, name: "WhatsApp" }),
    rec({ ecosystem: "winget", key: "Mozilla.Firefox", name: "Mozilla Firefox" }),
  ] }, T);
  recordScan(db, "hub", { sourceKind: "services", location: "", status: "ok", installs: [
    rec({ ecosystem: "service", key: "MozillaMaintenance", kind: "service", version: null, location: "C:\\Program Files\\Mozilla Firefox\\maintenanceservice.exe" }),
    rec({ ecosystem: "service", key: "Spooler", kind: "service", version: null, location: "C:\\Windows\\System32\\spoolsv.exe" }),
  ] }, T);
  return db;
}

test("winget ARP ids map to registry keys by scope and architecture", () => {
  assert.equal(wingetArpToRegistryKey("ARP\\Machine\\X64\\Foo Bar"), "HKLM\\Foo Bar");
  assert.equal(wingetArpToRegistryKey("ARP\\Machine\\X86\\Foo"), "HKLM-WOW6432\\Foo");
  assert.equal(wingetArpToRegistryKey("ARP\\User\\X64\\Foo"), "HKCU\\Foo");
  assert.equal(wingetArpToRegistryKey("MSIX\\x"), null);
  assert.equal(wingetArpToRegistryKey("Mozilla.Firefox"), null);
});

test("deterministic rules join a winget entry to its registry key and Store package", () => {
  const db = hub();
  linkIdentity(db, T);
  assert.equal(itemOf(db, "winget-local", "ARP\\Machine\\X64\\Mozilla Firefox"), itemOf(db, "arp", "HKLM\\Mozilla Firefox"));
  assert.equal(itemOf(db, "winget-local", "ARP\\Machine\\X86\\Old Tool"), itemOf(db, "arp", "HKLM-WOW6432\\Old Tool"));
  assert.equal(itemOf(db, "winget-local", "ARP\\User\\X64\\Per User"), itemOf(db, "arp", "HKCU\\Per User"));
  assert.equal(itemOf(db, "winget-local", `MSIX\\${WA}`), itemOf(db, "appx", "5319275A.WhatsAppDesktop"));
});

test("a catalog match with the same display name is not merged without a declared mapping", () => {
  const db = hub();
  linkIdentity(db, T);
  assert.notEqual(itemOf(db, "winget", "Mozilla.Firefox"), itemOf(db, "arp", "HKLM\\Mozilla Firefox"));
  assert.notEqual(itemOf(db, "winget-local", "ARP\\Machine\\X64\\No Such Key"), itemOf(db, "arp", "HKLM\\Mozilla Firefox"));
});

test("every package is in exactly one item, and rerunning changes nothing", () => {
  const db = hub();
  const a = linkIdentity(db, T);
  const b = linkIdentity(db, T);
  assert.deepEqual(a, b);
  const unlinked = db.prepare("SELECT COUNT(*) AS n FROM packages WHERE id NOT IN (SELECT package_id FROM item_links)").get() as { n: number };
  assert.equal(unlinked.n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, a.items);
});

test("a service inside an install's folder is part of it; a system service is not", () => {
  const db = hub();
  linkIdentity(db, T);
  const rows = db
    .prepare(
      "SELECT p.key AS svc, q.key AS owner, r.relation FROM install_relations r JOIN installs i ON i.id = r.install_id JOIN packages p ON p.id = i.package_id JOIN installs j ON j.id = r.related_id JOIN packages q ON q.id = j.package_id",
    )
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ svc: "MozillaMaintenance", owner: "HKLM\\Mozilla Firefox", relation: "part_of" }]);
});

test("a confirmed link survives a rebuild", () => {
  const db = hub();
  linkIdentity(db, T);
  const win = (db.prepare("SELECT id FROM packages WHERE key = 'Mozilla.Firefox'").get() as { id: number }).id;
  const item = itemOf(db, "arp", "HKLM\\Mozilla Firefox");
  db.prepare("DELETE FROM item_links WHERE package_id = ?").run(win);
  db.prepare("INSERT INTO item_links (package_id, item_id, basis, evidence_json) VALUES (?, ?, 'confirmed', '{}')").run(win, item);
  linkIdentity(db, T);
  assert.equal(itemOf(db, "winget", "Mozilla.Firefox"), item);
  assert.equal((db.prepare("SELECT basis FROM item_links WHERE package_id = ?").get(win) as { basis: string }).basis, "confirmed");
});

test("a cask joins the app bundle it declares; launchd and symlinks relate to their owners", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "cask", location: "/opt/homebrew", status: "ok", installs: [
    rec({ ecosystem: "cask", key: "orbstack", name: "OrbStack", kind: "app", location: "/opt/homebrew/Caskroom/orbstack", details: { appNames: ["OrbStack.app"] } }),
  ] }, T);
  recordScan(db, "mini", { sourceKind: "app", location: "", status: "ok", installs: [
    rec({ ecosystem: "bundle", key: "dev.kdrag0n.MacVirt", name: "OrbStack", kind: "app", location: "/Applications/OrbStack.app" }),
    rec({ ecosystem: "bundle", key: "com.other", name: "Other", kind: "app", location: "/Applications/Other.app" }),
  ] }, T);
  recordScan(db, "mini", { sourceKind: "launchd", location: "", status: "ok", installs: [
    rec({ ecosystem: "launchd", key: "dev.orbstack.helper", kind: "service", version: null, location: "/Library/LaunchDaemons/x.plist", details: { program: "/Applications/OrbStack.app/Contents/MacOS/helper" } }),
  ] }, T);
  recordScan(db, "mini", { sourceKind: "localbin", location: "", status: "ok", installs: [
    rec({ ecosystem: "binary", key: "/Users/USER/.local/bin/orb", kind: "binary", version: null, location: "/Users/USER/.local/bin/orb", details: { linkTarget: "/Applications/OrbStack.app/Contents/MacOS/bin/orb" } }),
  ] }, T);
  const s = linkIdentity(db, T);
  assert.equal(itemOf(db, "cask", "orbstack"), itemOf(db, "bundle", "dev.kdrag0n.MacVirt"));
  assert.notEqual(itemOf(db, "cask", "orbstack"), itemOf(db, "bundle", "com.other"));
  assert.equal(s.relations, 2);
});
