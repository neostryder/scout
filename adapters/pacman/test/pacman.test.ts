import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter, pendingVersions } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/pacman", import.meta.url));
fixtureTests(adapter, dir);

test("the probe is the recorded script, run through a fixed argument array", () => {
  const script = readFileSync(new URL("../../../tools/probes/linux/pacman.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.deepEqual(adapter.probes({ machineId: "m", os: "linux", roots: {} }, ""), [{ id: "list", argv: ["/bin/sh", "-c", script] }]);
});

test("each package row carries the version an update would bring, from checkupdates and from yay", () => {
  const block = (name: string, version: string) => `Name            : ${name}\nVersion         : ${version}\n\n`;
  const stdout = block("acl", "2.4.0-1") + block("chromium", "154.0.8037.97-1") + block("yay-thing", "1:1.0-1") + block("zlib", "1.3-1")
    + "---SCOUT-FOREIGN---\nyay-thing\n---SCOUT-PENDING---\nacl 2.4.0-1 -> 2.4.1-1\nchromium 154.0.8037.97-1 -> 155.0.8059.84-1\nexit=0\n---SCOUT-AUR---\nyay-thing 1:1.0-1 -> 1:1.1-1\nexit=0\n---SCOUT-UPGRADED---\n---SCOUT-NOW---\n2026-10-25T10:59:14\n";
  const result = adapter.parse({ list: { exitCode: 0, stdout, stderr: "" } }, "");
  const found = Object.fromEntries(result.installs.map((i) => [i.key, [i.ecosystem, (i.details as { availableVersion?: string }).availableVersion ?? null]]));
  assert.deepEqual(found, { acl: ["pacman", "2.4.1-1"], chromium: ["pacman", "155.0.8059.84-1"], "yay-thing": ["aur", "1:1.1-1"], zlib: ["pacman", null] });
  assert.equal(result.installs.some((i) => i.ecosystem === "arch-system"), false);
});

test("a checkupdates run that failed, or a missing yay, names no update and is not an error", () => {
  const stdout = "Name            : acl\nVersion         : 2.4.0-1\n\n---SCOUT-FOREIGN---\n---SCOUT-PENDING---\nexit=1\n---SCOUT-AUR---\n---SCOUT-UPGRADED---\n---SCOUT-NOW---\n2026-10-25T10:59:14\n";
  const result = adapter.parse({ list: { exitCode: 0, stdout, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.installs.map((i) => [i.key, (i.details as { availableVersion?: string }).availableVersion ?? null]), [["acl", null]]);
});

test("pending lines read as name to new version, and anything else is ignored", () => {
  assert.deepEqual([...pendingVersions(["a 1-1 -> 2-1", "  b 1:3-1 -> 1:4-1", "exit=0", "garbage"])], [["a", "2-1"], ["b", "1:4-1"]]);
});
