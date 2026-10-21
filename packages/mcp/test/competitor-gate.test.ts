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
  return { call, read: () => JSON.parse(readFileSync(paths.competitors, "utf8")), tools, dir, paths };
}

test("the gate, watch, and repo tools are listed as writers", (t) => {
  const { tools } = harness(t);
  for (const name of ["scout_competitor_gate", "scout_competitor_watch", "scout_competitor_repo"]) assert.equal(tools.find((tool) => tool.name === name)?.readOnly, false, name);
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

const SHA = "0123456789abcdef0123456789abcdef01234567";

function repoHarness(t: TestContext) {
  const found = harness(t);
  const root = join(found.dir, "mirrors").replace(/\\/g, "/");
  mkdirSync(`${root}/alpha/.git`, { recursive: true });
  mkdirSync(`${root}/plain`, { recursive: true });
  const file = { dossierRoot: "d", mirrorRoot: root, entries: [{ id: "a", name: "A", flags: [], watch: { kind: "hash", url: "https://example.com/p" } }] };
  writeFileSync(found.paths.competitors, JSON.stringify(file));
  return { ...found, root, file };
}

test("the repo tool sets a mirror, starts the gate at a baseline, drops the watch, and removes the repo again", async (t) => {
  const { call, read, root } = repoHarness(t);
  await call("scout_competitor_repo", { id: "a", repo: { remoteUrl: "https://github.com/example/alpha", mirrorPath: `${root}/alpha`, baseline: { version: "1.2.0", commit: SHA } } });
  const entry = read().entries[0];
  assert.equal(entry.remoteUrl, "https://github.com/example/alpha");
  assert.equal(entry.mirrorPath, `${root}/alpha`);
  assert.deepEqual({ ...entry.baseline, at: undefined }, { version: "1.2.0", commit: SHA, at: undefined, source: "mirror" });
  assert.match(entry.baseline.at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal("watch" in entry, false);
  await call("scout_competitor_repo", { id: "a", repo: null });
  assert.equal(read().entries[0].remoteUrl, null);
  assert.equal(read().entries[0].mirrorPath, null);
});

test("the repo tool refuses an unsafe address, a folder outside the mirror root, a missing checkout, and a bad baseline", async (t) => {
  const { call, read, root, file } = repoHarness(t);
  const ok = { remoteUrl: "https://github.com/example/alpha", mirrorPath: `${root}/alpha` };
  const refuse = (repo: unknown, pattern: RegExp) => assert.rejects(() => call("scout_competitor_repo", { id: "a", repo }), pattern);
  await refuse({ ...ok, remoteUrl: "http://github.com/example/alpha" }, /https/);
  await refuse({ ...ok, remoteUrl: "https://user:pass@github.com/example/alpha" }, /credentials/);
  await refuse({ ...ok, remoteUrl: "https://localhost/alpha" }, /public host/);
  await refuse({ ...ok, mirrorPath: `${root}/../elsewhere` }, /inside the mirror root/);
  await refuse({ ...ok, mirrorPath: "/somewhere/else" }, /inside the mirror root/);
  await refuse({ ...ok, mirrorPath: root }, /inside the mirror root/);
  await refuse({ ...ok, mirrorPath: `${root}/plain` }, /not a git checkout/);
  await refuse({ ...ok, baseline: { commit: "abc" } }, /40-character/);
  await refuse({ ...ok, baseline: { commit: SHA, extra: 1 } }, /unknown baseline field/);
  await refuse({ ...ok, extra: 1 }, /unknown repo field/);
  await refuse("alpha", /repo must be an object/);
  await assert.rejects(() => call("scout_competitor_repo", { id: "a" }), /repo is required/);
  await assert.rejects(() => call("scout_competitor_repo", { id: "zzz", repo: null }), /unknown competitor/);
  assert.deepEqual(read(), file);
});
