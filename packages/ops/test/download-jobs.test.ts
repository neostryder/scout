import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, jobById, openCatalog, recordResearch, recordScan, upsertMachine, type ConfirmedDownload, type Exec } from "@scout/core";
import { planDownloadCommands } from "../src/plan.ts";
import { runJob, Runner, type ResolvedDownload } from "../src/runner.ts";

const hash = "a".repeat(64);
function fixture(platform: "macos" | "windows" = "macos", sha256: string | null = hash) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "target", name: "Target", os: platform, kind: "host" });
  recordScan(db, "target", { sourceKind: "app", location: "", status: "ok", installs: [{ ecosystem: "bundle", key: "org.example.demo", name: "Demo", kind: "app", version: "1.0", location: "/Applications/Demo.app" }] }, new Date().toISOString());
  const { id, package_id: packageId } = db.prepare("SELECT id, package_id FROM installs").get() as { id: number; package_id: number };
  recordResearch(db, packageId, "github", "ok", [{ channel: "stable", version: "2.0", installable: false }], null);
  const download: ConfirmedDownload = { url: "https://vendor.example.test/Demo.dmg", fileName: "Demo.dmg", size: 123, sha256, source: "github", platform, arch: "x64", version: "2.0", installed: "1.0" };
  const plan: ResolvedDownload = { preview: { installId: id, machineId: "target", name: "Demo", kind: "file", ...download, folder: "~/Downloads", warnings: [], allowed: true, refusal: null }, download, transport: { type: "ssh", target: "target" } };
  const job = enqueueBatch(db, [{ installId: id, machineId: "target", from: "1.0", to: "2.0", download }]).jobs[0]!;
  return { db, id, download, plan, job };
}

test("download jobs resolve, download, verify and retain the target's collision-free path", async () => {
  for (const platform of ["macos", "windows"] as const) {
    const f = fixture(platform);
    const commands = planDownloadCommands(f.download);
    const calls: string[][] = [];
    const exec: Exec = async (transport, argv) => {
      assert.deepEqual(transport, f.plan.transport);
      calls.push(argv);
      return { exitCode: 0, stdout: argv === calls[0] ? "created\n" : platform === "macos" ? "/Users/fixture/Downloads/Demo (1).dmg\n" : "C:/Users/fixture/Downloads/Demo (1).dmg\n", stderr: "" };
    };
    await runJob(f.db, f.job, { machines: [], exec, resolveDownload: async (_id, fresh) => { assert.equal(fresh, true); return f.plan; } }, new AbortController().signal);
    const job = jobById(f.db, f.job.id)!;
    assert.equal(job.action, "download");
    assert.equal(job.state, "done");
    assert.deepEqual(job.steps.map((step) => step.name), ["resolve", "download", "verify"]);
    assert.ok(job.finalPath?.endsWith("Demo (1).dmg"));
    assert.deepEqual(calls, [commands.download, commands.verify]);
    assert.equal((f.db.prepare("SELECT version FROM installs").get() as { version: string }).version, "1.0");
    f.db.close();
  }
});

test("download jobs refuse changed metadata before any target command", async () => {
  for (const [key, value] of [["sha256", "b".repeat(64)], ["size", 124], ["url", "https://vendor.example.test/new.dmg"], ["fileName", "new.dmg"], ["version", "3.0"], ["platform", "windows"], ["arch", "arm64"], ["installed", "1.1"]] as const) {
    const f = fixture();
    let calls = 0;
    await runJob(f.db, f.job, { machines: [], exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; }, resolveDownload: async () => ({ ...f.plan, download: { ...f.download, [key]: value } }) }, new AbortController().signal);
    assert.equal(jobById(f.db, f.job.id)?.state, "failed", key);
    assert.equal(calls, 0);
    f.db.close();
  }
});

test("download jobs remove owned partial files after failures and stops", async () => {
  for (const failure of ["download", "verify", "stop"] as const) {
    const f = fixture();
    const commands = planDownloadCommands(f.download);
    const calls: string[][] = [];
    const controller = new AbortController();
    const exec: Exec = async (_transport, argv, _timeout, signal) => {
      calls.push(argv);
      if (calls.length === 1) {
        if (failure === "stop") controller.abort();
        return { exitCode: failure === "download" ? 1 : 0, stdout: "created\n", stderr: "" };
      }
      if (argv[argv.length - 1] === f.download.fileName) assert.equal(signal, undefined);
      return { exitCode: failure === "verify" && calls.length === 2 ? 1 : 0, stdout: "", stderr: "" };
    };
    await runJob(f.db, f.job, { machines: [], exec, resolveDownload: async () => f.plan }, controller.signal);
    assert.deepEqual(calls.at(-1), commands.cleanup);
    assert.equal(jobById(f.db, f.job.id)?.state, failure === "stop" ? "stopped" : "failed");
    f.db.close();
  }
});

