import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonArray, applyEnrichment, inheritDescriptions, openCatalog, recordScan, todoList, upsertMachine, validateAnswer, type Answer } from "../src/index.ts";

const T = "2026-09-29T12:00:00Z";
const ans = (o: Partial<Answer>): Answer => ({ name: "Steam", description: "Game store and launcher from Valve", category: "game", confidence: 0.9, ...o });

function seed() {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "m", name: "M", os: "macos", kind: "host" });
  recordScan(db, "m", { sourceKind: "app", location: "", status: "ok", installs: [
    { ecosystem: "bundle", key: "com.valvesoftware.steam", name: "Steam", kind: "app", version: "1", location: "/Applications/Steam.app" },
    { ecosystem: "bundle", key: "com.x", name: "Mystery", kind: "app", version: "1", location: "/Applications/Mystery.app" },
  ] }, T);
  recordScan(db, "m", { sourceKind: "winget", location: "", status: "ok", installs: [
    { ecosystem: "winget", key: "Valve.Steam", name: "Steam", kind: "package", version: "1", location: "" },
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1", location: "/x", description: "Distributed revision control system" },
  ] }, T);
  db.prepare("UPDATE packages SET category = 'library dependency', category_source = 'rule' WHERE key = 'git'").run();
  return db;
}

test("the todo list is distinct by name, skips settled categories, and counts installs", () => {
  const db = seed();
  const t = todoList(db);
  assert.deepEqual(t.map((x) => x.name), ["steam", "mystery"]);
  assert.deepEqual(t[0]?.ecosystems.sort(), ["bundle", "winget"]);
});

test("answers are validated", () => {
  assert.equal(validateAnswer(ans({})), null);
  assert.match(validateAnswer(ans({ description: "Short" })) ?? "", /length/);
  assert.match(validateAnswer(ans({ description: "A tool — for things and more things" })) ?? "", /non-ASCII/);
  assert.match(validateAnswer(ans({ category: "spaceship" })) ?? "", /unknown category/);
  assert.match(validateAnswer(ans({ confidence: 2 })) ?? "", /confidence/);
});

test("an answer fills every package with that name, and low confidence is refused", () => {
  const db = seed();
  const r = applyEnrichment(db, [ans({}), ans({ name: "Mystery", confidence: 0.2 }), ans({ name: "Broken", category: "nope" })], T);
  assert.equal(r.applied, 1);
  assert.deepEqual(r.rejected.map((x) => x.name).sort(), ["Broken", "Mystery"]);
  const rows = db.prepare("SELECT ecosystem, description, description_source AS s, category FROM packages WHERE lower(name) = 'steam' ORDER BY ecosystem").all().map((x) => ({ ...x }));
  assert.deepEqual(rows.map((x) => [x.ecosystem, x.s, x.category]), [["bundle", "generated", "game"], ["winget", "generated", "game"]]);
});

test("a generated answer never replaces a source or manual description", () => {
  const db = seed();
  db.prepare("UPDATE packages SET description = 'mine', description_source = 'manual' WHERE key = 'Valve.Steam'").run();
  db.prepare("UPDATE packages SET category = 'productivity', category_source = 'manual' WHERE key = 'Valve.Steam'").run();
  applyEnrichment(db, [ans({})], T);
  const w = db.prepare("SELECT description, category FROM packages WHERE key = 'Valve.Steam'").get() as { description: string; category: string };
  assert.deepEqual({ ...w }, { description: "mine", category: "productivity" });
  const b = db.prepare("SELECT description_source AS s FROM packages WHERE key = 'com.valvesoftware.steam'").get() as { s: string };
  assert.equal(b.s, "generated");
});

test("a package inherits the source description of a same-named sibling, and gives it up when the sibling's is gone", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "m", name: "M", os: "macos", kind: "host" });
  recordScan(db, "m", { sourceKind: "brew", location: "/b", status: "ok", installs: [
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1", location: "/b/g", description: "Distributed revision control system" },
    { ecosystem: "dpkg", key: "git", name: "Git", kind: "package", version: "1", location: "" },
    { ecosystem: "dpkg", key: "unrelated", name: "Unrelated", kind: "package", version: "1", location: "" },
  ] }, T);
  assert.equal(inheritDescriptions(db, T).inherited, 1);
  const g = db.prepare("SELECT description, description_source AS s FROM packages WHERE ecosystem = 'dpkg' AND key = 'git'").get() as { description: string; s: string };
  assert.deepEqual({ ...g }, { description: "Distributed revision control system", s: "sibling" });
  assert.equal((db.prepare("SELECT description FROM packages WHERE key = 'unrelated'").get() as { description: string | null }).description, null);
  db.prepare("UPDATE packages SET description = NULL, description_source = NULL WHERE key = 'git' AND ecosystem = 'brew'").run();
  assert.equal(inheritDescriptions(db, T).inherited, 0);
  assert.equal((db.prepare("SELECT description FROM packages WHERE ecosystem = 'dpkg' AND key = 'git'").get() as { description: string | null }).description, null);
});

test("the JSON array is found among a preamble and trailing banner text with brackets", () => {
  const reply = 'Sure, here you go:\n[\n {"name": "a [b]", "x": 1},\n {"name": "c"}\n]\n[ai] sandbox job folder: X\n[ai] review it';
  assert.deepEqual(extractJsonArray(reply), [{ name: "a [b]", x: 1 }, { name: "c" }]);
  assert.equal(extractJsonArray("no array here [ai] oops"), null);
  assert.deepEqual(extractJsonArray("[1, 2] then [3]"), [1, 2]);
});

