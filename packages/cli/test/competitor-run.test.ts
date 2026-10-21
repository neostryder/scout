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
