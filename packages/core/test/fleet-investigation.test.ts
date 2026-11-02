import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginInvestigation,
  buildDiagnosticArgv,
  discardInvestigation,
  finishInvestigation,
  fingerprint,
  ingest,
  investigationConfig,
  investigationForIncident,
  investigationUsage,
  loadFleetConfig,
  matchDiagnostics,
  openCatalog,
  type IncidentPacket,
} from "../src/index.ts";

const T = "2026-11-01T12:00:00.000Z";
const MIN = 60_000;
const analyst = { command: ["node", "tools/fleet/investigation-analyst.mjs"] };

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "gamemaster";
  const component = overrides.component ?? "containers";
  const failureClass = overrides.failureClass ?? "dead";
  return {
    version: 1,
    host,
    component,
    severity: "critical",
    failureClass,
    firstSeen: T,
    lastSeen: T,
    count: 1,
    fingerprint: fingerprint(host, component, failureClass),
    summary: `${component} failed`,
    evidence: {},
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
    ...overrides,
  };
}

test("investigation config fills the defaults and keeps the analyst hook", () => {
  const config = investigationConfig({ analyst });
  assert.ok(config);
  assert.equal(config.enabled, true);
  assert.equal(config.maxPerDay, 10);
  assert.equal(config.maxRounds, 3);
  assert.equal(config.maxCostUsdPerDay, null);
  assert.equal(config.timeoutSeconds, 240);
  assert.deepEqual(config.diagnostics, []);
  assert.deepEqual(config.analyst.command, ["node", "tools/fleet/investigation-analyst.mjs"]);
  const full = investigationConfig({
    enabled: false,
    analyst,
    maxPerDay: 5,
    maxRounds: 2,
    maxCostUsdPerDay: 0.5,
    timeoutSeconds: 60,
    diagnostics: [{ id: "docker-ps", machine: "gamemaster", argv: ["docker", "ps", "-a"] }],
  });
  assert.ok(full);
  assert.equal(full.enabled, false);
  assert.equal(full.maxPerDay, 5);
  assert.equal(full.maxRounds, 2);
  assert.equal(full.maxCostUsdPerDay, 0.5);
  assert.equal(full.timeoutSeconds, 60);
  assert.equal(full.diagnostics[0]?.id, "docker-ps");
  assert.equal(full.diagnostics[0]?.timeoutSeconds, 20);
  assert.deepEqual(full.diagnostics[0]?.params, {});
  assert.equal(full.diagnostics[0]?.host, undefined);
  assert.equal(full.diagnostics[0]?.components, undefined);
  assert.equal(full.diagnostics[0]?.failureClasses, undefined);
});

test("investigation config rejects unknown keys, a bad analyst, and out of range limits", () => {
  const invalid: unknown[] = [
    null,
    [],
    true,
    "analyst",
    { analyst, unknown: true },
    { analyst, enabled: "yes" },
    { analyst, maxPerDay: 0 },
    { analyst, maxPerDay: 101 },
    { analyst, maxPerDay: 1.5 },
    { analyst, maxPerDay: "10" },
    { analyst, maxRounds: 0 },
    { analyst, maxRounds: 5 },
    { analyst, maxRounds: 2.5 },
    { analyst, maxCostUsdPerDay: 0 },
    { analyst, maxCostUsdPerDay: 1001 },
    { analyst, maxCostUsdPerDay: -1 },
    { analyst, maxCostUsdPerDay: "1" },
    { analyst, timeoutSeconds: 9 },
    { analyst, timeoutSeconds: 901 },
    { analyst, timeoutSeconds: 240.5 },
    { analyst: null },
    { analyst: "node" },
    { analyst: {} },
    { analyst: { command: [] } },
    { analyst: { command: "node" } },
    { analyst: { command: [""] } },
    { analyst: { command: ["a\nb"] } },
    { analyst: { command: ["a\0b"] } },
    { analyst: { command: ["x".repeat(501)] } },
    { analyst: { command: Array(33).fill("node") } },
  ];
  for (const value of invalid) assert.equal(investigationConfig(value), null, JSON.stringify(value));
  assert.ok(investigationConfig({ analyst: { command: Array(32).fill("node") } }));
  assert.ok(investigationConfig({ analyst, maxCostUsdPerDay: 1000 }));
  assert.ok(investigationConfig({ analyst, maxCostUsdPerDay: null }));
  assert.equal(investigationConfig({ analyst, maxCostUsdPerDay: null })?.maxCostUsdPerDay, null);
});

