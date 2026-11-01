import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { incidentByFingerprint, fingerprint, openCatalog } from "@scout/core";
import { FleetService } from "../src/fleet.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const T = "2026-11-01T18:00:00.000Z";

test("invalid fleet config logs each detail once, opens one incident, and recovers after repair", async (t) => {
  const dir = mkdtempSync(join(root, "scout-fleet-config-"));
  const db = openCatalog(":memory:");
  const path = join(dir, "fleet.json");
  const logs: string[] = [];
  let revision = 0;
  const write = (text: string) => writeFileSync(path, `${text}${" ".repeat(revision++)}`);
  const service = new FleetService(db, {
    configPath: path,
    now: () => new Date(T),
    log: (line) => { logs.push(line); },
    later: () => { throw new Error("The test forbids timers."); },
    every: () => { throw new Error("The test forbids timers."); },
    triage: { classify: async () => { throw new Error("Config incidents must bypass triage."); } },
  });
  t.after(() => { service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const invalid = JSON.stringify({ sources: { remote: { enabled: true, checks: [{ machine: "example", component: "hermes cron", argv: ["private\nargument"] }] } } });
  const detail = 'sources.remote.checks[0] (component "hermes cron"): argv part 1 holds a control character such as a newline';
  write(invalid);
  assert.equal(service.config().fileErrorDetail, detail);
  service.config();
  assert.deepEqual(logs, [`fleet file ignored: ${detail}`]);
  service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const key = fingerprint("Eru", "fleet config", "dead");
  const incident = incidentByFingerprint(db, key)!;
  assert.equal(incident.state, "open");
  assert.equal(incident.host, "Eru");
  assert.equal(incident.component, "fleet config");
  assert.equal(incident.failureClass, "dead");
  assert.equal(incident.severity, "critical");
  assert.equal(incident.summary, `fleet.json is invalid and ignored: ${detail}`);
  write(invalid);
  service.tick();
  assert.equal(incidentByFingerprint(db, key)?.id, incident.id);
  assert.deepEqual(logs, [`fleet file ignored: ${detail}`]);
  write("{");
  service.tick();
  assert.equal(incidentByFingerprint(db, key)?.summary, "fleet.json is invalid and ignored: the file is not valid JSON");
  assert.deepEqual(logs, [`fleet file ignored: ${detail}`, "fleet file ignored: the file is not valid JSON"]);
  write(invalid);
  service.tick();
  assert.equal(logs.length, 2);
  write("{}");
  service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = incidentByFingerprint(db, key)!;
  assert.equal(recovered.id, incident.id);
  assert.equal(recovered.state, "resolved");
  assert.equal(recovered.packet.recovered, true);
  assert.equal(recovered.summary, "fleet.json loaded cleanly");
  service.tick();
  assert.equal(incidentByFingerprint(db, key)?.count, recovered.count);
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fleet_incidents").get()?.count, 1);
});

test("a clean fleet file recovers a config incident retained across service restarts", async (t) => {
  const dir = mkdtempSync(join(root, "scout-fleet-config-"));
  const path = join(dir, "fleet.json");
  const db = openCatalog(":memory:");
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const service = new FleetService(db, { configPath: path, now: () => new Date(T) });
  service.tick();
  assert.equal(service.incidents({}).length, 0);
  writeFileSync(path, "{");
  service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  service.stop();
  writeFileSync(path, "{}");
  const restarted = new FleetService(db, { configPath: path, now: () => new Date(T) });
  restarted.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.incidents({ state: "open" }).length, 0);
  assert.equal(restarted.incidents({ state: "resolved" })[0]?.component, "fleet config");
  restarted.stop();
});
