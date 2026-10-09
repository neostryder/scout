import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteFilter, filterName, filterView, listSavedFilters, openCatalog, renameFilter, saveFilter, SAVED_FILTER_PARAMS } from "../src/index.ts";

test("saved filters upsert trimmed names and keep the same name in both views", () => {
  const db = openCatalog(":memory:");
  try {
    const catalog = saveFilter(db, { name: " Work ", view: "catalog", spec: { q: "editor", machine: "hub", sort: "lastUsed", dir: "desc", limit: "20", offset: "10", unknown: "ignored", status: "blocked" } });
    assert.deepEqual(catalog, { name: "Work", view: "catalog", spec: { q: "editor", machine: "hub", sort: "lastUsed", dir: "desc" } });
    saveFilter(db, { name: "Work", view: "updates", spec: { status: "blocked", bump: "major", hasBeta: "1", path: "ignored" } });
    saveFilter(db, { name: "Work", view: "catalog", spec: { q: "browser" } });
    assert.deepEqual(listSavedFilters(db), [
      { name: "Work", view: "catalog", spec: { q: "browser" } },
      { name: "Work", view: "updates", spec: { status: "blocked", bump: "major", hasBeta: "1" } },
    ]);
    const rows = db.prepare("SELECT spec_json FROM saved_filters").all() as { spec_json: string }[];
    assert.deepEqual(rows.map((row) => Object.keys(JSON.parse(row.spec_json))), [["view", "params"], ["view", "params"]]);
  } finally { db.close(); }
});

test("filter names and views reject invalid input before writing", () => {
  const db = openCatalog(":memory:");
  try {
    for (const name of ["", "   ", "a".repeat(61), "bad\n", "bad\tname", "bad\u0000name", "bad\u007fname", "bad\u0085name"]) {
      assert.throws(() => saveFilter(db, { name, view: "catalog", spec: {} }));
    }
    for (const name of [null, 12, {}, []]) assert.throws(() => filterName(name));
    for (const view of [null, "review", "", 1]) assert.throws(() => filterView(view));
    assert.equal(filterName(" a "), "a");
    assert.equal(filterName("a".repeat(60)).length, 60);
    assert.deepEqual(listSavedFilters(db), []);
  } finally { db.close(); }
});

test("params retain every accepted key and reject non-string or oversized values", () => {
  const db = openCatalog(":memory:");
  try {
    for (const view of ["catalog", "updates"] as const) {
      const spec = Object.fromEntries(SAVED_FILTER_PARAMS[view].map((key) => [key, ""]));
      assert.deepEqual(saveFilter(db, { name: view, view, spec }).spec, spec);
    }
    assert.equal(saveFilter(db, { name: "Long", view: "catalog", spec: { q: "x".repeat(500) } }).spec.q?.length, 500);
    assert.throws(() => saveFilter(db, { name: "Long", view: "catalog", spec: { q: "x".repeat(501) } }), /500/);
    for (const value of [null, 1, true, {}, []]) {
      assert.throws(() => saveFilter(db, { name: "Bad", view: "catalog", spec: { q: value } as unknown as Record<string, string> }), /text/);
    }
    for (const spec of [null, "text", []]) assert.throws(() => saveFilter(db, { name: "Bad", view: "catalog", spec: spec as unknown as Record<string, string> }), /object/);
    assert.equal(listSavedFilters(db).length, 3);
  } finally { db.close(); }
});

test("rename refuses collisions within its view and delete keeps the other view", () => {
  const db = openCatalog(":memory:");
  try {
    saveFilter(db, { name: "First", view: "catalog", spec: { q: "a" } });
    saveFilter(db, { name: "Second", view: "catalog", spec: {} });
    saveFilter(db, { name: "Shared", view: "updates", spec: { q: "b" } });
    assert.throws(() => renameFilter(db, "First", " Second "), /already exists/);
    assert.equal(renameFilter(db, "First", "First").name, "First");
    assert.deepEqual(renameFilter(db, " First ", " Shared "), { name: "Shared", view: "catalog", spec: { q: "a" } });
    assert.throws(() => renameFilter(db, "missing", "New"), /not found/);
    assert.throws(() => renameFilter(db, "Shared", "bad\n"), /control/);
    assert.throws(() => deleteFilter(db, "missing"), /not found/);
    deleteFilter(db, " Shared ");
    assert.deepEqual(listSavedFilters(db).map((filter) => [filter.name, filter.view]), [["Second", "catalog"], ["Shared", "updates"]]);
    assert.equal(renameFilter(db, "Shared", "Renamed", "updates").view, "updates");
    deleteFilter(db, "Renamed", "updates");
    assert.equal(listSavedFilters(db).length, 1);
  } finally { db.close(); }
});

test("the global limit permits upsert and rename at 100 filters and frees a slot on delete", () => {
  const db = openCatalog(":memory:");
  try {
    for (let i = 0; i < 100; i++) saveFilter(db, { name: `Filter ${i}`, view: i % 2 ? "updates" : "catalog", spec: {} });
    assert.equal(listSavedFilters(db).length, 100);
    assert.throws(() => saveFilter(db, { name: "Extra", view: "updates", spec: {} }), /100/);
    saveFilter(db, { name: "Filter 0", view: "catalog", spec: { q: "changed" } });
    renameFilter(db, "Filter 0", "Renamed");
    assert.equal(listSavedFilters(db).find((filter) => filter.name === "Renamed")?.spec.q, "changed");
    deleteFilter(db, "Renamed");
    saveFilter(db, { name: "Extra", view: "updates", spec: {} });
    assert.equal(listSavedFilters(db).length, 100);
  } finally { db.close(); }
});

test("old flat rows remain Catalog filters through upsert, rename and delete", () => {
  const db = openCatalog(":memory:");
  try {
    const insert = db.prepare("INSERT INTO saved_filters (name, spec_json) VALUES (?, ?)");
    insert.run("Legacy", JSON.stringify({ q: "redis", sort: "name", dir: "asc", limit: "50", unknown: "ignored" }));
    assert.deepEqual(listSavedFilters(db), [{ name: "Legacy", view: "catalog", spec: { q: "redis", sort: "name", dir: "asc" } }]);
    saveFilter(db, { name: "Legacy", view: "updates", spec: { status: "current" } });
    saveFilter(db, { name: "Legacy", view: "catalog", spec: { q: "updated" } });
    assert.equal(listSavedFilters(db).length, 2);
    assert.equal(renameFilter(db, "Legacy", "New").spec.q, "updated");
    insert.run("Flat", JSON.stringify({ q: "flat" }));
    assert.equal(renameFilter(db, "Flat", "Moved").spec.q, "flat");
    insert.run("Delete flat", "{}");
    deleteFilter(db, "Delete flat");
    assert.equal(listSavedFilters(db).length, 3);
    deleteFilter(db, "New");
    assert.equal(listSavedFilters(db).find((filter) => filter.name === "Legacy")?.view, "updates");
  } finally { db.close(); }
});
