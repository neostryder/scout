import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_CLASSES, loadFleetConfig, localConfig } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const event = { component: "Task failures", log: "Microsoft-Windows-TaskScheduler/Operational", ids: [101, 201, 203], levels: [1, 2, 3], providers: ["Microsoft-Windows-TaskScheduler"] };
const log = { component: "Example", path: "C:/Example/app.log", pattern: "ERROR|Traceback" };

test("local config supplies bounded defaults and requires explicit enablement", () => {
  const config = localConfig({});
  assert.ok(config);
  assert.equal(config.enabled, undefined);
  assert.equal(config.host, hostname());
  assert.deepEqual(config.disk, { paths: [`${process.env.SystemDrive ?? "C:"}/`], warnFreePercent: 10, criticalFreePercent: 5 });
  assert.deepEqual(config.windowsEvents, []);
  assert.deepEqual(config.logs, []);
  assert.deepEqual(config.wsl, { enabled: false });
  const full = localConfig({ enabled: true, host: "Example", disk: { paths: ["C:/"], warnFreePercent: 20, criticalFreePercent: 10 }, windowsEvents: [event], wsl: { enabled: true }, logs: [{ ...log, ignore: "noise", staleAfterMinutes: 60 }] });
  assert.ok(full);
  assert.equal(full.enabled, true);
  assert.equal(full.windowsEvents[0]?.failureClass, "ran-failed");
  assert.equal(full.windowsEvents[0]?.maxAgeMinutes, 30);
  assert.equal(full.logs[0]?.tailKilobytes, 64);
  assert.equal(full.logs[0]?.maxAgeMinutes, 30);
  assert.equal(full.logs[0]?.staleAfterMinutes, 60);
  assert.equal(localConfig({ logs: [log] })?.logs[0]?.staleAfterMinutes, null);
  for (const failureClass of FAILURE_CLASSES) {
    assert.ok(localConfig({ windowsEvents: [{ ...event, failureClass }], logs: [{ ...log, failureClass }] }));
  }
});

test("local config rejects unknown keys and invalid scalar, list, regex, and threshold values", () => {
  const invalid: unknown[] = [null, [], true, { unknown: true }, { enabled: "true" }, { host: "" }, { host: " " }, { host: "x".repeat(65) }, { host: "line\nbreak" }, { disk: null }, { disk: { extra: 1 } }, { disk: { paths: "C:/" } }, { disk: { paths: [""] } }, { disk: { paths: Array(21).fill("C:/") } }, { disk: { paths: ["x".repeat(196)] } }, { disk: { warnFreePercent: 5, criticalFreePercent: 5 } }, { disk: { warnFreePercent: 4, criticalFreePercent: 5 } }, { disk: { warnFreePercent: 91 } }, { disk: { criticalFreePercent: 0 } }, { disk: { criticalFreePercent: NaN } }, { wsl: true }, { wsl: { enabled: 1 } }, { wsl: { unknown: true } }, { windowsEvents: Array(21).fill(event) }, { logs: Array(31).fill(log) }];
  for (const bad of [{ component: "" }, { component: "x".repeat(181) }, { log: "" }, { log: "/c:1" }, { log: "-x" }, { unknown: 1 }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ["101"] }, { ids: [2_147_483_648] }, { ids: Array(51).fill(1) }, { levels: [0] }, { levels: null }, { providers: ["bad' or 1=1"] }, { providers: ["x".repeat(101)] }, { providers: Array(21).fill("Example") }, { maxAgeMinutes: 0 }, { maxAgeMinutes: null }, { maxAgeMinutes: 10081 }, { failureClass: "invalid" }, { failureClass: null }]) invalid.push({ windowsEvents: [{ ...event, ...bad }] });
  for (const bad of [{ path: "" }, { path: "x".repeat(1025) }, { pattern: "[" }, { pattern: "x".repeat(201) }, { ignore: "(" }, { ignore: null }, { unknown: 1 }, { failureClass: "invalid" }, { tailKilobytes: 0 }, { tailKilobytes: 513 }, { tailKilobytes: 1.5 }, { maxAgeMinutes: null }, { staleAfterMinutes: 0 }, { staleAfterMinutes: 10081 }, { staleAfterMinutes: "30" }]) invalid.push({ logs: [{ ...log, ...bad }] });
  for (const value of invalid) assert.equal(localConfig(value), null, JSON.stringify(value));
  assert.ok(localConfig({ windowsEvents: [{ ...event, ids: [], levels: [], providers: [] }], logs: [{ ...log, tailKilobytes: 512, maxAgeMinutes: 10080, staleAfterMinutes: null }] }));
  assert.equal(localConfig({ logs: Array(30).fill({ ...log, path: "x".repeat(1024), pattern: "x".repeat(200), ignore: "x".repeat(200), component: "x".repeat(180) }), windowsEvents: Array(20).fill({ ...event, providers: Array(20).fill("x".repeat(100)) }) }), null);
});

test("fleet file accepts local and catalog together and rejects a malformed local block", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-local-"));
  try {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({ sources: { catalog: { enabled: true }, local: { enabled: true, host: "Example", logs: [log] } } }), "utf8");
    const file = loadFleetConfig(path);
    assert.equal(file.fileError, null);
    assert.equal(file.sources?.catalog?.enabled, true);
    assert.equal(file.sources?.local?.enabled, true);
    assert.equal(file.sources?.local?.host, "Example");
    for (const local of [{ unknown: true }, { logs: [{ ...log, pattern: "[" }] }, { windowsEvents: [{ ...event, failureClass: "other" }] }]) {
      writeFileSync(path, JSON.stringify({ ingestTokenEnv: "FLEET_TOKEN", sources: { local } }), "utf8");
      const broken = loadFleetConfig(path);
      assert.match(broken.fileError ?? "", /malformed/);
      assert.equal(broken.sources, undefined);
      assert.equal(broken.ingestTokenEnv, null);
    }
    writeFileSync(path, JSON.stringify({ sources: { unknown: {} } }), "utf8");
    assert.ok(loadFleetConfig(path).fileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