test("investigation config checks every diagnostic limit", () => {
  const valid = { id: "docker-ps", machine: "gamemaster", argv: ["docker", "ps", "-a"] };
  assert.ok(investigationConfig({ analyst, diagnostics: [valid] }));
  const invalid: unknown[] = [
    { id: "Docker-PS", machine: "gamemaster", argv: ["docker"] },
    { id: "docker_ps", machine: "gamemaster", argv: ["docker"] },
    { id: "", machine: "gamemaster", argv: ["docker"] },
    { id: "x".repeat(65), machine: "gamemaster", argv: ["docker"] },
    { id: "docker-ps", machine: "Game Master", argv: ["docker"] },
    { id: "docker-ps", machine: "", argv: ["docker"] },
    { id: "docker-ps", machine: "x".repeat(65), argv: ["docker"] },
    { id: "docker-ps", machine: "gamemaster", host: "", argv: ["docker"] },
    { id: "docker-ps", machine: "gamemaster", host: "x".repeat(65), argv: ["docker"] },
    { id: "docker-ps", machine: "gamemaster", argv: [] },
    { id: "docker-ps", machine: "gamemaster", argv: Array(21).fill("docker") },
    { id: "docker-ps", machine: "gamemaster", argv: [""] },
    { id: "docker-ps", machine: "gamemaster", argv: ["x".repeat(501)] },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker\nps"] },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: "name" },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { Name: "x" } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { "1name": "x" } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { name: 1 } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { name: "x".repeat(201) } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { name: "[" } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { a: "x", b: "x", c: "x", d: "x", e: "x" } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], components: "containers" },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], components: [""] },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], components: Array(21).fill("containers") },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], components: ["x".repeat(181)] },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], failureClasses: "dead" },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], failureClasses: ["unknown"] },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], timeoutSeconds: 0 },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], timeoutSeconds: 121 },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], timeoutSeconds: 1.5 },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], description: "x".repeat(201) },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], description: "list\ncontainers" },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], unknown: true },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker", "{name}"] },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker"], params: { name: "^[a-z]+$" } },
    { id: "docker-ps", machine: "gamemaster", argv: ["docker", "--label={name}"], params: { name: "^[a-z]+$" } },
  ];
  for (const bad of invalid) assert.equal(investigationConfig({ analyst, diagnostics: [bad] }), null, JSON.stringify(bad));
  assert.equal(investigationConfig({ analyst, diagnostics: [valid, valid] }), null);
  assert.equal(investigationConfig({ analyst, diagnostics: Array(41).fill(valid) }), null);
  assert.equal(investigationConfig({ analyst, diagnostics: [null] }), null);
  assert.equal(investigationConfig({ analyst, diagnostics: "docker" }), null);
  const withParam = investigationConfig({ analyst, diagnostics: [{ id: "docker-logs", machine: "gamemaster", argv: ["docker", "logs", "{name}"], params: { name: "^[A-Za-z0-9_-]+$" } }] });
  assert.ok(withParam);
  assert.equal(withParam.diagnostics[0]?.params.name, "^[A-Za-z0-9_-]+$");
});

test("investigation config refuses a section larger than 65536 characters", () => {
  const details: string[] = [];
  const big = {
    analyst,
    diagnostics: Array.from({ length: 10 }, (_, index) => ({ id: `d${index}`, machine: "gamemaster", argv: Array(20).fill("x".repeat(500)) })),
  };
  assert.equal(investigationConfig(big, (reason) => { details.push(reason); }), null);
  assert.match(details[0] ?? "", /65536/);
});

