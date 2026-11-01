import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedPackets, fingerprint, type ExpectedRun } from "../src/index.ts";

const row: ExpectedRun = { host: "desktop", component: "backup", everyMinutes: 10, graceMinutes: 5, since: "2026-10-31T00:00:00.000Z" };

test("missing and late heartbeats become never-ran and wedged packets", () => {
  const never = expectedPackets([row], {}, "2026-10-31T00:06:00.000Z");
  assert.equal(never.length, 1);
  assert.equal(never[0]?.failureClass, "never-ran");
  assert.equal(never[0]?.fingerprint, fingerprint("desktop", "backup", "never-ran"));
  assert.equal(expectedPackets([row], {}, "2026-10-31T00:05:00.000Z").length, 0);
  const seen = { "desktop/backup": "2026-10-31T01:00:00.000Z" };
  assert.equal(expectedPackets([row], seen, "2026-10-31T01:15:00.000Z").length, 0);
  const late = expectedPackets([row], seen, "2026-10-31T01:15:00.001Z");
  assert.equal(late.length, 1);
  assert.equal(late[0]?.failureClass, "wedged");
  assert.equal(late[0]?.evidence.snapshot?.lastSeen, seen["desktop/backup"]);
  assert.equal(expectedPackets([{ ...row, since: "nope" }], {}, "2026-10-31T02:00:00.000Z").length, 0);
});
