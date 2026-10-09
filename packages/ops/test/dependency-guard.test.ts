import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueBatch, openCatalog, recordResearch, recordScan, upsertMachine, type Exec } from "@scout/core";
import { Runner, wouldUpgrade } from "../src/runner.ts";

const machine = { transport: { type: "local" } } as const;

test("wouldUpgrade reads the names under Would upgrade headings and ignores installs and warnings", () => {
  const out = [
    "Warning: The following taps are not trusted:",
    "  some/tap",
    "==> Would install 2 dependencies:",
    "abseil   20260817.0",
    "libffi   3.8.0",
    "==> Would upgrade 3 outdated packages:",
    "eza 0.23.4 -> 0.23.5",
    "llhttp 9.3.1 -> 9.4.3",
    "openssl@3 3.6.4 -> 3.6.5",
    "",
  ].join("\n");
  assert.deepEqual(wouldUpgrade(out), ["eza", "llhttp", "openssl@3"]);
  assert.deepEqual(wouldUpgrade("Already up-to-date.\n"), []);
});

function seeded(): { db: ReturnType<typeof openCatalog>; id: number } {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [{ ecosystem: "brew", key: "eza", name: "eza", kind: "package", version: "1.0", location: "" }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages WHERE key = 'eza'").get() as { id: number }).id;
  recordResearch(db, pkg, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  return { db, id: (db.prepare("SELECT id FROM installs").get() as { id: number }).id };
}

async function runWith(dry: string, users: Record<string, string>): Promise<{ state: string; message: string | null; calls: string[]; steps: string[] }> {
  const { db, id } = seeded();
  const calls: string[] = [];
  let listed = 0;
  const exec: Exec = async (_transport, argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "list") return { exitCode: 0, stdout: listed++ === 0 ? "eza 1.0" : "eza 2.0", stderr: "" };
    if (argv.includes("--dry-run")) return { exitCode: 0, stdout: dry, stderr: "" };
    if (argv[1] === "uses") return { exitCode: 0, stdout: users[argv.at(-1) ?? ""] ?? "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new Runner(db, { machines: [{ id: "mini", ...machine }], exec });
  enqueueBatch(db, [{ installId: id, machineId: "mini", from: "1.0", to: "2.0" }]);
  runner.wake();
  for (let n = 0; n < 50 && !["done", "failed"].includes(runner.jobs().jobs[0]?.state ?? ""); n++) await new Promise((r) => setTimeout(r, 2));
  const job = runner.jobs().jobs[0]!;
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
  return { state: job.state, message: job.message, calls, steps: job.steps.map((s) => `${s.name}:${s.state}`) };
}

test("a brew upgrade that would change a library another program uses is refused before anything changes", async () => {
  const result = await runWith("==> Would upgrade 2 outdated packages:\neza 1.0 -> 2.0\nllhttp 9.3.1 -> 9.4.3\n", { llhttp: "eza\nnode\nlibgit2\n" });
  assert.equal(result.state, "failed");
  assert.match(result.message ?? "", /llhttp is used by node, libgit2/);
  assert.ok(result.steps.includes("dependencies:failed"));
  assert.ok(!result.calls.includes("brew upgrade eza"), "the real upgrade must not run");
});

test("a brew upgrade passes when the changed libraries are used only by the target or by packages upgraded with it", async () => {
  const result = await runWith("==> Would upgrade 3 outdated packages:\neza 1.0 -> 2.0\nlibgit2 1.9.2 -> 1.9.7\nllhttp 9.3.1 -> 9.4.3\n", { libgit2: "eza\n", llhttp: "eza\nlibgit2\n" });
  assert.equal(result.state, "done");
  assert.ok(result.steps.includes("dependencies:done"));
  assert.ok(result.calls.includes("brew upgrade eza"));
});

test("a failed dry run stops the job without upgrading", async () => {
  const { db, id } = seeded();
  const calls: string[] = [];
  const exec: Exec = async (_transport, argv) => {
    calls.push(argv.join(" "));
    if (argv[1] === "list") return { exitCode: 0, stdout: "eza 1.0", stderr: "" };
    if (argv.includes("--dry-run")) return { exitCode: 1, stdout: "", stderr: "Error: boom" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const runner = new Runner(db, { machines: [{ id: "mini", ...machine }], exec });
  enqueueBatch(db, [{ installId: id, machineId: "mini", from: "1.0", to: "2.0" }]);
  runner.wake();
  for (let n = 0; n < 50 && runner.jobs().jobs[0]?.state !== "failed"; n++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(runner.jobs().jobs[0]?.state, "failed");
  assert.match(runner.jobs().jobs[0]?.message ?? "", /could not check what the upgrade would change/);
  assert.ok(!calls.includes("brew upgrade eza"));
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});
