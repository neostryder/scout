import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, openCatalog, recordResearch, recordScan, upsertMachine, type Db, type Exec } from "@scout/core";
import { planUpdate } from "../src/plan.ts";
import { cleanOutput, Runner } from "../src/runner.ts";

const machine = { transport: { type: "local" as const } };

test("every supported ecosystem builds an update and read-only verify argv", () => {
  const cases: [string, string, string[], string[], string, string][] = [
    // These outputs are hand-written examples of the documented tool formats.
    ["winget", "Git.Git", ["winget", "upgrade", "--id", "Git.Git", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--version", "2.0"], ["winget", "list", "--id", "Git.Git", "--exact"], "Name  Id  Version\nGit  Git.Git  2.0\n", "2.0"],
    ["msstore", "9WZDNCRFJ3Q8", ["winget", "upgrade", "--id", "9WZDNCRFJ3Q8", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--version", "2.0", "--source", "msstore"], ["winget", "list", "--id", "9WZDNCRFJ3Q8", "--exact"], "Name  Id  Version\nApp  9WZDNCRFJ3Q8  2.0\n", "2.0"],
    ["brew", "git", ["brew", "upgrade", "git"], ["brew", "list", "--versions", "git"], "git 2.0\n", "2.0"],
    ["cask", "firefox", ["brew", "upgrade", "--cask", "firefox"], ["brew", "list", "--versions", "--cask", "firefox"], "firefox 2.0\n", "2.0"],
    ["npm", "@scope/tool", ["npm", "install", "-g", "@scope/tool@2.0"], ["npm", "ls", "-g", "--json", "@scope/tool"], '{"dependencies":{"@scope/tool":{"version":"2.0"}}}', "2.0"],
    ["pipx", "ruff", ["pipx", "upgrade", "ruff"], ["pipx", "list", "--json"], '{"venvs":{"ruff":{"metadata":{"main_package":{"package_version":"2.0"}}}}}', "2.0"],
    ["uv-tool", "ruff", ["uv", "tool", "upgrade", "ruff"], ["uv", "tool", "list"], "ruff v2.0\n- ruff\n", "2.0"],
  ];
  for (const [ecosystem, key, argv, verify, stdout, version] of cases) {
    const plan = planUpdate({ ecosystem, key, kind: "package" }, "2.0", machine);
    assert.equal(plan.allowed, true, ecosystem);
    assert.deepEqual(plan.argv, argv);
    assert.deepEqual(plan.verify.argv, verify);
    assert.equal(plan.verify.parse(stdout), version);
  }
  assert.equal(planUpdate({ ecosystem: "cargo", key: "x", kind: "package" }, "2.0", machine).allowed, false);
  assert.equal(planUpdate({ ecosystem: "brew", key: "x;touch", kind: "package" }, "2.0", machine).argv.length, 0);
  assert.equal(planUpdate({ ecosystem: "brew", key: "x", kind: "package" }, "2.0;touch", machine).argv.length, 0);
  assert.equal(planUpdate({ ecosystem: "brew", key: "x", kind: "package", details: { requiresSudo: true } }, "2.0", machine).refusal, "needs admin; Scout cannot elevate yet");
});

test("runner verifies, writes the installed version, and redacts output", async () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [{ ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.0", location: "" }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages WHERE key = 'git'").get() as { id: number }).id;
  const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
  recordResearch(db, pkg, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  let checks = 0;
  const exec: Exec = async (_transport, argv) => {
    if (argv[1] === "list") return { exitCode: 0, stdout: `git ${++checks === 1 ? "1.0" : "2.0"}\nSECRET=value\n`, stderr: "" };
    return { exitCode: 0, stdout: "updated", stderr: "" };
  };
  const runner = new Runner(db, { machines: [{ id: "mini", ...machine }], exec });
  const job = enqueueBatch(db, [{ installId: id, machineId: "mini", from: "1.0", to: "2.0" }]).jobs[0]!;
  runner.wake();
  for (let n = 0; n < 20 && runner.jobs().jobs[0]?.state !== "done"; n++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(runner.jobs().jobs[0]?.state, "done");
  assert.equal((db.prepare("SELECT version FROM installs WHERE id = ?").get(id) as { version: string }).version, "2.0");
  assert.ok(!runner.jobs().jobs[0]?.steps[0]?.output?.includes("SECRET"));
  assert.equal(cleanOutput(`A=${"x".repeat(9000)}\nhello`).length, 5);
  assert.equal(job.id, runner.jobs().jobs[0]?.id);
  db.close();
});

function seeded(machineIds: string[] = ["mini"]): { db: Db; ids: number[] } {
  const db = openCatalog(":memory:");
  for (const machineId of machineIds) {
    upsertMachine(db, { id: machineId, name: machineId, os: "macos", kind: "host" });
    recordScan(db, machineId, { sourceKind: "brew", location: "", status: "ok", installs: [
      { ecosystem: "brew", key: `${machineId}-tool`, name: `${machineId}-tool`, kind: "package", version: "1.0", location: "" },
    ] }, new Date().toISOString());
  }
  const packages = db.prepare("SELECT id FROM packages").all() as { id: number }[];
  for (const pkg of packages) recordResearch(db, pkg.id, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  return { db, ids: (db.prepare("SELECT id FROM installs ORDER BY id").all() as { id: number }[]).map((r) => r.id) };
}

test("preflight rejects changed installs, withdrawn answers, and freezes", async () => {
  for (const change of ["version", "answer", "freeze"]) {
    const { db, ids } = seeded();
    const id = ids[0]!;
    const job = enqueueBatch(db, [{ installId: id, machineId: "mini", from: "1.0", to: "2.0" }]).jobs[0]!;
    if (change === "version") db.prepare("UPDATE installs SET version = '1.5' WHERE id = ?").run(id);
    if (change === "answer") db.prepare("UPDATE assertions SET version = '1.0' WHERE version = '2.0'").run();
    if (change === "freeze") db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '1.0', 'test', ?)").run(id, new Date().toISOString());
    let calls = 0;
    const exec: Exec = async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; };
    const runner = new Runner(db, { machines: [{ id: "mini", ...machine }], exec });
    runner.wake();
    for (let n = 0; n < 20 && runner.jobs().jobs[0]?.state !== "failed"; n++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(runner.jobs().jobs[0]?.state, "failed", change);
    assert.equal(calls, 0, change);
    assert.equal(runner.jobs().jobs[0]?.id, job.id);
    await new Promise((resolve) => setImmediate(resolve));
    db.close();
  }
});

test("a brew job refreshes Homebrew before the upgrade and keeps the end of long output", async () => {
  const { db, ids } = seeded();
  enqueueBatch(db, [{ installId: ids[0]!, machineId: "mini", from: "1.0", to: "2.0" }]);
  const order: string[] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  let listed = 0;
  const exec: Exec = async (_transport, argv, _timeout, _signal, env) => {
    order.push(argv.slice(0, 2).join(" "));
    envs.push(env);
    if (argv[1] === "list") return { exitCode: 0, stdout: listed++ === 0 ? "mini-tool 1.0" : "mini-tool 1.0 2.0", stderr: "" };
    if (argv[1] === "upgrade") return { exitCode: 0, stdout: `${"Removing: cache\n".repeat(1000)}upgraded mini-tool`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new Runner(db, { machines: [{ id: "mini", ...machine }], exec });
  runner.wake();
  for (let n = 0; n < 20 && runner.jobs().jobs[0]?.state !== "done"; n++) await new Promise((r) => setTimeout(r, 1));
  const job = runner.jobs().jobs[0]!;
  assert.equal(job.state, "done");
  assert.deepEqual(order, ["brew list", "brew update", "brew upgrade", "brew upgrade", "brew cleanup", "brew list"]);
  assert.deepEqual(job.steps.map((s) => s.name), ["preflight", "refresh", "dependencies", "update", "cleanup", "verify"]);
  assert.ok(job.steps.find((s) => s.name === "update")?.output?.trimEnd().endsWith("upgraded mini-tool"));
  assert.equal(envs[2]?.HOMEBREW_NO_INSTALL_CLEANUP, "1");
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});

test("two machines run together while each machine stays serial", async () => {
  const { db, ids } = seeded(["mini", "laptop"]);
  const first = ids[0]!;
  const second = ids[1]!;
  const jobs = enqueueBatch(db, [{ installId: first, machineId: "mini", from: "1.0", to: "2.0" }, { installId: second, machineId: "laptop", from: "1.0", to: "2.0" }]).jobs;
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const exec: Exec = async (transport, argv) => {
    const key = argv.at(-1) ?? "";
    if (argv[1] === "list") return { exitCode: 0, stdout: `${key} 1.0`, stderr: "" };
    if (argv[1] === "update" || argv.includes("--dry-run")) return { exitCode: 0, stdout: "", stderr: "" };
    started.push(key);
    await new Promise<void>((resolve) => release.set(key, resolve));
    return { exitCode: 1, stdout: "", stderr: "failed" };
  };
  const runner = new Runner(db, { machines: [{ id: "mini", ...machine }, { id: "laptop", ...machine }], exec });
  runner.wake();
  for (let n = 0; n < 20 && started.length < 2; n++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(started.length, 2);
  for (const done of release.values()) done();
  for (let n = 0; n < 20 && runner.jobs().jobs.some((j) => j.state === "running"); n++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(runner.jobs().jobs.filter((j) => j.state === "failed").length, 2);
  assert.equal(jobs.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});
