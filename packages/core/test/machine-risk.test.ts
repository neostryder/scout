import { test } from "node:test";
import assert from "node:assert/strict";
import { machineRisks, openCatalog, recordResearch, recordScan, riskLevel, scoreRisk, upsertMachine, type Db, type RiskInputs } from "../src/index.ts";

const emptyHealth = { openHigh: 0, openWarn: 0, resolvedHigh: 0, outage: false };
const score = (inputs: Partial<RiskInputs> = {}) => scoreRisk({ pending: [], health: emptyHealth, ...inputs });

test("empty input has no risk", () => {
  assert.equal(score().score, 0);
  assert.equal(score().level, "low");
});

test("pending updates contribute priority risk", () => {
  const result = score({ pending: [{ priority: 100, hard: 0, soft: 0 }] });
  assert.equal(result.parts[0]?.value, 1 - Math.exp(-0.25));
  assert.ok(result.score > 0);
});

test("dependency edges contribute hard and soft risk", () => {
  const result = score({ pending: [{ priority: 0, hard: 1, soft: 2 }] });
  assert.equal(result.parts[1]?.value, 0.3);
  assert.match(result.parts[1]?.detail || "", /1 update would break.*2 updates may affect/);
});

test("health alerts contribute the configured values", () => {
  const result = score({ health: { openHigh: 1, openWarn: 1, resolvedHigh: 1, outage: true } });
  assert.equal(result.parts[2]?.value, 1);
});

test("high inputs cap at 100", () => {
  assert.equal(score({ pending: Array.from({ length: 30 }, () => ({ priority: 100, hard: 10, soft: 10 })), health: { openHigh: 5, openWarn: 5, resolvedHigh: 5, outage: true } }).score, 100);
});

test("risk levels change at the documented boundaries", () => {
  assert.deepEqual([24, 25, 49, 50, 74, 75].map(riskLevel), ["low", "moderate", "moderate", "elevated", "elevated", "high"]);
});

test("machine risks include installed machines and their open health alerts", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "empty", name: "Empty", os: "linux", kind: "host" });
  recordScan(db, "hub", { sourceKind: "winget", location: "", status: "ok", installs: [{ ecosystem: "winget", key: "Example.App", name: "Example", kind: "package", version: "1.0", location: "", details: {} }] }, "2026-10-01T00:00:00.000Z");
  const packageId = (db.prepare("SELECT id FROM packages WHERE key = 'Example.App'").get() as { id: number }).id;
  recordResearch(db, packageId, "vendor", "ok", [{ channel: "stable", version: "2.0", installable: true }], null, "2026-10-01T00:00:00.000Z");
  db.prepare("INSERT INTO alerts (at, kind, severity, machine_id, key, title, detail, state, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("2026-10-01T00:00:00.000Z", "crash-loop", "high", "hub", "hub-crash", "Crash loop", "Repeated exits", "open", 0);
  db.prepare("INSERT INTO alerts (at, kind, severity, machine_id, key, title, detail, state, resolved_at, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("2026-09-30T00:00:00.000Z", "unhealthy", "high", "hub", "hub-resolved", "Recovered", "Recovered", "resolved", "2026-10-01T12:00:00.000Z", 0);
  db.prepare("INSERT INTO alerts (at, kind, severity, machine_id, key, title, detail, state, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("2026-10-01T00:00:00.000Z", "unhealthy", "high", "hub", "hub-muted", "Muted", "Muted alert", "open", 1);
  const rows = machineRisks(db, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(rows.map((row) => row.machineId), ["hub"]);
  assert.ok(Math.abs((rows[0]?.parts[2]?.value ?? 0) - 0.9) < 1e-10);
  assert.ok((rows[0]?.score ?? 0) > 0);
});
