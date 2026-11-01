import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordResearch, recordScan, upsertMachine } from "@scout/core";
import { planUpdate } from "../src/plan.ts";
import { previewUpdate, runJob } from "../src/runner.ts";

const machine = { transport: { type: "local" as const } };
const refusals = [
  { key: "MSYS2.MSYS2", version: "2025.12.13", target: "2026.10.26", refusal: "MSYS2 updates through its own package manager; run pacman -Syu in the MSYS2 shell, because winget cannot upgrade it." },
  { key: "ItchIo.Itch", version: "25.6.0", target: "26.1.9", refusal: "itch updates itself when it runs, and winget cannot see the new version; open itch to update it." },
  { key: "Audacity.Audacity", version: "3.7.9", target: "4.0.0", refusal: "this version uses a different installer type; uninstall Audacity and install the new version." },
];

for (const { key, version, target, refusal } of refusals) {
  test(`${key} refuses winget and msstore updates with instructions and no command`, () => {
    for (const ecosystem of ["winget", "msstore"]) {
      const plan = planUpdate({ ecosystem, key, version, kind: "app" }, target, machine);
      assert.equal(plan.allowed, false);
      assert.equal(plan.refusal, refusal);
      assert.deepEqual(plan.argv, []);
      assert.equal(plan.command, "");
      assert.deepEqual(plan.verify.argv, []);
    }
  });
}

test("Audacity updates within the same major version can run", () => {
  const plan = planUpdate({ ecosystem: "winget", key: "Audacity.Audacity", kind: "app", version: "3.7.9" }, "3.7.10", machine);
  assert.equal(plan.allowed, true);
  assert.equal(plan.refusal, null);
  assert.deepEqual(plan.argv.slice(0, 2), ["winget", "upgrade"]);
});

test("Audacity does not refuse when either major version cannot be read", () => {
  for (const version of [undefined, null, "", "unknown"]) {
    const plan = planUpdate({ ecosystem: "winget", key: "Audacity.Audacity", kind: "app", version }, "4.0.0", machine);
    assert.equal(plan.allowed, true);
    assert.equal(plan.refusal, null);
  }
  assert.equal(planUpdate({ ecosystem: "winget", key: "Audacity.Audacity", kind: "app", version: "3.7.9" }, "unknown", machine).allowed, true);
});

test("an ordinary winget package can update", () => {
  const plan = planUpdate({ ecosystem: "winget", key: "Microsoft.PowerShell", kind: "app", version: "7.5.0" }, "7.5.1", machine);
  assert.equal(plan.allowed, true);
  assert.equal(plan.refusal, null);
  assert.deepEqual(plan.argv.slice(0, 2), ["winget", "upgrade"]);
});

test("the refusal table matches exact ids only in winget and msstore", () => {
  for (const { key, version, target } of refusals) {
    const plan = planUpdate({ ecosystem: "brew", key, version, kind: "app" }, target, machine);
    assert.equal(plan.allowed, true);
    assert.equal(plan.refusal, null);
    assert.deepEqual(plan.argv, ["brew", "upgrade", key]);
    assert.equal(planUpdate({ ecosystem: "winget", key: key.toLowerCase(), version, kind: "app" }, target, machine).allowed, true);
  }
});

test("runner preflight refuses externally managed updates before any transport calls", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const machines = [{ id: "pc", ...machine }];
  upsertMachine(db, { id: "pc", name: "PC", os: "windows", kind: "host" });
  recordScan(db, "pc", { sourceKind: "winget", location: "", status: "ok", installs: refusals.map(({ key, version }) => ({ ecosystem: "winget", key, name: key, version, kind: "app", location: "" })) }, new Date().toISOString());
  let calls = 0;
  for (const { key, target, refusal } of refusals) {
    const pkg = db.prepare("SELECT id FROM packages WHERE key = ?").get(key) as { id: number };
    const install = db.prepare("SELECT id FROM installs WHERE package_id = ?").get(pkg.id) as { id: number };
    recordResearch(db, pkg.id, "test", "ok", [{ channel: "stable", version: target, installable: true }], null);
    const preview = previewUpdate(db, install.id, machines)!.preview;
    assert.equal(preview.allowed, false);
    assert.equal(preview.refusal, refusal);
    const job = enqueueBatch(db, [{ installId: install.id, machineId: "pc", from: preview.from!, to: target }]).jobs[0]!;
    await runJob(db, job, { machines, exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } }, new AbortController().signal);
    const result = jobById(db, job.id)!;
    assert.equal(result.state, "failed");
    assert.equal(result.message, refusal);
    assert.equal(result.steps[0]?.name, "preflight");
    assert.equal(result.steps[0]?.output, refusal);
  }
  assert.equal(calls, 0);
});
