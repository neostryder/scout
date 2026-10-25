import { test } from "node:test";
import assert from "node:assert/strict";
import { planUpdate } from "../src/plan.ts";

const machine = { transport: { type: "ssh", host: "192.168.2.105", user: "faramir" } } as never;
const pkg = (ecosystem = "pacman", key = "chromium") => ({ ecosystem, key, kind: "package" });

test("a pacman or AUR package runs the whole-system updater without a terminal and counts as disruptive", () => {
  for (const ecosystem of ["pacman", "aur"]) {
    const plan = planUpdate(pkg(ecosystem), "155.0.8059.84-1", machine);
    assert.equal(plan.allowed, true);
    assert.equal(plan.disruptive, true);
    assert.equal(plan.needsAdmin, false);
    assert.deepEqual(plan.argv.slice(0, 2), ["/bin/sh", "-c"]);
    assert.match(plan.argv[2]!, /omarchy-update -y <\/dev\/null/);
    assert.match(plan.argv[2]!, /sudo -n pacman -Syu --noconfirm/);
  }
});

test("package names with a plus or at sign and versions with an epoch are accepted, and hostile ones are not", () => {
  assert.equal(planUpdate(pkg("pacman", "libstdc++"), "1:14.2.1-3", machine).allowed, true);
  assert.equal(planUpdate(pkg("pacman", "gtk3+"), "3.24.43-1", machine).allowed, true);
  assert.equal(planUpdate(pkg("pacman", "--help"), "1-1", machine).allowed, false);
  assert.equal(planUpdate(pkg("pacman", "x; rm -rf /"), "1-1", machine).allowed, false);
  assert.equal(planUpdate(pkg("pacman", "chromium"), "1-1; reboot", machine).allowed, false);
});

test("the verify step reads the installed version of just that package, epoch included", () => {
  const { verify } = planUpdate(pkg("pacman", "chromium"), "155.0.8059.84-1", machine);
  assert.deepEqual(verify.argv, ["pacman", "-Q", "--", "chromium"]);
  assert.equal(verify.parse("chromium 155.0.8059.84-1\n"), "155.0.8059.84-1");
  assert.equal(planUpdate(pkg("pacman", "qt6"), "1:6.9-1", machine).verify.parse("qt6 1:6.9-1\n"), "1:6.9-1");
  assert.equal(verify.parse("error: package 'chromium' was not found\n"), null);
  assert.equal(verify.parse(""), null);
});
