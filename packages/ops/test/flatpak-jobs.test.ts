import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScanAssertions, enqueueBatch, jobById, openCatalog, recordScan, upsertMachine, type Db, type Exec } from "@scout/core";
import { GAME_BUSY, planUpdate } from "../src/plan.ts";
import { Runner } from "../src/runner.ts";

const machines = [{ id: "bazzite", transport: { type: "ssh" as const, target: "claude@192.168.2.28" } }];
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 400 && !check(); n++) await tick(); assert.ok(check(), "condition was not reached in time"); }
const app = (installation = "system") => ({ ecosystem: "flatpak", key: "org.mozilla.firefox", kind: "app", details: { installation } });

function seeded(): { db: Db; id: number } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "bazzite", name: "bazzite", os: "linux", kind: "host" });
  recordScan(db, "bazzite", { sourceKind: "flatpak", location: "", status: "ok", installs: [{ ecosystem: "flatpak", key: "org.mozilla.firefox", name: "Firefox", kind: "app", version: "150.0", location: "system", details: { installation: "system", origin: "flathub", branch: "stable", availableVersion: "159.0" } }] }, new Date().toISOString());
  deriveScanAssertions(db);
  return { db, id: (db.prepare("SELECT id FROM installs").get() as { id: number }).id };
}

/** A bazzite whose Firefox moves to 159.0 once flatpak update runs; `guardExit` is what the game check answers. */
function bazzite(guardExit: number) {
  let installed = "150.0";
  const ran: string[] = [];
  const exec: Exec = async (_t, argv) => {
    if (argv[0] === "flatpak" && argv[1] === "info") return { exitCode: 0, stdout: `Firefox - Web Browser\n\n          ID: org.mozilla.firefox\n     Version: ${installed}\n`, stderr: "" };
    if (argv[0] === "/bin/sh") { ran.push("guard"); return { exitCode: guardExit, stdout: "", stderr: "" }; }
    if (argv[0] === "sudo") { ran.push(argv.join(" ")); installed = "159.0"; return { exitCode: 0, stdout: "Updates complete.\n", stderr: "" }; }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
  return { exec, ran };
}

test("a Flatpak app updates through sudo for the system installation and without it for the user installation", () => {
  const system = planUpdate(app(), "159.0", machines[0]!);
  assert.equal(system.allowed, true);
  assert.deepEqual(system.argv, ["sudo", "-n", "flatpak", "update", "-y", "--noninteractive", "--system", "org.mozilla.firefox"]);
  assert.deepEqual(system.verify.argv, ["flatpak", "info", "--system", "org.mozilla.firefox"]);
  assert.equal(system.disruptive, true);
  const user = planUpdate(app("user"), "159.0", machines[0]!);
  assert.deepEqual(user.argv, ["flatpak", "update", "-y", "--noninteractive", "--user", "org.mozilla.firefox"]);
  assert.deepEqual(user.verify.argv, ["flatpak", "info", "--user", "org.mozilla.firefox"]);
});

test("the Flatpak plan carries the game check, and the check cannot match its own shell", () => {
  const { guard } = planUpdate(app(), "159.0", machines[0]!);
  assert.equal(guard?.busyExit, 10);
  assert.equal(guard?.busy, GAME_BUSY);
  assert.deepEqual(guard?.argv.slice(0, 2), ["/bin/sh", "-c"]);
  assert.match(guard?.argv[2] ?? "", /pgrep -f '\[S\]teamLaunch AppId=\[1-9\]'/);
  assert.equal(planUpdate({ ecosystem: "pipx", key: "ruff", kind: "package" }, "2.0", machines[0]!).guard, null);
});

test("Flatpak ids and versions that could carry a command are refused, and the OS image still has no updater", () => {
  assert.equal(planUpdate({ ...app(), key: "x; reboot" }, "159.0", machines[0]!).allowed, false);
  assert.equal(planUpdate({ ...app(), key: "--help" }, "159.0", machines[0]!).allowed, false);
  assert.equal(planUpdate(app(), "159.0; reboot", machines[0]!).allowed, false);
  assert.equal(planUpdate({ ecosystem: "ostree", key: "ghcr.io/ublue-os/bazzite-deck-nvidia", kind: "image" }, "44.20261026", machines[0]!).refusal, "Scout has no updater for ostree installs");
});

test("flatpak info output yields the installed version", () => {
  const { verify } = planUpdate(app(), "159.0", machines[0]!);
  assert.equal(verify.parse("Firefox - Web Browser\n\n          ID: org.mozilla.firefox\n     Version: 159.0\n      Branch: stable\n"), "159.0");
  assert.equal(verify.parse("error: org.mozilla.firefox not installed\n"), null);
});

test("with no game running the update runs, is verified, and the row moves to the new version", async () => {
  const { db, id } = seeded();
  const { exec, ran } = bazzite(0);
  const runner = new Runner(db, { machines, exec, retryDelayMs: 1 });
  const { jobs } = enqueueBatch(db, [{ installId: id, machineId: "bazzite", from: "150.0", to: "159.0" }]);
  runner.wake();
  await until(() => jobById(db, jobs[0]!.id)?.state === "done");
  assert.deepEqual(ran, ["guard", "sudo -n flatpak update -y --noninteractive --system org.mozilla.firefox"]);
  assert.equal((db.prepare("SELECT version FROM installs WHERE id = ?").get(id) as { version: string }).version, "159.0");
  const step = db.prepare("SELECT state, output FROM job_steps WHERE job_id = ? AND name = 'game-check'").get(jobs[0]!.id) as { state: string; output: string };
  assert.equal(step.state, "done");
  assert.equal(step.output, "no game is running");
  db.close();
});

test("while a game runs the job fails with a plain message and nothing is updated", async () => {
  const { db, id } = seeded();
  const { exec, ran } = bazzite(10);
  const runner = new Runner(db, { machines, exec, retryDelayMs: 1 });
  const { jobs } = enqueueBatch(db, [{ installId: id, machineId: "bazzite", from: "150.0", to: "159.0" }]);
  runner.wake();
  await until(() => jobById(db, jobs[0]!.id)?.state === "failed");
  assert.deepEqual(ran, ["guard"]);
  assert.equal(jobById(db, jobs[0]!.id)?.message, GAME_BUSY);
  assert.equal((db.prepare("SELECT version FROM installs WHERE id = ?").get(id) as { version: string }).version, "150.0");
  db.close();
});

test("an unreadable game check stops the update instead of assuming no game is running", async () => {
  for (const code of [2, 255]) {
    const { db, id } = seeded();
    const { exec, ran } = bazzite(code);
    const runner = new Runner(db, { machines, exec, retryDelayMs: 1 });
    const { jobs } = enqueueBatch(db, [{ installId: id, machineId: "bazzite", from: "150.0", to: "159.0" }]);
    runner.wake();
    await until(() => jobById(db, jobs[0]!.id)?.state === "failed");
    assert.deepEqual(ran, ["guard"]);
    assert.match(jobById(db, jobs[0]!.id)?.message ?? "", /could not check whether a game is running/);
    db.close();
  }
});