test("download jobs leave pre-existing partial files alone and record missing checksums", async () => {
  const f = fixture("macos", null);
  let calls = 0;
  await runJob(f.db, f.job, { machines: [], exec: async () => { calls++; return { exitCode: 1, stdout: "", stderr: "existing file" }; }, resolveDownload: async () => f.plan }, new AbortController().signal);
  assert.equal(calls, 1);
  const second = enqueueBatch(f.db, [{ installId: f.id, machineId: "target", from: "1.0", to: "2.0", download: f.download }]).jobs[0]!;
  calls = 0;
  await runJob(f.db, second, { machines: [], exec: async () => ({ exitCode: 0, stdout: ++calls === 1 ? "created\n" : "/Users/fixture/Downloads/Demo.dmg\n", stderr: "" }), resolveDownload: async () => f.plan }, new AbortController().signal);
  assert.ok(jobById(f.db, second.id)?.steps.at(-1)?.output?.endsWith("unverified"));
  f.db.close();
});

test("download argv uses fixed scripts, positional input, HTTPS limits and no-overwrite moves", () => {
  for (const platform of ["macos", "windows"] as const) {
    const f = fixture(platform);
    const commands = planDownloadCommands(f.download);
    const scriptIndex = platform === "macos" ? 2 : 4;
    assert.equal(commands.download[0], platform === "macos" ? "zsh" : "pwsh");
    assert.equal(commands.download[scriptIndex]?.includes(f.download.url), false);
    assert.equal(commands.download[scriptIndex]?.includes(f.download.fileName), false);
    assert.deepEqual(commands.download.slice(scriptIndex + (platform === "macos" ? 2 : 1)), [f.download.url, f.download.fileName]);
    if (platform === "macos") {
      assert.ok(commands.download[2]?.includes("curl -fL --globoff --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize 2147483648"));
      assert.ok(commands.verify[2]?.includes("shasum -a 256"));
      assert.ok(commands.verify[2]?.includes("mv -n --"));
      assert.ok(commands.cleanup[2]?.startsWith("rm -f --"));
    } else {
      assert.equal(commands.download[3], "-CommandWithArgs");
      assert.ok(commands.download[4]?.includes("Invoke-WebRequest -Uri $args[0]"));
      assert.ok(commands.verify[4]?.includes("Get-FileHash -LiteralPath"));
      assert.ok(commands.verify[4]?.includes("[IO.File]::Move($part, $dest, $false)"));
      assert.ok(commands.cleanup[4]?.includes("Remove-Item -LiteralPath"));
    }
    for (const argv of Object.values(commands)) assert.ok(!/Start-Process|brew|winget|open |Invoke-Expression/.test(argv[scriptIndex] ?? ""));
    f.db.close();
  }
});

test("download runner keeps jobs on one machine serial", async () => {
  const f = fixture();
  recordScan(f.db, "target", { sourceKind: "app", location: "", status: "partial", installs: [{ ecosystem: "bundle", key: "org.example.second", name: "Second", kind: "app", version: "1.0", location: "/Applications/Second.app" }] }, new Date().toISOString());
  const secondId = (f.db.prepare("SELECT id FROM installs WHERE id != ?").get(f.id) as { id: number }).id;
  const second = enqueueBatch(f.db, [{ installId: secondId, machineId: "target", from: "1.0", to: "2.0", download: f.download }]).jobs[0]!;
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const runner = new Runner(f.db, { machines: [{ id: "target", transport: f.plan.transport! }], resolveDownload: async (installId) => ({ ...f.plan, preview: { ...f.plan.preview, installId } }), exec: async (_transport, argv) => {
    maximum = Math.max(maximum, ++active); calls++;
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { exitCode: 0, stdout: argv.at(-1) === f.download.fileName ? "created\n" : "/Users/fixture/Downloads/Demo.dmg\n", stderr: "" };
  } });
  for (let n = 0; n < 40 && jobById(f.db, second.id)?.state !== "done"; n++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(jobById(f.db, second.id)?.state, "done");
  assert.equal(maximum, 1);
  assert.equal(calls, 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.jobs().active, 0);
  f.db.close();
});

test("download runner stops the rest of a batch after a download failure", async () => {
  const f = fixture();
  f.db.prepare("UPDATE jobs SET state = 'stopped' WHERE id = ?").run(f.job.id);
  recordScan(f.db, "target", { sourceKind: "app", location: "", status: "partial", installs: [{ ecosystem: "bundle", key: "org.example.second", name: "Second", kind: "app", version: "1.0", location: "/Applications/Second.app" }] }, new Date().toISOString());
  const secondId = (f.db.prepare("SELECT id FROM installs WHERE id != ?").get(f.id) as { id: number }).id;
  const batch = enqueueBatch(f.db, [f.id, secondId].map((installId) => ({ installId, machineId: "target", from: "1.0", to: "2.0", download: f.download })));
  let calls = 0;
  const runner = new Runner(f.db, { machines: [{ id: "target", transport: f.plan.transport! }], resolveDownload: async (installId) => ({ ...f.plan, preview: { ...f.plan.preview, installId } }), exec: async () => ({ exitCode: ++calls === 1 ? 1 : 0, stdout: "created\n", stderr: "" }) });
  for (let n = 0; n < 40 && jobById(f.db, batch.jobs[1]!.id)?.state !== "stopped"; n++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(jobById(f.db, batch.jobs[0]!.id)?.state, "failed");
  assert.equal(jobById(f.db, batch.jobs[1]!.id)?.state, "stopped");
  assert.equal(calls, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.jobs().active, 0);
  f.db.close();
});
