import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordDependencies, recordResearch, recordScan, setJobState, upsertMachine, type Db, type Exec } from "@scout/core";
import { dependencyRisk, previewUpdate, runJob, wouldUpgrade } from "../src/runner.ts";

const T = "2026-09-30T12:00:00Z";
const machines = ["mini", "hub"].map((id) => ({ id, transport: { type: "local" as const } }));

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  for (const machine of machines) {
    upsertMachine(db, { id: machine.id, name: machine.id, os: "macos", kind: "host" });
    recordScan(db, machine.id, { sourceKind: "brew", location: "", status: "ok", installs: [
      { ecosystem: "brew", key: "llhttp", name: "llhttp", kind: "package", version: "9.4.3", location: "" },
      { ecosystem: "brew", key: "node", name: "node", kind: "runtime", version: "26.10.0", location: "" },
      { ecosystem: "brew", key: "eza", name: "eza", kind: "package", version: "1.0.0", location: "" },
    ] }, T);
    recordScan(db, machine.id, { sourceKind: "npm", location: "", status: "ok", installs: [
      { ecosystem: "npm", key: "tool", name: "tool", kind: "package", version: "1.0.0", location: "" },
    ] }, T);
  }
  for (const row of db.prepare("SELECT id, key FROM packages").all() as { id: number; key: string }[]) {
    recordResearch(db, row.id, "test", "ok", [{ channel: "stable", version: row.key === "llhttp" ? "9.5.0" : row.key === "node" ? "27.0.0" : "2.0.0", installable: true }], null, T);
  }
  return db;
}

function id(db: Db, key: string, machine = "mini"): number {
  return (db.prepare("SELECT i.id FROM installs i JOIN packages p ON p.id = i.package_id WHERE p.key = ? AND i.machine_id = ?").get(key, machine) as { id: number }).id;
}

function library(db: Db): void {
  recordDependencies(db, "mini", { origin: "brew-deps", status: "ok", facts: [
    { from: { ecosystem: "brew", key: "eza" }, to: { ecosystem: "brew", key: "llhttp" }, kind: "library", constraint: null, builtAgainst: "9.4.3", evidence: "keg" },
  ] }, T);
}

function runtime(db: Db, constraint = "<27"): void {
  recordDependencies(db, "mini", { origin: "npm-engines", status: "ok", facts: [
    { from: { ecosystem: "npm", key: "tool" }, to: { ecosystem: "runtime", key: "node" }, kind: "runtime", constraint, builtAgainst: "26.10.0", evidence: "engines.node" },
  ] }, T);
}

test("plans refuse runtime breaks and accept same-machine batch partners", (t) => {
  const db = seed(t);
  runtime(db);
  for (const [key, dependent, kind] of [["node", "tool", "runtime"]]) {
    const blocked = previewUpdate(db, id(db, key!), machines)!.preview;
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.breaks.hard[0]?.dependent.id, id(db, dependent!));
    assert.equal(blocked.breaks.hard[0]?.kind, kind);
    assert.ok(blocked.refusal?.includes(dependent!));
    assert.ok(blocked.refusal?.includes(blocked.breaks.hard[0]!.reason));
    assert.equal(blocked.softConfirmation, null);
    assert.equal(previewUpdate(db, id(db, key!), machines, { alsoUpdating: [id(db, dependent!, "hub")] })!.preview.allowed, false);
    const together = previewUpdate(db, id(db, key!), machines, { alsoUpdating: [id(db, dependent!)] })!.preview;
    assert.equal(together.allowed, true);
    assert.deepEqual(together.breaks, { hard: [], soft: [] });
  }
});

test("a library change is a soft break that names its dependents and needs no confirmation when they update together", (t) => {
  const db = seed(t);
  library(db);
  const preview = previewUpdate(db, id(db, "llhttp"), machines)!.preview;
  assert.equal(preview.allowed, true);
  assert.deepEqual(preview.breaks.hard, []);
  assert.equal(preview.breaks.soft[0]?.dependent.id, id(db, "eza"));
  assert.match(preview.breaks.soft[0]?.reason ?? "", /eza was built against llhttp 9.4.3/);
  assert.deepEqual(preview.softConfirmation, { projects: [], dependents: ["eza"] });
  const together = previewUpdate(db, id(db, "llhttp"), machines, { alsoUpdating: [id(db, "eza")] })!.preview;
  assert.deepEqual(together.breaks, { hard: [], soft: [] });
  assert.equal(together.softConfirmation, null);
});

test("plans name unreadable runtime requirements in soft confirmation", (t) => {
  const db = seed(t);
  runtime(db, "broken range");
  const preview = previewUpdate(db, id(db, "node"), machines)!.preview;
  assert.equal(preview.allowed, true);
  assert.equal(preview.breaks.soft[0]?.reason, "the range could not be read");
  assert.deepEqual(preview.softConfirmation, { projects: [], dependents: ["tool"] });
});

