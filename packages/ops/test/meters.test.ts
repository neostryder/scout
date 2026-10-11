import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { latestMeters, openCatalog, type Exec } from "@scout/core";
import { LINUX_METERS_SCRIPT, MAC_METERS_SCRIPT, WINDOWS_METERS_SCRIPT, meterArgv, runMeterCycle, type MeterMachine } from "../src/meters.ts";

const local = { type: "local" } as const;
const hub: MeterMachine = { id: "hub", os: "windows", transport: local };
const mini: MeterMachine = { id: "mini", os: "macos", transport: { type: "ssh", target: "fixture-host" } };

const windowsJson = (cpu: number, rx: number) => JSON.stringify({ cpu, cores: 8, memTotal: 100, memFree: 40, rx, tx: 1, disks: [], gpu: [], procs: [] });
const macText = (idle: number) => `---SCOUT-MEM---\n1000000\n8\n---SCOUT-VM---\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 10.\nPages wired down: 5.\nPages occupied by compressor: 5.\n---SCOUT-CPU---\nCPU usage: 1.0% user, 1.0% sys, ${idle}% idle\n`;

test("the fixed scripts match the copies in tools/probes and each OS gets its own argv", () => {
  const mirror = (file: string): string => readFileSync(new URL(`../../../tools/probes/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.equal(WINDOWS_METERS_SCRIPT, mirror("windows/meters.ps1"));
  assert.equal(MAC_METERS_SCRIPT, mirror("macos/meters.sh"));
  assert.equal(LINUX_METERS_SCRIPT, mirror("linux/meters.sh"));
  assert.deepEqual(meterArgv("windows"), ["pwsh", "-NoProfile", "-Command", WINDOWS_METERS_SCRIPT]);
  assert.deepEqual(meterArgv("macos"), ["/bin/sh", "-c", MAC_METERS_SCRIPT]);
  assert.deepEqual(meterArgv("linux"), ["/bin/sh", "-c", LINUX_METERS_SCRIPT]);
  for (const script of [WINDOWS_METERS_SCRIPT, MAC_METERS_SCRIPT, LINUX_METERS_SCRIPT]) assert.equal(/[^\x09\x0a\x20-\x7e]/.test(script), false);
});

test("a cycle stores a sample per machine and keeps going when one machine fails or times out", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const seen: string[] = [];
  const run: Exec = async (transport, argv, timeoutMs) => {
    seen.push(`${transport.type}:${timeoutMs}`);
    if (transport.type === "ssh") return { exitCode: 255, stdout: "", stderr: "ssh: connection reset" };
    return { exitCode: 0, stdout: windowsJson(25, 1000), stderr: "" };
  };
  const logs: string[] = [];
  const results = await runMeterCycle(db, [hub, mini], { run, now: () => "2026-10-11T00:00:00.000Z", log: (line) => logs.push(line) });
  assert.deepEqual(results.map((r) => [r.machineId, r.ok, r.error]), [["hub", true, null], ["mini", false, "The meter read failed (exit 255)."]]);
  assert.equal(latestMeters(db).length, 1);
  assert.equal(latestMeters(db)[0]!.cpuPct, 25);
  assert.ok(logs[0]!.includes("mini"));
  assert.deepEqual(seen, ["local:45000", "ssh:45000"]);
  const timedOut = await runMeterCycle(db, [mini], { run: async () => ({ exitCode: 124, stdout: "", stderr: "" }) });
  assert.equal(timedOut[0]!.error, "The meter read timed out.");
});

test("unreadable output is a failure for that machine, and the stored sample from before stays the newest", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  await runMeterCycle(db, [mini], { run: async () => ({ exitCode: 0, stdout: macText(90), stderr: "" }), now: () => "2026-10-11T00:00:00.000Z" });
  const bad = await runMeterCycle(db, [mini], { run: async () => ({ exitCode: 0, stdout: "garbage", stderr: "" }), now: () => "2026-10-11T00:01:00.000Z" });
  assert.equal(bad[0]!.ok, false);
  assert.equal(bad[0]!.error, "The meter output could not be read.");
  assert.equal(latestMeters(db)[0]!.at, "2026-10-11T00:00:00.000Z");
  assert.equal(latestMeters(db)[0]!.cpuPct, 10);
});

test("network rates use the time between two cycles", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  await runMeterCycle(db, [hub], { run: async () => ({ exitCode: 0, stdout: windowsJson(1, 1_000), stderr: "" }), now: () => "2026-10-11T00:00:00.000Z" });
  await runMeterCycle(db, [hub], { run: async () => ({ exitCode: 0, stdout: windowsJson(1, 61_000), stderr: "" }), now: () => "2026-10-11T00:01:00.000Z" });
  assert.equal(latestMeters(db)[0]!.netRxBps, 1_000);
});

test("a Windows ssh crash on exit still counts when the output is whole, and not when it is empty or cut short", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const crash = (stdout: string): Exec => async () => ({ exitCode: 3221226356, stdout, stderr: "" });
  const ok = await runMeterCycle(db, [mini], { run: crash(macText(90)), now: () => "2026-10-11T00:00:00.000Z" });
  assert.equal(ok[0]!.ok, true);
  const empty = await runMeterCycle(db, [mini], { run: crash(""), now: () => "2026-10-11T00:01:00.000Z" });
  assert.equal(empty[0]!.error, "The meter read failed (exit 3221226356).");
  const cut = await runMeterCycle(db, [mini], { run: crash("---SCOUT-MEM---\n"), now: () => "2026-10-11T00:02:00.000Z" });
  assert.equal(cut[0]!.error, "The meter output could not be read.");
});
