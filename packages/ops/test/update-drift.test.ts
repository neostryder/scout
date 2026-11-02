import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordResearch, recordScan, upsertMachine, type Db, type Exec, type Job } from "@scout/core";
import { runJob, type RunnerDeps } from "../src/runner.ts";

const machines = [{ id: "eru", transport: { type: "local" as const } }];
const KEY = "Obsidian.Obsidian";

function seeded(options: { ecosystem?: string; key?: string; from?: string; to?: string } = {}): { db: Db; id: number; pkg: number; job: Job } {
  const db = openCatalog(":memory:");
  const ecosystem = options.ecosystem ?? "winget";
  const key = options.key ?? KEY;
  const from = options.from ?? "1.12.7";
  const to = options.to ?? "1.14.4";
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  recordScan(db, "eru", { sourceKind: ecosystem, location: "", status: "ok", installs: [{ ecosystem, key, name: key, kind: "app", version: from, location: "" }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages WHERE key = ?").get(key) as { id: number }).id;
  recordResearch(db, pkg, ecosystem, "ok", [{ channel: "stable", version: to, installable: true }], null);
  const id = (db.prepare("SELECT id FROM installs WHERE package_id = ?").get(pkg) as { id: number }).id;
  return { db, id, pkg, job: enqueueBatch(db, [{ installId: id, machineId: "eru", from, to }]).jobs[0]! };
}

const deps = (exec: Exec): RunnerDeps => ({ machines, exec, readServices: async () => [], retryDelayMs: 1 });
const list = (key: string, version: string): string => `Package ${key} ${version}  winget\n`;
const installed = (db: Db, id: number): string => (db.prepare("SELECT version FROM installs WHERE id = ?").get(id) as { version: string }).version;
const output = (job: Job, name: string): string => job.steps.find((entry) => entry.name === name)?.output ?? "";

test("an app that moved past the target on its own ends the job as done", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  let upgrades = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") { upgrades++; return { exitCode: 0, stdout: "updated", stderr: "" }; }
    return { exitCode: 0, stdout: list(KEY, "1.15.0"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "done");
  assert.equal(upgrades, 0, "no update runs when the target is installed already");
  assert.equal(installed(f.db, f.id), "1.15.0");
  assert.match(output(job, "preflight"), /already at 1\.15\.0; it changed since the scan/);
});

test("an installed version that moved to another release below the target is updated from the live version", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  let listed = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") return { exitCode: 0, stdout: "updated", stderr: "" };
    listed++;
    return { exitCode: 0, stdout: list(KEY, listed === 1 ? "1.13.0" : "1.14.4"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "done");
  assert.equal((f.db.prepare("SELECT from_version FROM jobs WHERE id = ?").get(f.job.id) as { from_version: string }).from_version, "1.13.0");
  assert.equal(installed(f.db, f.id), "1.14.4");
  assert.match(output(job, "preflight"), /installed version moved from 1\.12\.7 to 1\.13\.0 since the scan; continuing from the live version/);
});

test("a package manager that does not answer is asked again", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  let listed = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") return { exitCode: 0, stdout: "updated", stderr: "" };
    listed++;
    if (listed <= 2) return { exitCode: 1, stdout: "", stderr: "winget is busy" };
    return { exitCode: 0, stdout: list(KEY, listed === 3 ? "1.12.7" : "1.14.4"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  assert.equal(jobById(f.db, f.job.id)?.state, "done");
  assert.equal(listed, 4);
});

test("a package manager that never answers fails with the retry message", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  let listed = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") return { exitCode: 0, stdout: "updated", stderr: "" };
    listed++;
    return { exitCode: 1, stdout: "", stderr: "winget is busy" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "failed");
  assert.equal(job.message, "could not read the installed version; the package manager did not answer. Retry the update in a minute");
  assert.equal(listed, 4, "the first read and three retries");
});

test("a newer release in the catalog becomes the target", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  recordResearch(f.db, f.pkg, "winget", "ok", [{ channel: "stable", version: "1.15.0", installable: true }], null);
  let listed = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") return { exitCode: 0, stdout: "updated", stderr: "" };
    listed++;
    return { exitCode: 0, stdout: list(KEY, listed === 1 ? "1.12.7" : "1.15.0"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "done");
  assert.equal((f.db.prepare("SELECT target FROM jobs WHERE id = ?").get(f.job.id) as { target: string }).target, "1.15.0");
  assert.match(output(job, "preflight"), /the catalog now offers 1\.15\.0; the update targets it/);
});

test("a pinned version winget no longer offers is retried without the pin", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  let listed = 0;
  const upgrades: string[][] = [];
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") {
      upgrades.push(argv);
      return upgrades.length === 1 ? { exitCode: 2316632080, stdout: "", stderr: "No applicable version found" } : { exitCode: 0, stdout: "updated", stderr: "" };
    }
    listed++;
    return { exitCode: 0, stdout: list(KEY, listed === 1 ? "1.12.7" : "1.14.4"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "done");
  assert.equal(upgrades.length, 2);
  assert.equal(upgrades[0]!.includes("--version"), true);
  assert.equal(upgrades[1]!.includes("--version"), false);
  assert.deepEqual(job.steps.filter((entry) => entry.name === "update" || entry.name === "update-latest").map((entry) => [entry.name, entry.state]), [["update", "failed"], ["update-latest", "done"]]);
});

test("a pinned version across a major boundary is not retried", async (t) => {
  const f = seeded({ to: "2.0.0" });
  t.after(() => f.db.close());
  let upgrades = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") { upgrades++; return { exitCode: 2316632080, stdout: "", stderr: "No applicable version found" }; }
    return { exitCode: 0, stdout: list(KEY, "1.12.7"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  const job = jobById(f.db, f.job.id)!;
  assert.equal(job.state, "failed");
  assert.equal(job.message, "winget no longer offers 2.0.0; rescan and retry");
  assert.equal(upgrades, 1);
});

test("the verify is asked again while the package manager is still busy", async (t) => {
  const f = seeded();
  t.after(() => f.db.close());
  let listed = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "upgrade") return { exitCode: 0, stdout: "updated", stderr: "" };
    listed++;
    if (listed === 2) return { exitCode: 1, stdout: "", stderr: "winget is busy" };
    return { exitCode: 0, stdout: list(KEY, listed === 1 ? "1.12.7" : "1.14.4"), stderr: "" };
  };
  await runJob(f.db, f.job, deps(exec), new AbortController().signal);
  assert.equal(jobById(f.db, f.job.id)?.state, "done");
  assert.equal(listed, 3);
});

test("an app that updates itself ends the job as done, and an ordinary package does not", async (t) => {
  for (const key of ["ItchIo.Itch", "Zoom.Zoom"]) {
    const f = seeded({ ecosystem: "npm", key, from: "1.0.0", to: "1.1.0" });
    t.after(() => f.db.close());
    const exec: Exec = async (_transport, argv) => argv[1] === "ls"
      ? { exitCode: 0, stdout: JSON.stringify({ dependencies: { [key]: { version: "1.0.0" } } }), stderr: "" }
      : { exitCode: 0, stdout: "updated", stderr: "" };
    await runJob(f.db, f.job, deps(exec), new AbortController().signal);
    const job = jobById(f.db, f.job.id)!;
    if (key === "ItchIo.Itch") {
      assert.equal(job.state, "done");
      assert.equal(job.message, "installed; this app finishes updating itself, so Scout shows the new version after its next scan");
      assert.equal(installed(f.db, f.id), "1.0.0");
    } else {
      assert.equal(job.state, "failed");
      assert.equal(job.message, "installed version did not reach the target");
    }
  }
});
