import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { usageFixtureTests } from "@scout/core/testing";
import { atimeAdapter, processesAdapter } from "../src/index.ts";

usageFixtureTests(processesAdapter, fileURLToPath(new URL("../../../fixtures/linuxusage/processes", import.meta.url)));
usageFixtureTests(atimeAdapter, fileURLToPath(new URL("../../../fixtures/linuxusage/atime", import.meta.url)));

test("linuxusage probes ignore guest identifiers and discovered roots", () => {
  const empty = { machineId: "guest", os: "linux" as const, roots: {} };
  const supplied = { machineId: "guest; start", os: "linux" as const, roots: { bin: ["/tmp/input; start"] } };
  for (const adapter of [processesAdapter, atimeAdapter]) {
    assert.deepEqual(adapter.probes(supplied), adapter.probes(empty));
    assert.deepEqual(adapter.os, ["linux"]);
  }
  assert.deepEqual(processesAdapter.probes(empty), [{ id: "list", argv: ["/bin/sh", "-c", "ps -eo comm= 2>/dev/null"] }]);
});
