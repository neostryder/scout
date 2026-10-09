import { test } from "node:test";
import assert from "node:assert/strict";
import { changelogSummaryFor, listChangelogSummaries, openCatalog, recordChangelogSummary } from "../src/index.ts";

test("changelog summaries keep their first text and list only requested packages", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'npm', 'tool', 'Tool'), (2, 'npm', 'other', 'Other')");
    const input = { packageId: 1, version: "2.0.0", summary: "The release fixes startup.", sourceUrl: "https://github.com/example/tool/releases/tag/v2.0.0", model: "fixture" };
    recordChangelogSummary(db, input, "2026-09-30T06:00:00.000Z");
    recordChangelogSummary(db, { ...input, summary: "The replacement must not be stored.", model: "other" }, "2026-10-01T06:00:00.000Z");
    assert.deepEqual({ ...changelogSummaryFor(db, 1, "2.0.0") }, { ...input, flagsJson: null, createdAt: "2026-09-30T06:00:00.000Z" });
    recordChangelogSummary(db, { ...input, version: "3.0.0" });
    recordChangelogSummary(db, { ...input, packageId: 2 });
    assert.deepEqual(listChangelogSummaries(db, [1, 1]).map((row) => [row.packageId, row.version]), [[1, "2.0.0"], [1, "3.0.0"]]);
    assert.equal(listChangelogSummaries(db, [1, 2]).length, 3);
    assert.deepEqual(listChangelogSummaries(db, []), []);
    assert.deepEqual(listChangelogSummaries(db, [99]), []);
    assert.equal(changelogSummaryFor(db, 1, "4.0.0"), null);
    assert.throws(() => recordChangelogSummary(db, { ...input, packageId: 99 }));
  } finally { db.close(); }
});
