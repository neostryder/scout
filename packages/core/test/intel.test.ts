import { test } from "node:test";
import assert from "node:assert/strict";
import { getIntel, listIntel, openCatalog, putIntel } from "../src/index.ts";

test("intel keeps one document per package and source, and the latest write replaces the earlier one", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'model', 'org/model', 'Model'), (2, 'model', 'org/other', 'Other')");
    putIntel(db, 1, "huggingface", { latestRevision: "aaa", variants: ["Q4_K_M"] }, "2026-10-19T06:00:00.000Z");
    putIntel(db, 1, "huggingface", { latestRevision: "bbb", variants: ["Q4_K_M", "Q8_0"] }, "2026-10-19T12:00:00.000Z");
    putIntel(db, 1, "gitclone", { behind: 3 }, "2026-10-19T12:00:00.000Z");
    assert.deepEqual(getIntel(db, 1, "huggingface"), { packageId: 1, source: "huggingface", fetchedAt: "2026-10-19T12:00:00.000Z", data: { latestRevision: "bbb", variants: ["Q4_K_M", "Q8_0"] } });
    assert.deepEqual(listIntel(db, 1).map((row) => row.source), ["gitclone", "huggingface"]);
    assert.equal(getIntel(db, 2, "huggingface"), null);
    assert.deepEqual(listIntel(db, 2), []);
  } finally {
    db.close();
  }
});

test("intel treats a document that is not a JSON object as missing", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'model', 'org/model', 'Model')");
    db.exec("INSERT INTO source_intel (package_id, source, fetched_at, data_json) VALUES (1, 'a', 't', '[1]'), (1, 'b', 't', 'not json')");
    assert.equal(getIntel(db, 1, "a"), null);
    assert.equal(getIntel(db, 1, "b"), null);
    assert.deepEqual(listIntel(db, 1), []);
  } finally {
    db.close();
  }
});
