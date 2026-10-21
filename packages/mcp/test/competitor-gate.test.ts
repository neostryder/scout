import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { localPaths } from "@scout/ops";
import { createTools } from "../src/index.ts";

const FILE = {
  dossierRoot: "d", mirrorRoot: "m",
  entries: [{ id: "a", name: "A", flags: [] }, { id: "b", name: "B", flags: [], gate: { minCommits: 9 } }],
};

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = localPaths(dir);
  mkdirSync(dirname(paths.competitors), { recursive: true });
  writeFileSync(paths.competitors, JSON.stringify(FILE));
  const tools = createTools({ paths });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, name);
    return tool!.run(args);
  };
  return { call, read: () => JSON.parse(readFileSync(paths.competitors, "utf8")), tools };
}

test("the gate and watch tools are listed as writers", (t) => {
  const { tools } = harness(t);
  for (const name of ["scout_competitor_gate", "scout_competitor_watch"]) assert.equal(tools.find((tool) => tool.name === name)?.readOnly, false, name);
});

test("the gate tool reads defaults and overrides when given nothing", async (t) => {
  const { call } = harness(t);
  const settings = await call("scout_competitor_gate");
  assert.equal(settings.defaults.minCommits, 5);
  assert.deepEqual(settings.global, {});
  assert.deepEqual(settings.entries, [{ id: "b", name: "B", gate: { minCommits: 9 } }]);
});

test("the gate tool changes the file-wide gate or one competitor and can clear a field", async (t) => {
  const { call, read } = harness(t);
  const wide = await call("scout_competitor_gate", { set: { minCommits: 12, quietHours: 0 } });
  assert.deepEqual(wide.global, { minCommits: 12, quietHours: 0 });
  assert.deepEqual(read().gate, { minCommits: 12, quietHours: 0 });
  const own = await call("scout_competitor_gate", { id: "a", set: { onNewTag: false } });
  assert.deepEqual(own.entries.find((entry: { id: string }) => entry.id === "a").gate, { onNewTag: false });
  await call("scout_competitor_gate", { id: "a", clear: ["onNewTag"] });
  assert.equal("gate" in read().entries[0], false);
  assert.deepEqual(read().entries[1].gate, { minCommits: 9 });
});

test("the gate tool refuses bad input and leaves the file as it was", async (t) => {
  const { call, read } = harness(t);
  await assert.rejects(() => call("scout_competitor_gate", { set: { minCommits: "many" } }), /whole number/);
  await assert.rejects(() => call("scout_competitor_gate", { set: { nope: 1 } }), /unknown gate field/);
  await assert.rejects(() => call("scout_competitor_gate", { id: "zzz", set: { minCommits: 1 } }), /unknown competitor/);
  await assert.rejects(() => call("scout_competitor_gate", { set: [] }), /set must be an object/);
  await assert.rejects(() => call("scout_competitor_gate", { clear: [1] }), /clear must be a list/);
  assert.deepEqual(read(), FILE);
});

test("the watch tool sets, replaces, and removes a watch source", async (t) => {
  const { call, read } = harness(t);
  await call("scout_competitor_watch", { id: "a", watch: { kind: "json", url: "https://example.com/a.json", versionPath: "version" } });
  assert.deepEqual(read().entries[0].watch, { kind: "json", url: "https://example.com/a.json", versionPath: "version" });
  await call("scout_competitor_watch", { id: "a", watch: { kind: "hash", url: "https://example.com/p" } });
  assert.deepEqual(read().entries[0].watch, { kind: "hash", url: "https://example.com/p" });
  await call("scout_competitor_watch", { id: "a", watch: null });
  assert.equal("watch" in read().entries[0], false);
});

test("the watch tool refuses an unsafe address, a missing watch, and an unknown competitor", async (t) => {
  const { call, read } = harness(t);
  await assert.rejects(() => call("scout_competitor_watch", { id: "a", watch: { kind: "hash", url: "http://example.com/p" } }), /https/);
  await assert.rejects(() => call("scout_competitor_watch", { id: "a", watch: { kind: "hash", url: "https://localhost/p" } }), /public host/);
  await assert.rejects(() => call("scout_competitor_watch", { id: "a" }), /watch is required/);
  await assert.rejects(() => call("scout_competitor_watch", { id: "zzz", watch: null }), /unknown competitor/);
  assert.deepEqual(read(), FILE);
});
