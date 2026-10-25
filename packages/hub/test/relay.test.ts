import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_URL, RelayBeat, TOKEN_RETRY_MS, type RelayFetch } from "../src/relay.ts";

const SECRET = "beat-token-for-tests";

function setup(answer: (call: number) => Promise<{ status: number }> | { status: number } = () => ({ status: 204 }), token: () => Promise<string> = async () => SECRET) {
  const calls: { url: string; method: string; authorization: string | undefined; hasSignal: boolean }[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  const fetch: RelayFetch = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers["authorization"], hasSignal: init.signal instanceof AbortSignal });
    return answer(calls.length);
  };
  let tokenReads = 0;
  const relay = new RelayBeat({ token: () => { tokenReads += 1; return token(); }, fetch, now: () => now, log: (line) => logs.push(line) });
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return { relay, calls, logs, settle, advance: (ms: number) => { now += ms; }, tokenReads: () => tokenReads };
}

test("a beat posts to the relay with the bearer token and an empty body", async () => {
  const { relay, calls, logs, settle } = setup();
  relay.post();
  await settle();
  assert.deepEqual(calls, [{ url: RELAY_URL, method: "POST", authorization: `Bearer ${SECRET}`, hasSignal: true }]);
  assert.deepEqual(logs, []);
});

test("the token is read once and kept in memory", async () => {
  const { relay, calls, settle, tokenReads } = setup();
  for (let i = 0; i < 3; i += 1) { relay.post(); await settle(); }
  assert.equal(calls.length, 3);
  assert.equal(tokenReads(), 1);
});

test("a network failure is logged once, never throws, and a recovery is logged once", async () => {
  let down = true;
  const { relay, logs, settle, calls } = setup(() => { if (down) throw new Error(`connect failed with ${SECRET}`); return { status: 204 }; });
  for (let i = 0; i < 3; i += 1) { relay.post(); await settle(); }
  assert.equal(calls.length, 3);
  assert.deepEqual(logs, ["The heartbeat relay could not be reached: the network failed."]);
  down = false;
  relay.post();
  await settle();
  relay.post();
  await settle();
  assert.deepEqual(logs, ["The heartbeat relay could not be reached: the network failed.", "The heartbeat relay answers again."]);
  assert.equal(logs.join("\n").includes(SECRET), false);
});

test("a post that is still waiting is not doubled up", async () => {
  let release: (() => void) | undefined;
  const { relay, calls, settle } = setup(() => new Promise((resolve) => { release = () => resolve({ status: 204 }); }));
  relay.post();
  await settle();
  relay.post();
  await settle();
  assert.equal(calls.length, 1);
  release?.();
  await settle();
  relay.post();
  await settle();
  assert.equal(calls.length, 2);
});

test("a missing token waits five minutes before the secret store is asked again", async () => {
  let ready = false;
  const { relay, calls, logs, settle, advance, tokenReads } = setup(undefined, async () => { if (!ready) throw new Error("bws failed"); return SECRET; });
  relay.post();
  await settle();
  relay.post();
  await settle();
  assert.equal(tokenReads(), 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, ["The heartbeat relay could not be reached: the beat token is not available."]);
  ready = true;
  advance(TOKEN_RETRY_MS);
  relay.post();
  await settle();
  assert.equal(tokenReads(), 2);
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 2);
});

test("a refused token is read again after the wait, and other statuses are logged", async () => {
  const statuses = [401, 204, 500];
  const { relay, logs, settle, advance, tokenReads } = setup((call) => ({ status: statuses[call - 1] ?? 204 }));
  relay.post();
  await settle();
  assert.match(logs[0] ?? "", /refused the token \(401\)/);
  relay.post();
  await settle();
  assert.equal(tokenReads(), 1, "within the wait the stored token is not re-read and no post is made");
  advance(TOKEN_RETRY_MS);
  relay.post();
  await settle();
  assert.equal(tokenReads(), 2);
  assert.equal(logs.at(-1), "The heartbeat relay answers again.");
  relay.post();
  await settle();
  assert.match(logs.at(-1) ?? "", /answered 500/);
});
