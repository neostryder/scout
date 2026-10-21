import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter, normalizeRemote } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/gitclone", import.meta.url));
fixtureTests(adapter, dir);

const readScript = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("probe scripts match the checked-in files", () => {
  const ps1 = readScript("../../../tools/probes/windows/gitclone.ps1");
  const linux = readScript("../../../tools/probes/linux/gitclone.sh");
  const macos = readScript("../../../tools/probes/macos/gitclone.sh");
  assert.equal(linux, macos);
  const roots = ["/tmp/clones"];
  const ctx = { machineId: "m", os: "linux" as const, roots: { clone: roots } };
  assert.deepEqual(adapter.probes(ctx, ""), [{ id: "list", argv: ["/bin/sh", "-c", linux, "gitclone", ...roots] }]);
  assert.deepEqual(adapter.probes({ ...ctx, os: "macos" }, ""), [{ id: "list", argv: ["/bin/sh", "-c", macos, "gitclone", ...roots] }]);
  assert.deepEqual(adapter.probes({ ...ctx, os: "windows" }, ""), [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-CommandWithArgs", ps1, ...roots] }]);
  for (const script of [ps1, linux, macos]) {
    assert.equal(script.includes("git fetch"), false);
    assert.equal(script.includes("git pull"), false);
    assert.equal(script.includes("git gc"), false);
    assert.equal(script.includes("safe.directory"), false);
  }
});

test("remote normalization keeps one key for the same repository", () => {
  const location = "/tmp/Repo";
  const same = "github.com/owner/repo";
  for (const remote of [
    "https://github.com/Owner/Repo.git",
    "ssh://git@github.com/Owner/Repo.git",
    "git@github.com:Owner/Repo.git",
    "https://user:fixture-token@github.com/Owner/Repo.git",
    "HTTPS://GitHub.COM/Owner/Repo.GIT",
    "ssh://git@github.com:22/Owner/Repo.git",
    "https://github.com:443/Owner/Repo/",
  ]) {
    const parsed = normalizeRemote(remote, location);
    assert.equal(parsed?.key, same);
    assert.equal(parsed?.name, "Repo");
    assert.equal(parsed?.homepage, "https://github.com/Owner/Repo");
    assert.equal(JSON.stringify(parsed).includes("fixture-token"), false);
  }
  const unknown = normalizeRemote("https://git.example.com/Org/Tool.git", location);
  assert.equal(unknown?.key, "git.example.com/org/tool");
  assert.equal(unknown?.homepage, null);
  assert.equal(unknown?.name, "Tool");
  assert.equal(normalizeRemote("not a remote", location)?.key, "not a remote");
  assert.equal(normalizeRemote("C:/Repos/foo", location)?.key, "C:/Repos/foo");
  assert.equal(normalizeRemote("https://gitlab.com/Owner/Repo.git", location)?.homepage, "https://gitlab.com/Owner/Repo");
  assert.equal(normalizeRemote("https://codeberg.org/Owner/Repo.git", location)?.homepage, "https://codeberg.org/Owner/Repo");
  assert.equal(normalizeRemote("https://bitbucket.org/Owner/Repo.git", location)?.homepage, "https://bitbucket.org/Owner/Repo");
  assert.equal(normalizeRemote("  ", location), null);
});

test("a token in a remote never appears in the parse", () => {
  const stdout = [
    "---SCOUT-REPO---",
    "path=/tmp/Repo",
    "remote=https://user:fixture-token@github.com/Owner/Repo.git",
    "commit=0123456789abcdef0123456789abcdef01234567",
    "branch=main",
    "default=origin/main",
    "describe=v1.2.3-1-g0123456",
    "dirty=0",
    "ahead=1",
    "behind=0",
    "committed=2026-10-18T00:00:00Z",
    "tag=v1.2.3",
    "",
  ].join("\n");
  const result = adapter.parse({ list: { exitCode: 0, stdout, stderr: "" } }, "");
  assert.equal(JSON.stringify(result).includes("fixture-token"), false);
  assert.equal(result.installs[0]?.key, "github.com/owner/repo");
  assert.equal(result.installs[0]?.details?.["remote"], "https://github.com/Owner/Repo.git");
});

test("skipped repos, a missing remote, and a missing tool stay partial or skipped", () => {
  const stdout = [
    "---SCOUT-REPO---",
    "path=/tmp/none",
    "remote=",
    "commit=0123456789abcdef0123456789abcdef01234567",
    "branch=main",
    "default=",
    "describe=0123456",
    "dirty=0",
    "ahead=",
    "behind=",
    "committed=2026-10-18T00:00:00Z",
    "tag=",
    "---SCOUT-SKIP---",
    "path=/tmp/hung",
    "reason=timeout",
    "---SCOUT-REPO---",
    "path=/tmp/bad",
    "remote=https://github.com/Owner/Repo.git",
    "commit=",
    "",
  ].join("\n");
  const result = adapter.parse({ list: { exitCode: 0, stdout, stderr: "" } }, "");
  assert.equal(result.status, "partial");
  assert.equal(result.installs.length, 0);
  assert.equal(result.message, "skipped 1 clone with no remote; skipped 1 timed-out repo; skipped 1 unreadable clone");
  assert.equal(adapter.parse({ list: { exitCode: 0, stdout: "---SCOUT-NO-GIT---\n", stderr: "" } }, "").status, "skipped");
  assert.equal(adapter.parse({ list: { exitCode: 0, stdout: "", stderr: "" } }, "").status, "ok");
  assert.equal(adapter.parse({}, "").message, "probe output missing");
  assert.doesNotThrow(() => adapter.parse({ list: { exitCode: 0, stdout: "garbage\0", stderr: "" } }, ""));
});

test("recorded probes skip hidden names and keep an explicit root", () => {
  for (const name of ["windows-clones", "unix-clones"]) {
    const outputs = JSON.parse(readFileSync(new URL(`../../../fixtures/gitclone/${name}/outputs.json`, import.meta.url), "utf8")) as { list: { stdout: string } };
    const stdout = outputs.list.stdout;
    assert.equal(stdout.includes("/a/b/seen"), true);
    assert.equal(stdout.includes("/_scout-gitclone-explicit"), true);
    assert.equal(stdout.includes("/_hidden"), false);
    assert.equal(stdout.includes("/.hidden"), false);
    assert.equal(stdout.includes("/node_modules"), false);
    assert.equal(stdout.includes("/missed"), false);
    assert.equal(stdout.includes("/wt"), false);
    assert.equal(stdout.includes("fixture-token"), false);
    assert.equal(stdout.includes("neost"), false);
  }
});

test("the shell probe expands a leading tilde root under bash", { skip: spawnSync("bash", ["-c", "exit 0"], { windowsHide: true }).status !== 0 }, () => {
  const home = mkdtempSync(join(tmpdir(), "scout-gc-home-"));
  try {
    mkdirSync(join(home, "code", "demo", ".git"), { recursive: true });
    const argv = adapter.probes({ machineId: "host", os: "linux", roots: { clone: ["~/code"] } }, "")[0]!.argv;
    const run = spawnSync("bash", ["-c", argv[2]!, ...argv.slice(3)], { encoding: "utf8", windowsHide: true, env: { ...process.env, HOME: home.replaceAll("\\", "/") } });
    assert.match(run.stdout, /---SCOUT-REPO---/);
    assert.match(run.stdout, /path=.*demo/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
