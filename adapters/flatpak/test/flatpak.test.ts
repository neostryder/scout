import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter, pendingUpdates } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/flatpak", import.meta.url));
fixtureTests(adapter, dir);

test("the probe is the recorded script, run through a fixed argument array", () => {
  const script = readFileSync(new URL("../../../tools/probes/linux/flatpak.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.deepEqual(adapter.probes({ machineId: "m", os: "linux", roots: {} }, ""), [{ id: "list", argv: ["/bin/sh", "-c", script] }]);
});

const stdout = (...lines: string[]): string => `${lines.join("\n")}\n`;

test("an update belongs to the app, the branch and the origin it names", () => {
  const rows = ["org.example.one\t2.0\tstable\tflathub", "org.example.one\t2.0\tbeta\tflathub", "org.example.two\t3.0\tstable\tflathub"];
  assert.deepEqual(
    [...pendingUpdates(rows)],
    [
      ["org.example.one\tstable\tflathub", { version: "2.0", branch: "stable", origin: "flathub" }],
      ["org.example.one\tbeta\tflathub", { version: "2.0", branch: "beta", origin: "flathub" }],
      ["org.example.two\tstable\tflathub", { version: "3.0", branch: "stable", origin: "flathub" }],
    ],
  );
});

test("a malformed update row names no update", () => {
  const rows = ["org.example.one\t2.0\tstable", "\t2.0\tstable\tflathub", "org.example.two\t3.0\tstable\tflathub"];
  assert.deepEqual([...pendingUpdates(rows)], [["org.example.two\tstable\tflathub", { version: "3.0", branch: "stable", origin: "flathub" }]]);
});

test("an app carries the version an update brings, and a rebuild of the same version is not an update", () => {
  const out = stdout(
    "---SCOUT-LIST-system---",
    "org.example.one\tOne\t1.0\tstable\tflathub\tsystem\tFirst",
    "org.example.two\tTwo\t2.0\tstable\tflathub\tsystem\tSecond",
    "exit=0",
    "---SCOUT-UPDATES-system---",
    "org.example.one\t1.0\tstable\tflathub",
    "org.example.two\t3.0\tstable\tflathub",
    "exit=0",
    "---SCOUT-LIST-user---",
    "exit=0",
    "---SCOUT-UPDATES-user---",
    "exit=0",
  );
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.installs.map((i) => [i.key, i.name, i.kind, i.version, i.location, (i.details as { availableVersion?: string }).availableVersion ?? null]), [
    ["org.example.one", "One", "app", "1.0", "system", null],
    ["org.example.two", "Two", "app", "2.0", "system", "3.0"],
  ]);
});

test("an update in the system scope does not reach an app in the user scope", () => {
  const out = stdout(
    "---SCOUT-LIST-system---",
    "exit=0",
    "---SCOUT-UPDATES-system---",
    "org.example.one\t3.0\tstable\tflathub",
    "exit=0",
    "---SCOUT-LIST-user---",
    "org.example.one\tOne\t1.0\tstable\tflathub\tuser\tFirst",
    "exit=0",
    "---SCOUT-UPDATES-user---",
    "exit=0",
  );
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.installs.map((i) => [i.key, i.location, (i.details as { availableVersion?: string }).availableVersion ?? null]), [["org.example.one", "user", null]]);
});

test("a section whose tool failed names no update and is not an error", () => {
  const out = stdout(
    "---SCOUT-LIST-system---",
    "org.example.one\tOne\t1.0\tstable\tflathub\tsystem\tFirst",
    "exit=0",
    "---SCOUT-UPDATES-system---",
    "exit=1",
    "---SCOUT-LIST-user---",
    "exit=0",
    "---SCOUT-UPDATES-user---",
    "exit=0",
  );
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.installs.map((i) => [i.key, (i.details as { availableVersion?: string }).availableVersion ?? null]), [["org.example.one", null]]);
});

test("a malformed row is skipped and the scan is partial", () => {
  const out = stdout("---SCOUT-LIST-system---", "org.example.broken\tBroken", "exit=0", "---SCOUT-UPDATES-system---", "exit=0", "---SCOUT-LIST-user---", "exit=0", "---SCOUT-UPDATES-user---", "exit=0");
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "partial");
  assert.equal(result.message, "skipped 1 malformed line(s)");
  assert.deepEqual(result.installs, []);
});

test("a machine without flatpak is skipped, not failed", () => {
  const result = adapter.parse({ list: { exitCode: 127, stdout: "", stderr: "flatpak is not installed\n" } }, "");
  assert.equal(result.status, "skipped");
  assert.equal(result.message, "flatpak did not run (exit 127): flatpak is not installed");
  assert.deepEqual(result.installs, []);
});
