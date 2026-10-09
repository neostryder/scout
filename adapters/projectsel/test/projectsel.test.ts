import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fixtureTests } from "@scout/core/testing";
import { adapter } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/projectsel", import.meta.url));
fixtureTests(adapter, dir);

test("projectsel: probes keep roots in data arguments and scripts fixed", () => {
  const roots = ["/projects/app with spaces", "/projects/$(touch unwanted)"];
  const unix = adapter.probes({ machineId: "a", os: "linux", roots: { project: roots } }, "")[0]!;
  const fallback = adapter.probes({ machineId: "a", os: "macos", roots: {} }, "")[0]!;
  assert.deepEqual(unix.argv.slice(3), ["projectsel", ...roots]);
  assert.equal(unix.argv[2], fallback.argv[2]);
  assert.ok(unix.argv[2]!.includes('set -- "$HOME"'));
  assert.ok(unix.argv[2]!.includes("-maxdepth 5"));
  assert.ok(unix.argv[2]!.includes('head -c 400 "$file"'));
  assert.ok(unix.argv[2]!.includes('"$count" -ge 300'));
  assert.equal(adapter.probes({ machineId: "a", os: "linux", roots: { project: [] } }, "")[0]?.argv[2], "exit 0");
  const windows = adapter.probes({ machineId: "a", os: "windows", roots: { project: ["C:/projects/a'; exit 1; '"] } }, "")[0]!;
  assert.equal(windows.argv[3], "-CommandWithArgs");
  assert.deepEqual(JSON.parse(windows.argv[5]!), ["C:/projects/a'; exit 1; '"]);
  const noRoots = adapter.probes({ machineId: "a", os: "windows", roots: {} }, "")[0]!;
  assert.deepEqual(JSON.parse(noRoots.argv[5]!), []);
  assert.equal(windows.argv[4], noRoots.argv[4]);
  const discovered = adapter.probes({ machineId: "a", os: "windows", roots: { repositories: ["C:/Repositories"] } }, "")[0]!;
  assert.deepEqual(JSON.parse(discovered.argv[5]!), ["C:/Repositories"]);
});

test("projectsel: missing and interrupted output retains scan status", () => {
  assert.equal(adapter.parse({}, "").status, "failed");
  assert.equal(adapter.parse({ list: { exitCode: 1, stdout: "", stderr: "unreadable root" } }, "").status, "failed");
  const result = adapter.parse({ list: { exitCode: 1, stdout: "=== /projects/app/.nvmrc\n24\n", stderr: "unreadable file" } }, "");
  assert.equal(result.status, "partial");
  assert.equal(result.selectors?.[0]?.spec, "24");
  assert.deepEqual(result.installs, []);
});

test("projectsel: Windows probe bounds file bytes, depth and count and prunes excluded folders", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(`${dir}/.probe-`).replaceAll("\\", "/");
  try {
    const app = `${root}/app with spaces`;
    mkdirSync(app);
    writeFileSync(`${app}/.nvmrc`, "24".padEnd(500, " "));
    for (const name of ["node_modules", ".git", "Library", ".Trash", ".cache", "cache", "caches", "Caches", ".nvm", ".pyenv", ".asdf", ".rustup", ".cargo"]) {
      mkdirSync(`${app}/${name}`, { recursive: true });
      writeFileSync(`${app}/${name}/.node-version`, "99");
    }
    mkdirSync(`${root}/a/b/c/d/e`, { recursive: true });
    writeFileSync(`${root}/a/b/c/d/.python-version`, "3.13");
    writeFileSync(`${root}/a/b/c/d/e/.python-version`, "99");
    const probe = adapter.probes({ machineId: "a", os: "windows", roots: { project: [root] } }, "")[0]!;
    const run = () => spawnSync(probe.argv[0]!, probe.argv.slice(1), { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const output = first.stdout.replaceAll("\r", "");
    const blocks = output.split(/^=== /m).slice(1);
    assert.equal(blocks.length, 2);
    const node = blocks.find((block) => block.startsWith(`${app}/.nvmrc\n`))!;
    assert.equal(Buffer.byteLength(node.slice(node.indexOf("\n") + 1).replace(/\n$/, "")), 400);
    const parsed = adapter.parse({ list: { exitCode: first.status!, stdout: first.stdout, stderr: first.stderr } }, "");
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.selectors?.map((item) => item.spec).sort(), ["24", "3.13"]);
    for (let index = 0; index < 305; index++) {
      const folder = `${root}/project-${index}`;
      mkdirSync(folder);
      writeFileSync(`${folder}/.node-version`, "24");
    }
    const bounded = run();
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.equal(bounded.stdout.split(/^=== /m).length - 1, 300);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
test("projectsel: Unix probe reads only selectors inside supplied roots", { skip: !existsSync(bash) }, () => {
  const root = mkdtempSync(`${dir}/.probe-`).replaceAll("\\", "/");
  try {
    mkdirSync(`${root}/app with spaces/node_modules`, { recursive: true });
    mkdirSync(`${root}/a/b/c/d/e`, { recursive: true });
    writeFileSync(`${root}/app with spaces/.nvmrc`, "24".padEnd(500, " "));
    writeFileSync(`${root}/app with spaces/node_modules/.nvmrc`, "99");
    writeFileSync(`${root}/a/b/c/d/.node-version`, "26");
    writeFileSync(`${root}/a/b/c/d/e/.node-version`, "99");
    const unixRoot = root.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const probe = adapter.probes({ machineId: "a", os: "linux", roots: { project: [unixRoot] } }, "")[0]!;
    const run = spawnSync(bash, probe.argv.slice(1), { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    const parsed = adapter.parse({ list: { exitCode: run.status!, stdout: run.stdout, stderr: run.stderr } }, "");
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.selectors?.map((item) => item.spec).sort(), ["24", "26"]);
    assert.equal(run.stdout.split(/^=== /m).length - 1, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
