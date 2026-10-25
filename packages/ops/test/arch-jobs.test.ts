import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveScanAssertions, enqueueBatch, jobById, listJobs, openCatalog, quietWindow, recordScan, upsertMachine, type Db, type Exec } from "@scout/core";
import { rebootIfNeeded, Runner } from "../src/runner.ts";

const machines = [{ id: "faramir", transport: { type: "ssh" as const, target: "faramir@192.168.2.105" } }];
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 400 && !check(); n++) await tick(); assert.ok(check(), "condition was not reached in time"); }

function seeded(): { db: Db; ids: number[] } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "faramir", name: "Faramir", os: "linux", kind: "host" });
  const pkg = (key: string, version: string, availableVersion: string) => ({ ecosystem: "pacman", key, name: key, kind: "package" as const, version, location: "", details: { availableVersion } });
  recordScan(db, "faramir", { sourceKind: "pacman", location: "", status: "ok", installs: [pkg("acl", "2.4.0-1", "2.4.1-1"), pkg("chromium", "154.0.1-1", "155.0.2-1")] }, new Date().toISOString());
  deriveScanAssertions(db);
  return { db, ids: (db.prepare("SELECT id FROM installs ORDER BY id").all() as { id: number }[]).map((row) => row.id) };
}

/** A machine whose packages all move to their new versions the first time the whole-system update runs. */
function arch(kernelReplaced: boolean) {
  const installed: Record<string, string> = { acl: "2.4.0-1", chromium: "154.0.1-1" };
  const wanted: Record<string, string> = { acl: "2.4.1-1", chromium: "155.0.2-1" };
  const ran: string[] = [];
  const exec: Exec = async (_t, argv) => {
    if (argv[0] === "pacman") return { exitCode: 0, stdout: `${argv[3]} ${installed[argv[3]!]}\n`, stderr: "" };
    const script = argv[2] ?? "";
    if (script.includes("pacman -Syu")) { ran.push("update"); Object.assign(installed, wanted); return { exitCode: 0, stdout: "upgraded\n", stderr: "" }; }
    if (script.startsWith("[ ! -d")) { ran.push("needs-reboot-check"); return { exitCode: kernelReplaced ? 0 : 1, stdout: "", stderr: "" }; }
    if (script.includes("shutdown -r")) { ran.push("reboot"); return { exitCode: 0, stdout: "", stderr: "" }; }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
  return { exec, ran };
}

function dayAt(inWindow: boolean): Date {
  for (let hour = 0; hour < 24; hour++) {
    const at = new Date(2026, 9, 26, hour, 0, 0);
    if (quietWindow(at).inWindow === inWindow) return at;
  }
  throw new Error("no such hour");
}

test("one batch of Arch package updates runs the whole-system update once, and the later jobs find their package already at the target", async () => {
  const { db, ids } = seeded();
  const { exec, ran } = arch(false);
  const runner = new Runner(db, { machines, exec });
  const batch = enqueueBatch(db, [
    { installId: ids[0]!, machineId: "faramir", from: "2.4.0-1", to: "2.4.1-1" },
    { installId: ids[1]!, machineId: "faramir", from: "154.0.1-1", to: "155.0.2-1" },
  ]);
  runner.wake();
  await until(() => batch.jobs.every((job) => jobById(db, job.id)?.state === "done"));
  assert.equal(ran.filter((step) => step === "update").length, 1);
  const versions = Object.fromEntries((db.prepare("SELECT p.key, i.version FROM installs i JOIN packages p ON p.id = i.package_id").all() as { key: string; version: string }[]).map((row) => [row.key, row.version]));
  assert.deepEqual(versions, { acl: "2.4.1-1", chromium: "155.0.2-1" });
  const steps = (db.prepare("SELECT output FROM job_steps WHERE job_id = ? AND name = 'preflight'").get(batch.jobs[1]!.id) as { output: string }).output;
  assert.match(steps, /already at 155\.0\.2-1/);
  assert.equal(listJobs(db, 10).some((job) => job.state === "failed"), false);
  db.close();
});

test("a restart is scheduled only when the kernel was replaced, in the quiet window, with nothing else queued", async () => {
  const { db, ids } = seeded();
  const [job, other] = enqueueBatch(db, [{ installId: ids[0]!, machineId: "faramir", from: "2.4.0-1", to: "2.4.1-1" }, { installId: ids[1]!, machineId: "faramir", from: "154.0.1-1", to: "155.0.2-1" }]).jobs as unknown as [{ id: number }, { id: number }];
  const signal = new AbortController().signal;

  const unchanged = arch(false);
  assert.equal(await rebootIfNeeded(db, "faramir", job.id, { machines, exec: unchanged.exec }, signal, dayAt(true)), "busy");
  db.prepare("UPDATE jobs SET state = 'done' WHERE id IN (?, ?)").run(job.id, other.id);
  assert.equal(await rebootIfNeeded(db, "faramir", job.id, { machines, exec: unchanged.exec }, signal, dayAt(true)), "not-needed");
  assert.deepEqual(unchanged.ran, ["needs-reboot-check"]);

  const replaced = arch(true);
  assert.equal(await rebootIfNeeded(db, "faramir", job.id, { machines, exec: replaced.exec }, signal, dayAt(false)), "outside-window");
  assert.deepEqual(replaced.ran, ["needs-reboot-check"]);

  const quiet = arch(true);
  assert.equal(await rebootIfNeeded(db, "faramir", job.id, { machines, exec: quiet.exec }, signal, dayAt(true)), "rebooting");
  assert.deepEqual(quiet.ran, ["needs-reboot-check", "reboot"]);
  const steps = db.prepare("SELECT state, output FROM job_steps WHERE job_id = ? AND name = 'reboot' ORDER BY seq").all(job.id) as { state: string; output: string }[];
  assert.deepEqual(steps.map((step) => step.state), ["done", "done"]);
  assert.match(steps[1]!.output, /restarts in two minutes/);
  db.close();
});
