import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { localPaths } from "@scout/ops";
import { runCompetitorTool } from "../src/competitor-run.ts";

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "competitor-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = localPaths(dir);
  mkdirSync(dirname(paths.competitors), { recursive: true });
  writeFileSync(paths.competitors, JSON.stringify({ dossierRoot: "d", mirrorRoot: "m", entries: [{ id: "a", name: "A", flags: [] }] }));
  return paths;
}

test("queue lists an empty queue and gate reads the rules", async (t) => {
  const paths = harness(t);
  assert.deepEqual(await runCompetitorTool("queue", undefined, paths), { runs: [] });
  const gate = (await runCompetitorTool("gate", "{}", paths)) as { defaults: { minCommits: number } };
  assert.equal(gate.defaults.minCommits, 5);
});

test("an unknown command, bad JSON, and a non-object are refused", async (t) => {
  const paths = harness(t);
  await assert.rejects(() => runCompetitorTool("nope", undefined, paths), /usage/);
  await assert.rejects(() => runCompetitorTool(undefined, undefined, paths), /usage/);
  await assert.rejects(() => runCompetitorTool("queue", "{", paths), /must be JSON/);
  await assert.rejects(() => runCompetitorTool("queue", "[]", paths), /JSON object/);
});

test("claim refuses a run that does not exist", async (t) => {
  const paths = harness(t);
  await assert.rejects(() => runCompetitorTool("claim", JSON.stringify({ runId: 99, by: "test" }), paths), /no such run/);
});

test("probe reads a watch source once and saves nothing", async (t) => {
  const paths = harness(t);
  const fetcher = async () => new Response(JSON.stringify({ latest: { version: "3.4.5" } }), { status: 200, headers: { "content-type": "application/json" } });
  const read = (await runCompetitorTool("probe", JSON.stringify({ kind: "json", url: "https://example.com/v.json", versionPath: "latest.version" }), paths, fetcher)) as { version: string; error: string | null };
  assert.equal(read.version, "3.4.5");
  assert.equal(read.error, null);
  await assert.rejects(() => runCompetitorTool("probe", JSON.stringify({ kind: "json", url: "http://example.com/v.json", versionPath: "v" }), paths, fetcher), /https/);
});

test("facts reads a span from GitHub, says whether it is version-only, and saves nothing", async (t) => {
  const paths = harness(t);
  const from = "a".repeat(40);
  const to = "b".repeat(40);
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fetcher = async (url: string) => {
    const path = url.replace("https://api.github.com/repos/example/demo-module", "");
    if (path === "") return reply({ default_branch: "main" });
    if (path.startsWith("/contents?")) return reply([{ name: "module.json" }]);
    if (path.startsWith("/contents/")) return reply({ id: "demo" });
    if (path.startsWith("/compare/")) return reply({ total_commits: 1, base_commit: { commit: { committer: { date: "2026-10-20T00:00:00Z" } } }, commits: [{ sha: to, commit: { message: "Bump", committer: { date: "2026-10-24T00:00:00Z" } } }] });
    if (path.startsWith("/commits/")) return reply({ files: [{ filename: "module.json", patch: '@@ -1 +1 @@\n-  "version": "1.0.0",\n+  "version": "1.0.1",' }] });
    if (path.startsWith("/releases")) return reply([]);
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const args = JSON.stringify({ name: "Example Module", remoteUrl: "https://github.com/example/demo-module", from: { version: "1.0.0", commit: from }, to: { version: "1.0.1", commit: to } });
  const result = (await runCompetitorTool("facts", args, paths, fetcher)) as { versionOnly: boolean; releaseDraft?: string };
  assert.equal(result.versionOnly, true);
  assert.match(result.releaseDraft ?? "", /^# Example Module 1\.0\.0 to 1\.0\.1/);
  assert.deepEqual(await runCompetitorTool("queue", undefined, paths), { runs: [] });
  await assert.rejects(() => runCompetitorTool("facts", JSON.stringify({ runId: 99 }), paths, fetcher), /no queued or claimed run/);
});