test("plans warn about project pins and engines that disagree with the target", (t) => {
  const db = seed(t);
  recordScan(db, "mini", { sourceKind: "projectsel", location: "/projects", status: "ok", installs: [], selectors: [
    { file: "/projects/site/.nvmrc", project: "/projects/site", kind: "node", tool: "node", spec: "26.10.0" },
    { file: "/projects/site/package.json", project: "/projects/site", kind: "engines", tool: "node", spec: "<27" },
    { file: "/projects/compatible/.node-version", project: "/projects/compatible", kind: "node", tool: "node", spec: "27.0.0" },
    { file: "/projects/compatible/package.json", project: "/projects/compatible", kind: "engines", tool: "node", spec: ">=27" },
    { file: "/projects/unknown/.nvmrc", project: "/projects/unknown", kind: "node", tool: "node", spec: "lts/*" },
  ] }, T);
  const preview = previewUpdate(db, id(db, "node"), machines)!.preview;
  assert.equal(preview.allowed, true);
  assert.equal(preview.breaks.soft.length, 2);
  assert.deepEqual(preview.breaks.soft[0]?.dependent, { id: null, ecosystem: "project", key: "site", name: "site", machine: "mini" });
  assert.deepEqual(preview.softConfirmation, { projects: ["site"], dependents: [] });
  assert.ok(preview.breaks.soft.every((entry) => entry.reason.includes("/projects/site")));
});

test("a hard edge added after queuing refuses preflight with its plan reasons and no transport calls", async (t) => {
  const db = seed(t);
  const installId = id(db, "node");
  assert.equal(previewUpdate(db, installId, machines)!.preview.allowed, true);
  const job = enqueueBatch(db, [{ installId, machineId: "mini", from: "26.10.0", to: "27.0.0" }]).jobs[0]!;
  runtime(db);
  const shown = previewUpdate(db, installId, machines)!.preview;
  let calls = 0;
  await runJob(db, job, { machines, exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } }, new AbortController().signal);
  const result = jobById(db, job.id)!;
  assert.equal(result.state, "failed");
  assert.equal(result.message, shown.refusal);
  assert.equal(result.steps[0]?.name, "preflight");
  assert.equal(result.steps[0]?.output, shown.refusal);
  assert.equal(calls, 0);
});

test("preflight catches edges added during the version check and during Homebrew refresh", async (t) => {
  for (const when of ["list", "update"]) {
    const db = seed(t);
    const installId = id(db, "node");
    const job = enqueueBatch(db, [{ installId, machineId: "mini", from: "26.10.0", to: "27.0.0" }]).jobs[0]!;
    const calls: string[] = [];
    const exec: Exec = async (_transport, argv) => {
      calls.push(argv.join(" "));
      if (argv[1] === when) runtime(db);
      return { exitCode: 0, stdout: argv[1] === "list" ? "node 26.10.0" : "", stderr: "" };
    };
    await runJob(db, job, { machines, exec }, new AbortController().signal);
    assert.equal(jobById(db, job.id)?.state, "failed", when);
    assert.match(jobById(db, job.id)?.message ?? "", /tool requires node/);
    assert.ok(!calls.includes("brew upgrade node"));
  }
});

test("preflight keeps runtime batch exemptions and refuses failed or foreign partners", async (t) => {
  for (const kind of ["runtime"]) {
    for (const partnerState of ["queued", "done", "failed", "foreign"] as const) {
      const db = seed(t);
      if (kind === "library") library(db);
      else runtime(db);
      const key = kind === "library" ? "llhttp" : "node";
      const dependent = kind === "library" ? "eza" : "tool";
      const from = kind === "library" ? "9.4.3" : "26.10.0";
      const to = kind === "library" ? "9.5.0" : "27.0.0";
      const partnerMachine = partnerState === "foreign" ? "hub" : "mini";
      const batch = enqueueBatch(db, [
        { installId: id(db, key), machineId: "mini", from, to },
        { installId: id(db, dependent, partnerMachine), machineId: partnerMachine, from: "1.0.0", to: "2.0.0" },
      ]);
      if (partnerState === "done" || partnerState === "failed") setJobState(db, batch.jobs[1]!.id, partnerState);
      let checks = 0;
      let upgrades = 0;
      const exec: Exec = async (_transport, argv) => {
        if (argv[1] === "list") return { exitCode: 0, stdout: `${key} ${checks++ === 0 ? from : to}`, stderr: "" };
        if (argv[1] === "upgrade" && !argv.includes("--dry-run")) upgrades++;
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      await runJob(db, batch.jobs[0]!, { machines, exec }, new AbortController().signal);
      const allowed = partnerState === "queued" || partnerState === "done";
      assert.equal(jobById(db, batch.jobs[0]!.id)?.state, allowed ? "done" : "failed", `${kind}/${partnerState}`);
      assert.equal(upgrades, allowed ? 1 : 0);
    }
  }
});

test("the Homebrew live guard keeps dry-run and installed-user probes and refuses shared libraries", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_transport, argv) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: argv.includes("--dry-run") ? "==> Would install 1 dependency:\nlibffi 1.0\n==> Would upgrade 2 outdated packages:\neza 1.0 -> 2.0\nllhttp 9.4.3 -> 9.5.0\n" : "eza\nnode\n", stderr: "" };
  };
  const result = await dependencyRisk(exec, { type: "local" }, "eza", 1000, new AbortController().signal);
  assert.deepEqual(calls, [["brew", "upgrade", "--dry-run", "eza"], ["brew", "uses", "--installed", "--formula", "llhttp"]]);
  assert.equal(result?.message, "llhttp is used by node; update them together or leave this one");
  assert.equal(result?.report, result?.message);
  assert.deepEqual(wouldUpgrade("Already up-to-date.\n"), []);
});
