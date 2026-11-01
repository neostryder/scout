import { test } from "node:test";
import assert from "node:assert/strict";
import { certsKeySource, type Jwk } from "../src/access.ts";

const HOUR = 3_600_000;
const keys: Jwk[] = [{ kid: "k1", kty: "RSA" }];

test("concurrent callers share one key fetch through response parsing", async () => {
  let calls = 0;
  const response = Promise.withResolvers<{ status: number; json(): Promise<unknown> }>();
  const body = Promise.withResolvers<unknown>();
  const source = certsKeySource("team.example.test", () => {
    calls++;
    return response.promise;
  });
  const first = source(false);
  const second = source(true);
  assert.equal(calls, 1);
  response.resolve({ status: 200, json: () => body.promise });
  await Promise.resolve();
  const third = source(false);
  assert.equal(calls, 1);
  body.resolve({ keys });
  assert.deepEqual(await Promise.all([first, second, third]), [keys, keys, keys]);
  assert.equal(calls, 1);
});

for (const failure of ["throw", "HTTP", "JSON"]) {
  test(`stale keys survive a ${failure} refresh failure after one hour`, async () => {
    let time = 0;
    let calls = 0;
    const source = certsKeySource("team.example.test", async () => {
      calls++;
      if (calls === 1) return { status: 200, json: async () => ({ keys }) };
      if (failure === "throw") throw new Error("offline");
      return { status: failure === "HTTP" ? 503 : 200, json: async () => { throw new Error("invalid JSON"); } };
    }, () => time);
    assert.deepEqual(await source(false), keys);
    time = HOUR;
    assert.deepEqual(await source(false), keys);
    assert.equal(calls, 2);
  });
}

test("failed refreshes never extend the 24 hour stale key limit", async () => {
  let time = 0;
  let calls = 0;
  const error = new Error("offline");
  const source = certsKeySource("team.example.test", async () => {
    calls++;
    if (calls > 1) throw error;
    return { status: 200, json: async () => ({ keys }) };
  }, () => time);
  await source(false);
  time = 24 * HOUR - 1;
  assert.deepEqual(await source(false), keys);
  time++;
  await assert.rejects(() => source(false), (err) => err === error);
  assert.equal(calls, 2);
  time += 15_000;
  await assert.rejects(() => source(false), (err) => err === error);
  assert.equal(calls, 3);
});

test("a forced refresh failure returns cached keys and backs off", async () => {
  let time = 0;
  let calls = 0;
  const source = certsKeySource("team.example.test", async () => {
    calls++;
    if (calls > 1) throw new Error("offline");
    return { status: 200, json: async () => ({ keys }) };
  }, () => time);
  await source(false);
  time = 60_000;
  assert.deepEqual(await source(true), keys);
  assert.equal(calls, 1);
  time++;
  assert.deepEqual(await source(true), keys);
  assert.deepEqual(await source(true), keys);
  assert.deepEqual(await source(false), keys);
  assert.equal(calls, 2);
  time += 15_000;
  assert.deepEqual(await source(true), keys);
  assert.equal(calls, 3);
});

test("a stale cache backs off for 15 seconds and recovers with new keys", async () => {
  let time = 0;
  let calls = 0;
  const rotated: Jwk[] = [{ kid: "k2", kty: "RSA" }];
  const source = certsKeySource("team.example.test", async () => {
    calls++;
    if (calls === 2) throw new Error("offline");
    return { status: 200, json: async () => ({ keys: calls === 1 ? keys : rotated }) };
  }, () => time);
  await source(false);
  time = HOUR;
  assert.deepEqual(await source(false), keys);
  time += 14_999;
  assert.deepEqual(await source(false), keys);
  assert.deepEqual(await source(true), keys);
  assert.equal(calls, 2);
  time++;
  assert.deepEqual(await source(false), rotated);
  assert.equal(calls, 3);
  time += HOUR - 1;
  assert.deepEqual(await source(false), rotated);
  assert.equal(calls, 3);
});

test("an empty cache shares failures, rethrows during back-off and recovers", async () => {
  let time = 0;
  let calls = 0;
  const error = new Error("offline");
  const pending = Promise.withResolvers<{ status: number; json(): Promise<unknown> }>();
  const source = certsKeySource("team.example.test", () => {
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve({ status: 200, json: async () => ({ keys }) });
  }, () => time);
  const first = assert.rejects(() => source(false), (err) => err === error);
  const second = assert.rejects(() => source(true), (err) => err === error);
  assert.equal(calls, 1);
  time = 10_000;
  pending.reject(error);
  await Promise.all([first, second]);
  time += 14_999;
  await assert.rejects(() => source(false), (err) => err === error);
  await assert.rejects(() => source(true), (err) => err === error);
  assert.equal(calls, 1);
  time++;
  assert.deepEqual(await source(false), keys);
  assert.deepEqual(await source(true), keys);
  assert.equal(calls, 2);
});
