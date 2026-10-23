import { test } from "node:test";
import assert from "node:assert/strict";
import { runArgv } from "../src/transport.ts";

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
