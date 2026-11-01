import { test } from "node:test";
import assert from "node:assert/strict";
import { retryExec, runArgv, type Exec } from "../src/transport.ts";

test("a local command streams its output and its process id to the hooks while still returning the full result", async () => {
  const chunks: string[] = [];
  let pid: number | undefined;
  const result = await runArgv({ type: "local" }, [process.execPath, "-e", "process.stdout.write('one'); process.stderr.write('two')"], 20_000, undefined, undefined, { onOutput: (chunk) => chunks.push(chunk), onSpawn: (id) => { pid = id; } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "one");
  assert.equal(result.stderr, "two");
  assert.deepEqual([...chunks].sort(), ["one", "two"]);
  assert.equal(typeof pid, "number");
});

test("a command run without hooks behaves as before", async () => {
  const result = await runArgv({ type: "local" }, [process.execPath, "-e", "process.stdout.write('ok')"], 20_000);
  assert.deepEqual(result, { exitCode: 0, stdout: "ok", stderr: "" });
});

test("local spawn locks retry five times with three-second pauses", async () => {
  for (const code of ["EACCES", "EBUSY"]) {
    let calls = 0;
    const pauses: number[] = [];
    const exec: Exec = async () => {
      calls++;
      return { exitCode: 127, stdout: "", stderr: `spawn winget ${code}`, spawnError: code };
    };
    const result = await retryExec(exec, async (ms) => { pauses.push(ms); })({ type: "local" }, ["winget", "list"], 120_000);
    assert.equal(result.spawnError, code);
    assert.equal(calls, 6);
    assert.deepEqual(pauses, [3000, 3000, 3000, 3000, 3000]);
  }
});

test("spawn retries accept thrown errors and preserve successful output and hooks", async () => {
  let calls = 0;
  const chunks: string[] = [];
  const exec: Exec = async (_transport, argv, _timeout, _signal, env, hooks) => {
    assert.deepEqual(argv, ["npm", "ls"]);
    assert.deepEqual(env, { SCOUT_TEST: "1" });
    if (++calls < 3) throw Object.assign(new Error("spawn npm EBUSY"), { code: "EBUSY" });
    hooks?.onOutput?.("ready");
    return { exitCode: 0, stdout: "ready", stderr: "" };
  };
  const result = await retryExec(exec, async () => undefined)({ type: "local" }, ["npm", "ls"], 120_000, undefined, { SCOUT_TEST: "1" }, { onOutput: (chunk) => chunks.push(chunk) });
  assert.equal(result.stdout, "ready");
  assert.equal(calls, 3);
  assert.deepEqual(chunks, ["ready"]);
});

test("spawn retry waits honor Stop and skip remote errors, missing tools, and ordinary failures", async () => {
  const controller = new AbortController();
  let calls = 0;
  const locked: Exec = async () => { calls++; return { exitCode: 127, stdout: "", stderr: "spawn winget EACCES" }; };
  const stopped = await retryExec(locked, async (_ms, signal) => { assert.equal(signal, controller.signal); controller.abort(); })({ type: "local" }, ["winget"], 120_000, controller.signal);
  assert.equal(stopped.exitCode, -1);
  assert.equal(calls, 1);
  for (const [transport, exitCode, stderr] of [
    [{ type: "ssh", target: "fixture" }, 127, "spawn winget EACCES"],
    [{ type: "local" }, 127, "spawn npm ENOENT"],
    [{ type: "local" }, 1, "installer says EBUSY"],
  ] as const) {
    let attempts = 0;
    await retryExec(async () => { attempts++; return { exitCode, stdout: "", stderr }; }, async () => assert.fail("unexpected retry"))(transport, ["winget"], 120_000);
    assert.equal(attempts, 1);
  }
});

test("a Stop during the real retry pause ends it immediately", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = retryExec(async () => { calls++; return { exitCode: 127, stdout: "", stderr: "spawn winget EACCES" }; })({ type: "local" }, ["winget"], 120_000, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await result).exitCode, -1);
  assert.equal(calls, 1);
});
