import assert from "node:assert/strict";
import test from "node:test";

const { allowedEdits, editDistance, meetsConstraints, normalize, parseQuery, searchCompetitors, searchNote } = await import(new URL("../public/competitors-search.js", import.meta.url).href);

const row = (over: Record<string, unknown> = {}) => ({ id: "example", name: "Example Tool", org: "Example Org", status: "current", flags: ["forge"], about: "Generates NPCs and quests for tabletop game masters.", topics: ["rpg", "npc"], ...over });
const rows = [
  row({ id: "a", name: "Dungeon Journey", org: "Cafe Works", flags: ["atlas"], about: "A map maker for dungeon crawls." }),
  row({ id: "b", name: "Session Scribe", org: "Quill Co", status: "new", flags: ["scroll", "quill"], about: "Records and summarizes game sessions." }),
  row({ id: "c", name: "Lore Keeper", org: "Tome Labs", flags: ["tome"], about: "A wiki for campaign lore." }),
];
const ids = (result: { rows: { id: string }[] }) => result.rows.map((item) => item.id);

test("chips split into words, phrases, negations, and known fields", () => {
  assert.deepEqual(parseQuery('dungeon "map maker" -wiki org:quill -status:new flag:atlas'), [
    { negate: false, field: null, value: "dungeon", phrase: false },
    { negate: false, field: null, value: "map maker", phrase: true },
    { negate: true, field: null, value: "wiki", phrase: false },
    { negate: false, field: "org", value: "quill", phrase: false },
    { negate: true, field: "status", value: "new", phrase: false },
    { negate: false, field: "flag", value: "atlas", phrase: false },
  ]);
  assert.deepEqual(parseQuery("http://x - "), [{ negate: false, field: null, value: "http://x", phrase: false }]);
  assert.deepEqual(parseQuery('  "  " '), []);
  assert.equal(normalize("Café"), "cafe");
});

test("exact search needs every chip, ignores case and accents, and keeps the list order", () => {
  const exact = searchCompetitors(rows, "CAFÉ dungeon");
  assert.equal(exact.tier, "exact");
  assert.deepEqual(ids(exact), ["a"]);
  assert.match(exact.why.get("a"), /^Matched cafe in organization; dungeon in name, summary$/);
  assert.deepEqual(ids(searchCompetitors(rows, "game")), ["b"]);
  assert.deepEqual(ids(searchCompetitors(rows, "org:works")), ["a"]);
  assert.deepEqual(ids(searchCompetitors(rows, "flag:quill")), ["b"]);
  assert.deepEqual(ids(searchCompetitors(rows, "status:new")), ["b"]);
  assert.deepEqual(ids(searchCompetitors(rows, '"campaign lore"')), ["c"]);
  assert.deepEqual(ids(searchCompetitors(rows, "-lore")), ["a", "b"]);
  assert.equal(searchCompetitors(rows, "").tier, "all");
  assert.equal(searchCompetitors(rows, "").rows.length, 3);
});

test("a topic and a summary are searched too", () => {
  assert.deepEqual(ids(searchCompetitors(rows, "npc")), ["a", "b", "c"]);
  assert.deepEqual(ids(searchCompetitors(rows, "about:wiki")), ["c"]);
});

test("close spelling runs only when nothing matches exactly, and ranks the nearest first", () => {
  const close = searchCompetitors(rows, "dungon");
  assert.equal(close.tier, "close");
  assert.deepEqual(ids(close), ["a"]);
  assert.equal(close.why.get("a"), 'Close spelling: "dungon" is close to "dungeon"');
  const ranked = searchCompetitors([row({ id: "x", name: "Scribblers", about: "" }), row({ id: "y", name: "Scribes", about: "" })], "scribers");
  assert.equal(ranked.tier, "close");
  assert.deepEqual(ids(ranked), ["y", "x"]);
  assert.equal(searchCompetitors(rows, "dungeon").tier, "exact");
});

test("edit limits grow with the word, so a short word never matches a different short word", () => {
  assert.deepEqual([3, 4, 6, 7, 12].map(allowedEdits), [0, 1, 1, 2, 2]);
  assert.equal(editDistance("kitten", "sitting", 3), 3);
  assert.equal(editDistance("abc", "abd", 0), 1);
  assert.equal(searchCompetitors(rows, "map").tier, "exact");
  assert.equal(searchCompetitors(rows, "mop").tier, "none");
});

test("close spelling still obeys fields, phrases, and negations", () => {
  assert.deepEqual(ids(searchCompetitors(rows, "dungon org:cafe")), ["a"]);
  assert.equal(searchCompetitors(rows, "dungon org:quill").tier, "none");
  assert.equal(searchCompetitors(rows, 'dungon -atlas').tier, "none");
});

test("a query that spelling cannot find asks for the meaning tier, then uses the ranked ids", () => {
  const waiting = searchCompetitors(rows, "storytelling helper");
  assert.equal(waiting.tier, "none");
  assert.equal(waiting.needsMeaning, true);
  const answered = searchCompetitors(rows, "storytelling helper", { meaningIds: ["c", "zzz", "b"] });
  assert.equal(answered.tier, "meaning");
  assert.deepEqual(ids(answered), ["c", "b"]);
  assert.equal(answered.why.get("c"), "Similar meaning, ranked best first");
  assert.equal(searchCompetitors(rows, "storytelling helper", { meaningIds: [] }).tier, "none");
  assert.equal(searchCompetitors(rows, "storytelling helper", { meaningIds: [] }).needsMeaning, false);
  const limited = searchCompetitors(Array.from({ length: 14 }, (_, index) => row({ id: `r${index}`, name: `Zebra ${index}`, about: "x" })), "storytelling", { meaningIds: Array.from({ length: 14 }, (_, index) => `r${index}`) });
  assert.equal(limited.rows.length, 10);
});

test("the meaning tier keeps field and negation chips, and is not asked for when only those are given", () => {
  const answered = searchCompetitors(rows, "storytelling org:quill", { meaningIds: ["c", "b"] });
  assert.deepEqual(ids(answered), ["b"]);
  assert.equal(searchCompetitors(rows, "org:nobody").needsMeaning, false);
  assert.equal(meetsConstraints(rows[0], parseQuery("-atlas")), false);
});

test("the note under the search says which tier answered", () => {
  assert.equal(searchNote({ tier: "all" }, 3, 3), "");
  assert.equal(searchNote({ tier: "exact" }, 2, 9), "2 of 9 match.");
  assert.match(searchNote({ tier: "close" }, 1, 9), /close spelling, closest first/);
  assert.match(searchNote({ tier: "meaning" }, 4, 9), /similar meaning, best first/);
  assert.equal(searchNote({ tier: "none", needsMeaning: true }, 0, 9), "Nothing matches. Looking for similar meanings.");
  assert.equal(searchNote({ tier: "none", needsMeaning: false }, 0, 9), "Nothing matches.");
});
