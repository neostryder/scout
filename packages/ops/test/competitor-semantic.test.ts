import { test } from "node:test";
import assert from "node:assert/strict";
import { minimaxSemantic, SEMANTIC_LIMIT } from "../src/competitor-semantic.ts";

const items = [
  { id: "a", name: "Alpha", org: "Wolf", products: ["atlas"], about: "Makes dungeon maps." },
  { id: "b", name: "Beta", org: null, products: [], about: null },
];

type Call = { body: string; auth: string | undefined };

function stub(answer: string, calls: Call[] = []) {
  return async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ body: init.body, auth: init.headers["authorization"] });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: answer } }] }) };
  };
}

test("the ranker sends the phrase and the list, keeps only known ids in order, and reads an answer wrapped in reasoning", async () => {
  const calls: Call[] = [];
  const rank = minimaxSemantic({ post: stub("<think>hm</think>```json\n{\"ids\":[\"b\",\"zzz\",\"a\",\"b\"]}\n```", calls), readKey: async () => "k" });
  assert.deepEqual(await rank("map helper", items), ["b", "a"]);
  assert.equal(calls[0]?.auth, "Bearer k");
  const sent = JSON.parse(calls[0]!.body) as { messages: { role: string; content: string }[] };
  assert.match(sent.messages[0]!.content, /untrusted/);
  assert.deepEqual(JSON.parse(sent.messages[1]!.content).items[0], { id: "a", name: "Alpha", by: "Wolf", products: ["atlas"], about: "Makes dungeon maps." });
});

test("an answer is kept for an hour per phrase, then asked again", async () => {
  let clock = 0;
  const calls: Call[] = [];
  const rank = minimaxSemantic({ post: stub("{\"ids\":[\"a\"]}", calls), readKey: async () => "k", now: () => clock });
  await rank("Map Helper", items);
  await rank("map helper", items);
  assert.equal(calls.length, 1);
  clock += 61 * 60_000;
  await rank("map helper", items);
  assert.equal(calls.length, 2);
});

test("no phrase or no items asks nothing, the list is capped, and a model failure is an error", async () => {
  let asked = 0;
  const counted = async () => { asked += 1; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"ids\":[]}" } }] }) }; };
  const rank = minimaxSemantic({ post: counted, readKey: async () => "k" });
  assert.deepEqual(await rank("   ", items), []);
  assert.deepEqual(await rank("x", []), []);
  assert.equal(asked, 0);
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, name: `R${index}`, org: null, products: [] as string[], about: null }));
  const wide = minimaxSemantic({ post: stub(JSON.stringify({ ids: many.map((item) => item.id) })), readKey: async () => "k" });
  assert.equal((await wide("everything", many)).length, SEMANTIC_LIMIT);
  const down = minimaxSemantic({ post: async () => ({ ok: false, status: 500, json: async () => ({}) }), readKey: async () => "k" });
  await assert.rejects(() => down("x", items), /MiniMax answered 500/);
});
