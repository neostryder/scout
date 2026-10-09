import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, queryInstalls, recordScan, recordUsage, SCHEMA_SQL, SCHEMA_VERSION, upsertMachine } from "../src/index.ts";
import { loadCheckpoints, saveCheckpoints } from "../../../adapters/aiuse/src/index.ts";

const NOW = "2026-09-30T12:00:00.000Z";

function seed() {
  const db = openCatalog(":memory:");
  for (const id of ["synthetic", "other"]) {
    upsertMachine(db, { id, name: id, os: "windows", kind: "host" });
    recordScan(db, id, { sourceKind: "synthetic", location: "", status: "ok", installs: [
      { ecosystem: "local", key: "git-first", name: "Git first", kind: "binary", version: "1", location: "C:/tools/GIT.EXE" },
      { ecosystem: "local", key: "git", name: "Git second", kind: "binary", version: "1", location: "" },
      { ecosystem: "local", key: "rg", name: "Ripgrep", kind: "binary", version: "1", location: "C:/tools/rg.cmd" },
      { ecosystem: "local", key: "unused", name: "Unused", kind: "binary", version: "1", location: "" },
    ] }, NOW);
  }
  return db;
}

test("tool names match every duplicate executable or package key on the selected machine", () => {
  const db = seed();
  try {
    const signals = [
      { match: { name: "Git" }, kind: "ai_use_7d", value: "3", available: true },
      { match: { name: "Git" }, kind: "ai_use_30d", value: "14", available: true },
      { match: { name: "Git" }, kind: "ai_last_used", value: NOW, available: true },
      { match: { name: "rg" }, kind: "ai_use_30d", value: "2", available: true },
    ];
    const summary = recordUsage(db, "synthetic", { origin: "ai-use", status: "ok", signals, completeFor: ["ai_use_7d", "ai_use_30d"] }, NOW);
    assert.equal(summary.unmatched, 0);
    const rows = queryInstalls(db, { machines: ["synthetic"], aiUsed: true, sort: "aiUse" });
    assert.deepEqual(rows.map((r) => [r.name, r.aiUse7, r.aiUse30]), [["Git first", 3, 14], ["Git second", 3, 14], ["Ripgrep", 0, 2]]);
    assert.deepEqual(queryInstalls(db, { machines: ["synthetic"], aiUsed: true, sort: "aiUse", dir: "asc" }).map((r) => r.name), ["Ripgrep", "Git first", "Git second"]);
    assert.ok(queryInstalls(db, { machines: ["other"] }).every((r) => r.aiUse7 === null && r.aiUse30 === null));
    assert.equal(queryInstalls(db, { machines: ["synthetic"], text: "Unused" })[0]!.aiUse30, 0);
    assert.equal(queryInstalls(db, { machines: ["synthetic"], usedWithinDays: 7, now: NOW }).length, 2);
    recordUsage(db, "synthetic", { origin: "spotlight", status: "ok", signals: [{ match: { name: "git" }, kind: "last_used", value: null, available: true }] }, NOW);
    assert.equal(queryInstalls(db, { machines: ["synthetic"], neverUsed: true }).length, 0);
    recordUsage(db, "synthetic", { origin: "ai-use", status: "ok", signals: [], completeFor: ["ai_use_7d", "ai_use_30d"] }, NOW);
    assert.equal(queryInstalls(db, { machines: ["synthetic"], aiUsed: true }).length, 0);
  } finally { db.close(); }
});

test("a partial reading does not label unmatched tools as unused and unavailable counts do not filter", () => {
  const db = seed();
  try {
    recordUsage(db, "synthetic", { origin: "ai-use", status: "partial", signals: [{ match: { name: "git" }, kind: "ai_use_30d", value: "4", available: false }] }, NOW);
    assert.equal(queryInstalls(db, { machines: ["synthetic"], aiUsed: true }).length, 0);
    assert.ok(queryInstalls(db, { machines: ["synthetic"] }).every((r) => r.aiUse7 === null && r.aiUse30 === null));
  } finally { db.close(); }
});

test("checkpoint state stays separate per machine and source and strips private fields before storage", () => {
  const db = seed();
  try {
    const file = { pathHash: "a".repeat(24), size: 100, offset: 100, prefixLength: 64, prefixHash: "b".repeat(64), days: [{ tool: "git", date: "2026-09-30", count: 2, lastSeen: NOW }], command: "PRIVATE_VALUE" };
    const output = { exitCode: 0, stdout: `#checkpoint ${JSON.stringify({ files: { ["c".repeat(24)]: file }, private: "PRIVATE_VALUE" })}\n`, stderr: "" };
    saveCheckpoints(db, "synthetic", { claude: output, codex: output }, NOW);
    assert.deepEqual(Object.keys(loadCheckpoints(db, "synthetic")), ["claude", "codex"]);
    assert.deepEqual(loadCheckpoints(db, "other"), {});
    const stored = db.prepare("SELECT state_json FROM ai_use_checkpoints").all() as { state_json: string }[];
    assert.ok(stored.every((row) => !row.state_json.includes("PRIVATE_VALUE") && !row.state_json.includes("command")));
    saveCheckpoints(db, "synthetic", { claude: { ...output, exitCode: 1 } }, "2026-10-01T12:00:00.000Z");
    assert.equal((db.prepare("SELECT updated_at FROM ai_use_checkpoints WHERE machine_id = 'synthetic' AND agent = 'claude'").get() as { updated_at: string }).updated_at, NOW);
    saveCheckpoints(db, "synthetic", { claude: { ...output, stdout: '#checkpoint {"files":{}}\n' } }, NOW);
    assert.deepEqual(loadCheckpoints(db, "synthetic").claude, { files: {} });
    assert.ok(Object.keys(loadCheckpoints(db, "synthetic").codex!.files).length > 0);
  } finally { db.close(); }
});

test("the additive checkpoint schema preserves an existing catalog and runs repeatedly", () => {
  const db = seed();
  try {
    db.exec("DROP TABLE ai_use_checkpoints");
    db.exec(SCHEMA_SQL);
    db.exec(SCHEMA_SQL);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM installs").get() as { count: number }).count, 8);
    assert.deepEqual(db.prepare("PRAGMA table_info(ai_use_checkpoints)").all().map((r) => r.name), ["machine_id", "agent", "state_json", "updated_at"]);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
  } finally { db.close(); }
});