test("loadFleetConfig accepts an investigation section and names it when it is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-investigation-"));
  try {
    const path = join(dir, "fleet.json");
    const section = {
      enabled: true,
      analyst: { command: ["node", "tools/fleet/investigation-analyst.mjs"] },
      maxPerDay: 5,
      maxRounds: 2,
      timeoutSeconds: 60,
      diagnostics: [{ id: "docker-ps", machine: "gamemaster", argv: ["docker", "ps", "-a"] }],
    };
    writeFileSync(path, JSON.stringify({ investigation: section }), "utf8");
    const file = loadFleetConfig(path);
    assert.equal(file.fileError, null);
    assert.equal(file.investigation?.enabled, true);
    assert.equal(file.investigation?.maxPerDay, 5);
    assert.equal(file.investigation?.maxRounds, 2);
    assert.equal(file.investigation?.timeoutSeconds, 60);
    assert.equal(file.investigation?.diagnostics[0]?.id, "docker-ps");
    writeFileSync(path, JSON.stringify({ ingestTokenEnv: "FLEET_TOKEN", investigation: { analyst: { command: [] } } }), "utf8");
    const broken = loadFleetConfig(path);
    assert.match(broken.fileError ?? "", /malformed/);
    assert.match(broken.fileErrorDetail ?? "", /investigation/);
    assert.equal(broken.investigation, undefined);
    assert.equal(broken.ingestTokenEnv, null);
    writeFileSync(path, JSON.stringify({ digestTimes: ["09:00"] }), "utf8");
    assert.equal(loadFleetConfig(path).investigation, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchDiagnostics matches the host or the machine and filters on component and failure class", () => {
  const config = investigationConfig({
    analyst,
    diagnostics: [
      { id: "by-machine", machine: "gamemaster", argv: ["docker", "ps"] },
      { id: "by-host", machine: "other", host: "GameMaster", argv: ["docker", "ps"] },
      { id: "component", machine: "gamemaster", components: ["containers"], argv: ["docker", "ps"] },
      { id: "class", machine: "gamemaster", failureClasses: ["dead"], argv: ["docker", "ps"] },
      { id: "elsewhere", machine: "laptop", argv: ["docker", "ps"] },
    ],
  });
  assert.ok(config);
  assert.deepEqual(matchDiagnostics(config, { host: "gamemaster", component: "containers", failureClass: "dead" }).map((row) => row.id), ["by-machine", "by-host", "component", "class"]);
  assert.deepEqual(matchDiagnostics(config, { host: "gamemaster", component: "disk", failureClass: "dead" }).map((row) => row.id), ["by-machine", "by-host", "class"]);
  assert.deepEqual(matchDiagnostics(config, { host: "gamemaster", component: "containers", failureClass: "wedged" }).map((row) => row.id), ["by-machine", "by-host", "component"]);
  assert.deepEqual(matchDiagnostics(config, { host: "laptop", component: "containers", failureClass: "dead" }).map((row) => row.id), ["elsewhere"]);
});

