import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/pacman", import.meta.url));
fixtureTests(adapter, dir);

test("the probe is the recorded script, run through a fixed argument array", () => {
  const script = readFileSync(new URL("../../../tools/probes/linux/pacman.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.deepEqual(adapter.probes({ machineId: "m", os: "linux", roots: {} }, ""), [{ id: "list", argv: ["/bin/sh", "-c", script] }]);
});

test("a checkupdates run that failed adds no system entry, and a missing yay is not an error", () => {
  const stdout = "Name            : acl\nVersion         : 2.4.0-1\n\n---SCOUT-FOREIGN---\n---SCOUT-PENDING---\nexit=1\n---SCOUT-AUR---\n---SCOUT-UPGRADED---\n[2026-10-18T19:17:35-0700] [PACMAN] starting full system upgrade\n---SCOUT-NOW---\n2026-10-25T10:59:14\n";
  const result = adapter.parse({ list: { exitCode: 0, stdout, stderr: "" } }, "");
  assert.deepEqual(result.installs.map((i) => i.ecosystem), ["pacman"]);
  const ok = adapter.parse({ list: { exitCode: 0, stdout: stdout.replace("exit=1", "exit=2"), stderr: "" } }, "");
  assert.deepEqual(ok.installs.map((i) => i.ecosystem), ["pacman", "arch-system"]);
  assert.equal((ok.installs[1]!.details as { pending: number }).pending, 0);
});
