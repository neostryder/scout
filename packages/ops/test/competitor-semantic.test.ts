import { test } from "node:test";
import assert from "node:assert/strict";
import { minimaxSemantic, rankByTerms, SEMANTIC_LIMIT } from "../src/competitor-semantic.ts";

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

test("the ranker sends only the phrase, reads an answer wrapped in reasoning, and ranks the list by the related words", async () => {
  const calls: Call[] = [];
  const rank = minimaxSemantic({ post: stub("<think>hm</think>```json {\"terms\":[\"atlas\",\"cartography\"]} ```", calls), readKey: async () => "k" });
  assert.deepEqual(await rank("map helper", items), ["a"]);
  assert.equal(calls[0]?.auth, "Bearer k");
  const sent = JSON.parse(calls[0]!.body) as { messages: { role: string; content: string }[] };
  assert.match(sent.messages[0]!.content, /untrusted/);
  assert.deepEqual(JSON.parse(sent.messages[1]!.content), { phrase: "map helper" });
});

test("a name match outranks a summary match, a word and its plural meet, and ties go by name", () => {
  const list = [
    { id: "x", name: "Zed", org: null, products: [], about: "Draws dungeon maps." },
    { id: "y", name: "Maps Plus", org: null, products: [], about: null },
    { id: "z", name: "Another", org: null, products: [], about: "Draws dungeon maps." },
    { id: "w", name: "Unrelated", org: null, products: [], about: "Tracks initiative." },
  ];
  assert.deepEqual(rankByTerms(["map"], list), ["y", "z", "x"]);
  assert.deepEqual(rankByTerms(["mapping"], [{ id: "q", name: "Map Kit", org: null, products: [], about: null }]), ["q"]);
  assert.deepEqual(rankByTerms([], list), []);
});

test("an answer is kept for an hour per phrase, then asked again", async () => {
  let clock = 0;
  const calls: Call[] = [];
  const rank = minimaxSemantic({ post: stub("{\"terms\":[\"dungeon\"]}", calls), readKey: async () => "k", now: () => clock });
  await rank("Map Helper", items);
  await rank("map helper", items);
  assert.equal(calls.length, 1);
  clock += 61 * 60_000;
  await rank("map helper", items);
  assert.equal(calls.length, 2);
});

test("a first answer cut off by reasoning is asked again with more room, and the phrase words count as terms", async () => {
  const calls: Call[] = [];
  const answers = ["", "{\"terms\":[]}"];
  const post = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ body: init.body, auth: init.headers["authorization"] });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: answers.shift() } }] }) };
  };
  const rank = minimaxSemantic({ post, readKey: async () => "k" });
  assert.deepEqual(await rank("dungeon", items), ["a"]);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1]!.body).max_tokens > JSON.parse(calls[0]!.body).max_tokens, true);
});

test("no phrase or no items asks nothing, the list is capped, and a model failure is an error", async () => {
  let asked = 0;
  const counted = async () => { asked += 1; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"terms\":[]}" } }] }) }; };
  const rank = minimaxSemantic({ post: counted, readKey: async () => "k" });
  assert.deepEqual(await rank("   ", items), []);
  assert.deepEqual(await rank("x", []), []);
  assert.equal(asked, 0);
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, name: `Tool ${index}`, org: null, products: [] as string[], about: null }));
  const wide = minimaxSemantic({ post: stub(JSON.stringify({ terms: ["tool"] })), readKey: async () => "k" });
  assert.equal((await wide("everything", many)).length, SEMANTIC_LIMIT);
  const down = minimaxSemantic({ post: async () => ({ ok: false, status: 500, json: async () => ({}) }), readKey: async () => "k" });
  await assert.rejects(() => down("x", items), /MiniMax answered 500/);
});
