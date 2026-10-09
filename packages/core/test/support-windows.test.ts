import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, recordSupportWindows, SCHEMA_SQL, supportWindowsOf } from "../src/index.ts";

const NOW = "2026-09-30T06:00:00.000Z";

test("support windows replace one package's rows and compute dated and boolean EOL", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'brew', 'node', 'Node'), (2, 'brew', 'python', 'Python')");
    db.exec(SCHEMA_SQL);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "3");
    recordSupportWindows(db, 1, [
      { cycle: "20", eol: "2026-04-30", latest: "20.20.0", lts: true },
      { cycle: "24", eol: "2026-09-30", latest: "24.14.0", lts: true },
      { cycle: "25", eol: true, latest: null, lts: false },
      { cycle: "26", eol: false, latest: "26.8.0", lts: false },
      { cycle: "27", eol: null, latest: null, lts: false },
    ], NOW);
    assert.deepEqual(supportWindowsOf(db, 1).map((row) => [row.cycle, row.eol, row.eolPassed, row.latest, row.lts, row.observedAt]), [
      ["20", "2026-04-30", true, "20.20.0", true, NOW],
      ["24", "2026-09-30", false, "24.14.0", true, NOW],
      ["25", null, true, null, false, NOW],
      ["26", null, false, "26.8.0", false, NOW],
      ["27", null, false, null, false, NOW],
    ]);
    recordSupportWindows(db, 2, [{ cycle: "3.14", eol: null, latest: "3.14.7", lts: false }], NOW);
    recordSupportWindows(db, 1, [{ cycle: "26", eol: "2029-04-30", latest: "26.8.1", lts: true }], NOW);
    assert.equal(supportWindowsOf(db, 1).length, 1);
    assert.equal(supportWindowsOf(db, 1)[0]?.latest, "26.8.1");
    assert.equal(supportWindowsOf(db, 2).length, 1);
    recordSupportWindows(db, 1, [], NOW);
    assert.deepEqual(supportWindowsOf(db, 1), []);
    assert.deepEqual(supportWindowsOf(db, 99), []);
  } finally { db.close(); }
});

test("a rejected support window replacement preserves the earlier rows", () => {
  const db = openCatalog(":memory:");
  try {
    db.exec("INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'brew', 'node', 'Node')");
    const window = { cycle: "26", eol: null, latest: "26.8.0", lts: true };
    recordSupportWindows(db, 1, [window], NOW);
    const before = supportWindowsOf(db, 1);
    assert.throws(() => recordSupportWindows(db, 1, [window, window], NOW));
    assert.deepEqual(supportWindowsOf(db, 1), before);
    assert.throws(() => recordSupportWindows(db, 99, [window], NOW));
  } finally { db.close(); }
});
