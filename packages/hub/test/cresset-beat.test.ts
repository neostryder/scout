import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CressetBeat, type CressetBeatResult } from "../src/cresset-beat.ts";
import { cressetHeartbeat } from "../src/notify.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("the beat logs when Cresset goes quiet and when it answers again, not once per beat", async () => {
  const logs: string[] = [];
  const results: (CressetBeatResult | Error)[] = ["off", "sent", "spooled", "spooled", new Error("x"), "sent", "sent"];
  const beat = new CressetBeat({ send: async () => { const next = results.shift()!; if (next instanceof Error) throw next; return next; }, log: (line) => logs.push(line) });
  for (let i = 0; i < 7; i++) { beat.post(); await settle(); }
  assert.deepEqual(logs, [
    "The Cresset heartbeat could not be delivered: Cresset could not be reached, so the kit kept the beat to send later.",
    "The Cresset heartbeat is delivered again.",
  ]);
});

test("a beat that is still sending is not started twice, and a thrown error is reported by kind only", async () => {
  const logs: string[] = [];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const beat = new CressetBeat({ send: async () => { calls += 1; await gate; const error = new Error("secret in the command line"); error.name = "TimeoutError"; throw error; }, log: (line) => logs.push(line) });
  beat.post();
  beat.post();
  await settle();
  assert.equal(calls, 1);
  release();
  await settle();
  assert.deepEqual(logs, ["The Cresset heartbeat could not be delivered: no answer in time."]);
});

function fakeKit(t: TestContext, exitCode: number): { kit: string; sender: string; argsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "scout-kit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argsPath = join(dir, "args.json");
  const kit = join(dir, "cresset-notify.mjs");
  writeFileSync(kit, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); process.exit(${exitCode});\n`);
  return { kit, sender: "scout-notify", argsPath };
}

test("the heartbeat is one quiet status event with a fixed fingerprint, and the kit's exit code says whether Cresset took it", async (t) => {
  assert.equal(await cressetHeartbeat(null), "off");
  const sent = fakeKit(t, 0);
  assert.equal(await cressetHeartbeat(sent), "sent");
  const args = JSON.parse(readFileSync(sent.argsPath, "utf8")) as string[];
  assert.deepEqual(args, ["send", "--sender", "scout-notify", "--title", "Scout hub heartbeat", "--severity", "info", "--kind", "status", "--component", "scout", "--class", "heartbeat", "--fingerprint", "scout-hub-heartbeat"]);
  assert.equal(await cressetHeartbeat(fakeKit(t, 1)), "spooled");
  await assert.rejects(cressetHeartbeat(fakeKit(t, 2)));
});
