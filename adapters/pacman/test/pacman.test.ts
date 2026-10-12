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