test("buildDiagnosticArgv substitutes whole placeholders only and refuses anything else", () => {
  const config = investigationConfig({
    analyst,
    diagnostics: [
      { id: "docker-logs", machine: "gamemaster", argv: ["docker", "logs", "--tail", "80", "{name}", "--label={name}"], params: { name: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$" } },
      { id: "loose", machine: "gamemaster", argv: ["echo", "{name}"], params: { name: "^[a-z]+$" } },
    ],
  });
  assert.ok(config);
  const strict = config.diagnostics[0];
  const loose = config.diagnostics[1];
  assert.ok(strict);
  assert.ok(loose);
  assert.deepEqual(buildDiagnosticArgv(strict, { name: "web-1" }), ["docker", "logs", "--tail", "80", "web-1", "--label={name}"]);
  assert.equal(buildDiagnosticArgv(strict, { name: "web-1 " }), null);
  assert.equal(buildDiagnosticArgv(strict, {}), null);
  assert.equal(buildDiagnosticArgv(strict, { name: "web-1", extra: "x" }), null);
  assert.equal(buildDiagnosticArgv(strict, { name: 7 }), null);
  assert.deepEqual(buildDiagnosticArgv(loose, { name: "abc" }), ["echo", "abc"]);
  assert.equal(buildDiagnosticArgv(loose, { name: "a".repeat(201) }), null);
});

test("investigation rows are written once per incident and counted for the daily caps", () => {
  const db = openCatalog(":memory:");
  try {
    const opened = ingest(db, packet(), T);
    const incident = opened[0]?.incident;
    assert.ok(incident);
    const started = beginInvestigation(db, incident, "operator", T);
    assert.ok(started.id > 0);
    assert.throws(() => beginInvestigation(db, incident, "operator", T));
    const running = investigationForIncident(db, incident);
    assert.equal(running?.status, "running");
    assert.equal(running?.actor, "operator");
    assert.equal(running?.fingerprint, incident.fingerprint);
    assert.equal(running?.openedAt, incident.openedAt);
    assert.equal(running?.startedAt, T);
    assert.equal(running?.finishedAt, null);
    assert.equal(running?.needsHuman, false);
    assert.equal(running?.cause, null);
    assert.deepEqual(running?.proposedActions, []);
    assert.equal(running?.rounds, 0);
    assert.equal(running?.costUsd, 0);

    finishInvestigation(db, started.id, {
      status: "done",
      cause: "the container exited with code 1",
      evidence: "docker ps shows Exited (1)",
      proposedFix: "restart the container",
      needsHuman: true,
      heal: "ran restart-backup",
      proposedActions: ["restart the container"],
      rounds: 2,
      costUsd: 0.25,
    }, plus(T, MIN));
    const done = investigationForIncident(db, incident);
    assert.equal(done?.status, "done");
    assert.equal(done?.cause, "the container exited with code 1");
    assert.equal(done?.evidence, "docker ps shows Exited (1)");
    assert.equal(done?.proposedFix, "restart the container");
    assert.equal(done?.needsHuman, true);
    assert.equal(done?.heal, "ran restart-backup");
    assert.deepEqual(done?.proposedActions, ["restart the container"]);
    assert.equal(done?.rounds, 2);
    assert.equal(done?.costUsd, 0.25);
    assert.equal(done?.finishedAt, plus(T, MIN));
    assert.equal(done?.error, null);

    const usage = investigationUsage(db, T);
    assert.equal(usage.started, 1);
    assert.equal(usage.running, 0);
    assert.equal(usage.costUsd, 0.25);
    assert.deepEqual(investigationUsage(db, plus(T, 2 * MIN)), { started: 0, running: 0, costUsd: 0 });

    const other = ingest(db, packet({ component: "disk" }), T);
    const second = other[0]?.incident;
    assert.ok(second);
    const failed = beginInvestigation(db, second, null, plus(T, 3 * MIN));
    const busy = investigationUsage(db, T);
    assert.equal(busy.started, 2);
    assert.equal(busy.running, 1);
    assert.equal(busy.costUsd, 0.25);
    finishInvestigation(db, failed.id, { status: "failed", error: "the analyst command timed out", rounds: 1, costUsd: 0 }, plus(T, 4 * MIN));
    const failedRow = investigationForIncident(db, second);
    assert.equal(failedRow?.status, "failed");
    assert.equal(failedRow?.error, "the analyst command timed out");
    assert.equal(failedRow?.needsHuman, false);
    assert.equal(failedRow?.cause, null);
    assert.deepEqual(failedRow?.proposedActions, []);
    assert.equal(failedRow?.finishedAt, plus(T, 4 * MIN));

    discardInvestigation(db, started.id);
    assert.equal(investigationForIncident(db, incident), null);
    assert.equal(investigationUsage(db, T).started, 1);
  } finally {
    db.close();
  }
});
