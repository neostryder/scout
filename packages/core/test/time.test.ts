import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLocal, sinceLastCheck } from "../src/index.ts";

test("local time is written to the second in the given zone", () => {
  assert.equal(formatLocal("2026-10-10T22:26:03.456Z", "America/Phoenix"), "2026-10-10 15:26:03 MST");
  assert.equal(formatLocal("2026-10-10T22:26:03Z", "UTC"), "2026-10-10 22:26:03 UTC");
  assert.equal(formatLocal("not a time"), "not a time");
});

test("minutes since the last successful check are whole minutes and singular at one", () => {
  assert.equal(sinceLastCheck("2026-10-10T12:00:00Z", "2026-10-10T12:04:20Z"), "(4 minutes since the last successful check)");
  assert.equal(sinceLastCheck("2026-10-10T12:00:00Z", "2026-10-10T12:01:00Z"), "(1 minute since the last successful check)");
  assert.equal(sinceLastCheck(null, "2026-10-10T12:01:00Z"), "(no successful check on record)");
});
