import { test } from "node:test";
import assert from "node:assert/strict";
import { planUpdate } from "../src/plan.ts";

const machine = { transport: { type: "ssh", host: "192.168.2.105", user: "faramir" } } as never;
const system = { ecosystem: "arch-system", key: "omarchy", kind: "runtime" };

test("the Arch system entry runs the whole-system updater without a terminal and counts as disruptive", () => {
  const plan = planUpdate(system, "2026.10.25.1059", machine);
  assert.equal(plan.allowed, true);
  assert.equal(plan.disruptive, true);
  assert.equal(plan.needsAdmin, false);
  assert.deepEqual(plan.argv.slice(0, 2), ["/bin/sh", "-c"]);
  assert.match(plan.argv[2]!, /omarchy-update -y <\/dev\/null/);
  assert.match(plan.argv[2]!, /sudo -n pacman -Syu --noconfirm/);
});

test("the verify step reads the time of the last full upgrade out of pacman.log", () => {
  const { verify } = planUpdate(system, "2026.10.25.1059", machine);
  assert.equal(verify.parse("[2026-10-25T11:04:22-0700] [PACMAN] starting full system upgrade\n"), "2026.10.25.1104");
  assert.equal(verify.parse(""), null);
});

test("single pacman and AUR packages are refused with the reason", () => {
  for (const ecosystem of ["pacman", "aur"]) {
    const plan = planUpdate({ ecosystem, key: "chromium", kind: "package" }, "155.0.1-1", machine);
    assert.equal(plan.allowed, false);
    assert.match(plan.refusal ?? "", /whole system together/);
  }
});
