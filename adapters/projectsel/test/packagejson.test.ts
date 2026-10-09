import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapter } from "../src/index.ts";

// A real package.json keeps packageManager and engines far past the first few hundred bytes.
const bigPackageJson = JSON.stringify({ name: "big", description: "x".repeat(3000), scripts: { build: "tsc" }, engines: { node: ">=24" }, packageManager: "pnpm@12.3.4" }, null, 2);

function withProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "scout-projectsel-"));
  try {
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "package.json"), bigPackageJson);
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "plain", "package.json"), JSON.stringify({ name: "plain", description: "no selectors" }));
    fn(root.replaceAll("\\", "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function probeSelectors(os: "macos" | "windows", root: string, shell: string | null): { status: string; files: string[]; specs: string[] } | null {
  const probe = adapter.probes({ machineId: "t", os, roots: { project: [root] } }, "")[0]!;
  const [file, ...args] = probe.argv;
  const run = spawnSync(shell ?? file!, shell ? args : args, { encoding: "utf8", windowsHide: true });
  if (run.error) return null;
  const result = adapter.parse({ list: { exitCode: run.status ?? -1, stdout: run.stdout, stderr: run.stderr } }, "");
  return { status: result.status, files: (result.selectors ?? []).map((s) => s.file.slice(root.length)), specs: (result.selectors ?? []).map((s) => `${s.kind}:${s.tool}:${s.spec}`) };
}

test("the Windows probe reads packageManager and engines from a large package.json and skips one without them", () => {
  withProject((root) => {
    const got = probeSelectors("windows", root, null);
    if (!got) return;
    assert.equal(got.status, "ok");
    assert.deepEqual(got.specs.sort(), ["engines:node:>=24", "packageManager:pnpm:12.3.4"]);
    assert.ok(got.files.every((f) => f === "/app/package.json"));
  });
});

test("the Unix probe reads packageManager and engines from a large package.json and skips one without them", (t) => {
  withProject((root) => {
    const probe = adapter.probes({ machineId: "t", os: "macos", roots: { project: [root] } }, "")[0]!;
    const bash = spawnSync("bash", ["-c", "true"], { windowsHide: true });
    if (bash.error) return t.skip("bash is not available");
    const got = probeSelectors("macos", root, null);
    if (!got) return;
    assert.equal(probe.argv[0], "/bin/bash");
    assert.equal(got.status, "ok");
    assert.deepEqual(got.specs.sort(), ["engines:node:>=24", "packageManager:pnpm:12.3.4"]);
  });
});
