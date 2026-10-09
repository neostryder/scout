import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessUpdate, openCatalog, recordDependencies, recordScan, upsertMachine } from "@scout/core";
import { wingetDepsAdapter, WINGET_DEPS_SCRIPT } from "../src/index.ts";

const recording = readFileSync(new URL("../../../fixtures/deps/winget-deps-hub.json", import.meta.url), "utf8");
const output = (stdout: string, exitCode = 0) => ({ "winget-deps": { stdout, exitCode, stderr: "" } });

test("the winget probe is one fixed node script that only reads", () => {
  const [probe] = wingetDepsAdapter.probes({ machineId: "m", os: "windows", roots: {} });
  assert.deepEqual(probe?.argv, ["node", "-"]);
  assert.equal(probe?.stdin, WINGET_DEPS_SCRIPT);
  assert.ok(!/\b(install|upgrade|uninstall)\b/.test(WINGET_DEPS_SCRIPT.replace(/ids|Installer/g, "")));
  assert.deepEqual(wingetDepsAdapter.os, ["windows"]);
});

test("the Hub recording gives package dependencies with their version bounds", () => {
  const parsed = wingetDepsAdapter.parse(output(recording));
  assert.equal(parsed.status, "ok");
  const find = (from: string, to: string) => parsed.facts.find((fact) => fact.from.key === from && fact.to.key === to);
  assert.equal(find("HandBrake.HandBrake", "Microsoft.DotNet.DesktopRuntime.10")?.constraint, null);
  assert.equal(find("NordSecurity.NordVPN", "Microsoft.DotNet.DesktopRuntime.8")?.kind, "runtime");
  assert.equal(find("Microsoft.AppInstaller", "Microsoft.VCLibs.Desktop.14")?.constraint, ">=14.0.33728.0");
  assert.equal(find("Microsoft.AppInstaller", "Microsoft.WindowsAppRuntime.1.8")?.constraint, ">=1.8.0");
  assert.ok(parsed.facts.every((fact) => fact.from.ecosystem === "winget" && fact.to.ecosystem === "winget" && fact.builtAgainst === null));
  assert.ok(parsed.facts.length >= 15);
});

test("odd lines, duplicates, self references and failures are handled without throwing", () => {
  const doc = { packages: [
    { id: "A.A", dependencies: ["B.B", "B.B", "A.A", "C.C [>= 2 ]", "[junk", "", "D.D [~ 1]"] },
    { id: 5, dependencies: [] },
    { id: "E.E", dependencies: "none" },
  ], failed: 1 };
  const parsed = wingetDepsAdapter.parse(output(JSON.stringify(doc)));
  assert.equal(parsed.status, "partial");
  assert.deepEqual(parsed.facts.map((fact) => [fact.to.key, fact.constraint]), [["B.B", null], ["C.C", ">=2"], ["D.D", null]]);
  assert.equal(wingetDepsAdapter.parse(output("not json")).status, "failed");
  assert.equal(wingetDepsAdapter.parse(output("{}")).status, "failed");
  assert.equal(wingetDepsAdapter.parse(output("", 127)).status, "skipped");
  assert.equal(wingetDepsAdapter.parse(output(JSON.stringify({ unavailable: true }))).status, "skipped");
  assert.equal(wingetDepsAdapter.parse({}).status, "failed");
});

test("winget edges bind to installed packages and a bound runtime outside its range is a hard break", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const T = "2026-09-30T12:00:00Z";
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [
    { ecosystem: "winget", key: "Microsoft.AppInstaller", name: "App Installer", kind: "package", version: "1.28.0", location: "" },
    { ecosystem: "winget", key: "Microsoft.WindowsAppRuntime.1.8", name: "Windows App Runtime 1.8", kind: "package", version: "1.8.3", location: "" },
    { ecosystem: "winget", key: "HandBrake.HandBrake", name: "HandBrake", kind: "package", version: "1.11.0", location: "" },
    { ecosystem: "winget", key: "Microsoft.DotNet.DesktopRuntime.10", name: ".NET Desktop Runtime 10", kind: "package", version: "10.0.8", location: "" },
  ] }, T);
  const stored = recordDependencies(db, "hub", wingetDepsAdapter.parse(output(recording)), T);
  assert.ok(stored.edges > 0);
  const id = (key: string) => (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ?").get(key) as { id: number }).id;
  assert.equal(assessUpdate(db, id("Microsoft.WindowsAppRuntime.1.8"), "1.8.5").hard.length, 0);
  assert.equal(assessUpdate(db, id("Microsoft.WindowsAppRuntime.1.8"), "1.7.0").hard[0]?.dependent.key, "Microsoft.AppInstaller");
  assert.equal(assessUpdate(db, id("Microsoft.DotNet.DesktopRuntime.10"), "10.0.9").hard.length, 0);
});
