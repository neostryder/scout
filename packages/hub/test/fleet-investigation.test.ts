import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginInvestigation, finishInvestigation, fingerprint, ingest, openCatalog, type Exec, type FleetIncident, type FleetNotice, type IncidentPacket, type Transport } from "@scout/core";
import { FleetService } from "../src/fleet.ts";
import { createHub } from "../src/server.ts";

const T = "2026-10-31T18:00:00.000Z";
const MIN = 60_000;
const healer = { id: "restart-backup", command: ["restart", "backup"], host: "desktop", component: "backup", failureClass: "dead", cooldownMinutes: 60, maxPerDay: 3, timeoutSeconds: 120 };
const section = {
  enabled: true,
  analyst: { command: ["analyst"] },
  maxPerDay: 10,
  maxRounds: 3,
  maxCostUsdPerDay: 1,
  timeoutSeconds: 240,
  diagnostics: [
    { id: "docker-ps", machine: "gamemaster", argv: ["docker", "ps", "-a"], components: ["containers"], failureClasses: ["dead"], description: "List all containers with status" },
    { id: "docker-logs", machine: "gamemaster", argv: ["docker", "logs", "--tail", "80", "{name}"], params: { name: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$" }, timeoutSeconds: 30 },
  ],
};

interface Reply { code?: number | null; stdout?: string; error?: string | null }

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "gamemaster";
  const component = overrides.component ?? "containers";
  const failureClass = overrides.failureClass ?? "dead";
  return {
    version: 1, host, component, severity: "critical", failureClass, firstSeen: T, lastSeen: T, count: 1,
    fingerprint: fingerprint(host, component, failureClass), summary: "the container is gone", evidence: {},
    redaction: { applied: false, rules: [] }, ownerChat: null, runbook: null, ...overrides,
  };
}

function setup(t: TestContext, options: { investigation?: Record<string, unknown> | null; healers?: unknown[]; investigator?: Record<string, unknown> | null; analyst?: Reply[]; analystGate?: Promise<void>; exec?: Exec; machines?: { id: string; transport: Transport }[]; env?: (name: string) => string | undefined; after?: () => void | Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-investigation-"));
  const configPath = join(dir, "fleet.json");
  const body: Record<string, unknown> = { ingestTokenEnv: "SCOUT_FLEET_INGEST_TOKEN", policy: { escalateAfterMinutes: 1, escalateEveryMinutes: 1 }, digestTimes: ["03:33"], notifiers: [{ type: "command", command: ["notify"] }], healers: options.healers ?? [healer] };
  if (options.investigation !== null) body.investigation = options.investigation ?? section;
  if (options.investigator !== null) body.investigator = options.investigator ?? { command: ["hook"] };
  writeFileSync(configPath, JSON.stringify(body));
  const db = openCatalog(":memory:");
  let now = new Date(T);
  const notices: FleetNotice[] = [];
  const analystCalls: string[] = [];
  const hookCalls: string[] = [];
  const healCalls: string[] = [];
  const execCalls: { argv: string[]; timeoutMs: number }[] = [];
  const logs: string[] = [];
  const replies = [...(options.analyst ?? [])];
  let analystIndex = 0;
  const service = new FleetService(db, {
    configPath,
    now: () => now,
    log: (line) => logs.push(line),
    env: options.env ?? ((name: string) => name === "SCOUT_FLEET_INGEST_TOKEN" ? "ingest-secret" : undefined),
    machines: () => options.machines ?? [{ id: "gamemaster", transport: { type: "local" } }],
    exec: options.exec ?? (async (_transport: Transport, argv: string[], timeoutMs: number) => {
      execCalls.push({ argv, timeoutMs });
      return { exitCode: 0, stdout: `ran ${argv.join(" ")}`, stderr: "" };
    }),
    run: async (_program: string, _args: string[], stdin: string) => {
      notices.push(JSON.parse(stdin) as FleetNotice);
      return { code: 0, error: null };
    },
    runCapture: async (program: string, _args: string[], stdin: string) => {
      if (program === "analyst") {
        analystCalls.push(stdin);
        if (options.analystGate) await options.analystGate;
        const reply = replies[analystIndex] ?? replies[replies.length - 1] ?? { code: 0, stdout: "{\"final\":true,\"cause\":\"the analyst had nothing to add\"}" };
        analystIndex += 1;
        return { code: reply.code ?? 0, stdout: reply.stdout ?? "", error: reply.error ?? null };
      }
      if (program === "hook") {
        hookCalls.push(stdin);
        return { code: 0, stdout: "{\"ok\":true,\"reference\":\"note-1\"}", error: null };
      }
      if (program === "restart") {
        healCalls.push(stdin);
        return { code: 0, stdout: "{\"ok\":true}", error: null };
      }
      return { code: 0, stdout: "", error: null };
    },
  });
  t.after(async () => { await options.after?.(); service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const events = (kind: string) => db.prepare("SELECT incident_id, at, detail FROM fleet_events WHERE kind = ? ORDER BY id").all(kind) as { incident_id: number | null; at: string; detail: string }[];
  const advance = (minutes: number) => { now = new Date(Date.parse(T) + minutes * MIN); };
  const open = (overrides: Partial<IncidentPacket> = {}): FleetIncident => {
    const made = packet(overrides);
    ingest(db, made, T);
    const row = service.incidents({}).find((item) => item.fingerprint === made.fingerprint);
    if (!row) throw new Error("the incident was not created");
    return row;
  };
  return { dir, db, service, notices, analystCalls, hookCalls, healCalls, execCalls, logs, events, advance, open };
}

test("a headless tap runs the diagnostics, stores the finding and hands it to the notifier and the hook", async (t) => {
  const app = setup(t, { analyst: [{ stdout: "{\"final\":true,\"cause\":\"the container exited\",\"evidence\":\"the log shows a crash loop\",\"proposedFix\":\"restart the container\",\"needsHuman\":true,\"heal\":false,\"proposedActions\":[\"restart the container\"],\"costUsd\":0.25}" }] });
  const incident = app.open();
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate", "operator"), { ok: true, error: null, reference: "investigation started" });
  await app.service.settled();
  assert.deepEqual(app.execCalls, [{ argv: ["docker", "ps", "-a"], timeoutMs: 20_000 }]);
  const request = JSON.parse(app.analystCalls[0]!) as { round: number; roundsLeft: number; incident: { host: string }; diagnostics: { id: string; output: string; args: Record<string, string> }[]; available: { id: string; params: string[] }[] };
  assert.equal(request.round, 1);
  assert.equal(request.roundsLeft, 2);
  assert.equal(request.incident.host, "gamemaster");
  assert.equal(request.diagnostics.length, 1);
  assert.equal(request.diagnostics[0]?.id, "docker-ps");
  assert.equal(request.diagnostics[0]?.output, "ran docker ps -a");
  assert.deepEqual(request.diagnostics[0]?.args, {});
  assert.deepEqual(request.available, [{ id: "docker-logs", description: "", params: ["name"] }]);
  const view = app.service.incident(incident.id);
  assert.equal(view?.investigation?.status, "done");
  assert.equal(view?.investigation?.cause, "the container exited");
  assert.equal(view?.investigation?.evidence, "the log shows a crash loop");
  assert.equal(view?.investigation?.proposedFix, "restart the container");
  assert.equal(view?.investigation?.needsHuman, true);
  assert.deepEqual(view?.investigation?.proposedActions, ["restart the container"]);
  assert.equal(view?.investigation?.rounds, 1);
  assert.equal(view?.investigation?.costUsd, 0.25);
  assert.equal(view?.investigation?.actor, "operator");
  assert.equal(view?.investigation?.error, null);
  assert.equal(app.events("investigation")[0]?.detail, "the container exited");
  assert.equal(app.events("investigate")[0]?.detail, "note-1");
  const notice = app.notices.find((row) => row.kind === "investigation");
  assert.equal(notice?.title, "finding: gamemaster containers");
  assert.equal(notice?.severity, "critical");
  assert.equal(notice?.incidentId, incident.id);
  assert.deepEqual(notice?.actions, []);
  assert.equal(notice?.body, "Cause: the container exited\nEvidence: the log shows a crash loop\nProposed fix: restart the container\nProposed actions: restart the container\nNeeds a human: yes");
  const hook = JSON.parse(app.hookCalls[0]!) as { finding: { status: string; cause: string; rounds: number; costUsd: number; actor: string | null }; actor: string | null };
  assert.equal(hook.finding.status, "done");
  assert.equal(hook.finding.cause, "the container exited");
  assert.equal(hook.finding.rounds, 1);
  assert.equal(hook.finding.costUsd, 0.25);
  assert.equal(hook.finding.actor, "operator");
  assert.equal(hook.actor, "operator");
});

test("a more request runs the parameterized diagnostic and the next round reads its output", async (t) => {
  const app = setup(t, { analyst: [
    { stdout: "{\"final\":false,\"run\":[{\"id\":\"docker-logs\",\"args\":{\"name\":\"web-1\"}}],\"costUsd\":0.25}" },
    { stdout: "{\"final\":true,\"cause\":\"the log shows a crash loop\",\"evidence\":\"the container restarted 3 times\",\"costUsd\":0.5}" },
  ] });
  const incident = app.open();
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
  await app.service.settled();
  assert.deepEqual(app.execCalls.map((row) => row.argv), [["docker", "ps", "-a"], ["docker", "logs", "--tail", "80", "web-1"]]);
  assert.equal(app.execCalls[1]?.timeoutMs, 30_000);
  const second = JSON.parse(app.analystCalls[1]!) as { round: number; roundsLeft: number; diagnostics: { id: string; args: Record<string, string>; output: string }[] };
  assert.equal(second.round, 2);
  assert.equal(second.roundsLeft, 1);
  assert.equal(second.diagnostics.length, 1);
  assert.equal(second.diagnostics[0]?.id, "docker-logs");
  assert.deepEqual(second.diagnostics[0]?.args, { name: "web-1" });
  assert.equal(second.diagnostics[0]?.output, "ran docker logs --tail 80 web-1");
  assert.equal(app.service.incident(incident.id)?.investigation?.costUsd, 0.75);
  assert.equal(app.service.incident(incident.id)?.investigation?.rounds, 2);
});

test("a request with a bad argument is reported and never runs", async (t) => {
  const app = setup(t, { analyst: [
    { stdout: "{\"final\":false,\"run\":[{\"id\":\"docker-logs\",\"args\":{\"name\":\"not a name\"}},{\"id\":\"docker-logs\",\"args\":{\"name\":\"web-1\",\"extra\":\"x\"}},{\"id\":\"not-declared\",\"args\":{}}]}" },
    { stdout: "{\"final\":true,\"cause\":\"the logs were unavailable\"}" },
  ] });
  const incident = app.open();
  await app.service.handleAction(incident.id, "investigate");
  await app.service.settled();
  assert.deepEqual(app.execCalls.map((row) => row.argv), [["docker", "ps", "-a"]]);
  const second = JSON.parse(app.analystCalls[1]!) as { diagnostics: { id: string; error: string | null; output: string }[] };
  assert.equal(second.diagnostics.length, 3);
  assert.deepEqual(second.diagnostics.map((row) => row.id), ["docker-logs", "docker-logs", "not-declared"]);
  assert.equal(second.diagnostics[0]?.error, "invalid arguments");
  assert.equal(second.diagnostics[1]?.error, "invalid arguments");
  assert.equal(second.diagnostics[2]?.error, "no such diagnostic");
  assert.equal(second.diagnostics[0]?.output, "");
  assert.equal(app.service.incident(incident.id)?.investigation?.status, "done");
});

test("one fingerprint is investigated once per open cycle", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = setup(t, { analystGate: gate });
  const incident = app.open();
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "already running" });
  release?.();
  await app.service.settled();
  assert.equal(app.analystCalls.length, 1);
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "already investigated" });
  await app.service.settled();
  assert.equal(app.analystCalls.length, 1);
});

test("a failed row is replaced and a stale running row counts as failed", async (t) => {
  const app = setup(t);
  const incident = app.open();
  const failed = beginInvestigation(app.db, incident, null, T);
  finishInvestigation(app.db, failed.id, { status: "failed", rounds: 0, costUsd: 0, error: "the analyst gave up" }, T);
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
  await app.service.settled();
  assert.equal(app.service.incident(incident.id)?.investigation?.status, "done");
  const rows = (app.db.prepare("SELECT status FROM fleet_investigations").all() as { status: string }[]).map((row) => ({ status: row.status }));
  assert.deepEqual(rows, [{ status: "done" }]);
  const stale = app.open({ component: "other" });
  beginInvestigation(app.db, stale, null, new Date(Date.parse(T) - 20 * MIN).toISOString());
  assert.deepEqual(await app.service.handleAction(stale.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
  await app.service.settled();
  assert.equal(app.service.incident(stale.id)?.investigation?.status, "done");
});

test("the daily count and the daily cost refuse a tap without recording a row", async (t) => {
  const counted = setup(t, { investigation: { ...section, maxPerDay: 1 } });
  const first = counted.open();
  const other = counted.open({ component: "other" });
  beginInvestigation(counted.db, other, null, T);
  assert.deepEqual(await counted.service.handleAction(first.id, "investigate"), { ok: false, error: "daily investigation limit reached" });
  assert.equal((counted.db.prepare("SELECT COUNT(*) AS count FROM fleet_investigations").get() as { count: number } | undefined)?.count, 1);
  const costly = setup(t, { investigation: { ...section, maxCostUsdPerDay: 1 } });
  const target = costly.open();
  const spent = costly.open({ component: "other" });
  const row = beginInvestigation(costly.db, spent, null, T);
  finishInvestigation(costly.db, row.id, { status: "done", rounds: 1, costUsd: 1, cause: "an older finding" }, T);
  assert.deepEqual(await costly.service.handleAction(target.id, "investigate"), { ok: false, error: "daily investigation cost limit reached" });
  assert.equal((costly.db.prepare("SELECT COUNT(*) AS count FROM fleet_investigations").get() as { count: number } | undefined)?.count, 1);
});

test("a third investigation at once is refused", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = setup(t, { analystGate: gate });
  const first = app.open();
  const second = app.open({ component: "second" });
  const third = app.open({ component: "third" });
  assert.deepEqual(await app.service.handleAction(first.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
  assert.deepEqual(await app.service.handleAction(second.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
  assert.deepEqual(await app.service.handleAction(third.id, "investigate"), { ok: false, error: "too many investigations running" });
  release?.();
  await app.service.settled();
  assert.equal(app.analystCalls.length, 2);
});

test("the kill switch file hands the tap to the old investigator hook", async (t) => {
  const app = setup(t);
  writeFileSync(join(app.dir, "investigation.off"), "");
  const incident = app.open();
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "note-1" });
  assert.equal(app.analystCalls.length, 0);
  assert.equal(app.execCalls.length, 0);
  const hook = JSON.parse(app.hookCalls[0]!) as { finding?: unknown; incident: { host: string } };
  assert.equal(hook.finding, undefined);
  assert.equal(hook.incident.host, "gamemaster");
  assert.equal(app.events("investigate")[0]?.detail, "note-1");
});

test("a switched off investigation without a hook says so", async (t) => {
  const app = setup(t, { investigator: null });
  writeFileSync(join(app.dir, "investigation.off"), "");
  const incident = app.open();
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: false, error: "investigations are switched off" });
  assert.deepEqual(await app.service.investigateHttp(incident.id), { status: 200, body: { ok: false, error: "investigations are switched off" } });
  assert.equal(app.analystCalls.length, 0);
});

test("a disabled investigation section hands the tap to the old investigator hook", async (t) => {
  const app = setup(t, { investigation: { ...section, enabled: false } });
  const incident = app.open();
  assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "note-1" });
  assert.equal(app.analystCalls.length, 0);
  const off = setup(t, { investigation: { ...section, enabled: false }, investigator: null });
  const other = off.open();
  assert.deepEqual(await off.service.handleAction(other.id, "investigate"), { ok: false, error: "investigations are switched off" });
});

test("an analyst that fails ends the run with a safe error", async (t) => {
  for (const reply of [
    { code: null, stdout: "", error: "timeout" },
    { code: 3, stdout: "", error: null },
    { code: 0, stdout: "the analyst wrote prose", error: null },
    { code: 0, stdout: "[]", error: null },
    { code: 0, stdout: "{\"final\":true}", error: null },
    { code: 1, stdout: "", error: "failed https://example.test/private Bearer hidden" },
  ]) {
    const app = setup(t, { analyst: [reply] });
    const incident = app.open();
    assert.deepEqual(await app.service.handleAction(incident.id, "investigate"), { ok: true, error: null, reference: "investigation started" });
    await app.service.settled();
    const view = app.service.incident(incident.id)?.investigation;
    assert.equal(view?.status, "failed");
    assert.equal(view?.cause, null);
    assert.equal(view?.error?.includes("example.test"), false);
    assert.equal(view?.error?.includes("hidden"), false);
    assert.equal(app.notices.find((row) => row.kind === "investigation")?.title, "investigation failed: gamemaster containers");
  }
});

test("an analyst that never concludes leaves the run incomplete", async (t) => {
  const app = setup(t, { analyst: [{ stdout: "{\"final\":false,\"run\":[{\"id\":\"docker-logs\",\"args\":{\"name\":\"web-1\"}}]}" }] });
  const incident = app.open();
  await app.service.handleAction(incident.id, "investigate");
  await app.service.settled();
  const view = app.service.incident(incident.id)?.investigation;
  assert.equal(view?.status, "incomplete");
  assert.equal(view?.cause, "The analyst did not reach a conclusion.");
  assert.equal(view?.rounds, 3);
  assert.equal(app.analystCalls.length, 3);
  assert.ok(view?.evidence?.includes("docker-logs"));
});

test("a heal request runs the matching healer once and records the outcome", async (t) => {
  const app = setup(t, { analyst: [{ stdout: "{\"final\":true,\"cause\":\"the service is down\",\"heal\":true}" }] });
  const incident = app.open({ host: "desktop", component: "backup", failureClass: "dead" });
  await app.service.handleAction(incident.id, "investigate");
  await app.service.settled();
  assert.equal(app.healCalls.length, 1);
  assert.equal(app.service.incident(incident.id)?.investigation?.heal, "ran restart-backup");
  assert.equal(app.events("investigation-heal")[0]?.detail, "ran restart-backup");
  assert.equal(app.events("heal")[0]?.detail, "desktop/backup/dead restart-backup");
});

test("a heal request inside the cooldown and on a closed incident skips the healer", async (t) => {
  const cooled = setup(t, { analyst: [{ stdout: "{\"final\":true,\"cause\":\"the service is down\",\"heal\":true}" }] });
  const incident = cooled.open({ host: "desktop", component: "backup", failureClass: "dead" });
  cooled.db.prepare("INSERT INTO fleet_events (incident_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(incident.id, T, "heal", "desktop/backup/dead restart-backup");
  await cooled.service.handleAction(incident.id, "investigate");
  await cooled.service.settled();
  assert.equal(cooled.healCalls.length, 0);
  assert.equal(cooled.service.incident(incident.id)?.investigation?.heal, "skipped: cooldown or daily limit");
  const closed = setup(t, { analyst: [{ stdout: "{\"final\":true,\"cause\":\"the service is down\",\"heal\":true}" }] });
  const other = closed.open({ host: "desktop", component: "backup", failureClass: "dead" });
  ingest(closed.db, packet({ host: "desktop", component: "backup", failureClass: "dead", recovered: true }), T, { resolveAfterCleanChecks: 1 });
  assert.equal(closed.service.incidents({}).find((row) => row.id === other.id)?.state, "resolved");
  await closed.service.handleAction(other.id, "investigate");
  await closed.service.settled();
  assert.equal(closed.healCalls.length, 0);
  assert.equal(closed.service.incident(other.id)?.investigation?.heal, "skipped: incident is not open");
});

test("text from the analyst is redacted and clipped and a missing machine is reported", async (t) => {
  const app = setup(t, {
    analyst: [{ stdout: JSON.stringify({ final: true, cause: `password: hunter2 ${"ab ".repeat(200)}`, evidence: "cd ".repeat(1000), proposedFix: "ef ".repeat(500), proposedActions: ["gh ".repeat(100), "ij ".repeat(100), "c", "d", "e", "f"] }) }],
    exec: async () => ({ exitCode: 0, stdout: "kl ".repeat(2000), stderr: "" }),
  });
  const incident = app.open();
  await app.service.handleAction(incident.id, "investigate");
  await app.service.settled();
  const view = app.service.incident(incident.id)?.investigation;
  assert.equal(view?.cause?.startsWith("password: [redacted:secret]"), true);
  assert.equal(view?.cause?.length, 300);
  assert.equal(view?.evidence?.length, 1500);
  assert.equal(view?.proposedFix?.length, 600);
  assert.equal(view?.proposedActions?.length, 5);
  assert.equal(view?.proposedActions?.[0]?.length, 200);
  const request = JSON.parse(app.analystCalls[0]!) as { diagnostics: { output: string }[] };
  assert.equal(request.diagnostics[0]?.output.length, 4000);
  assert.equal(request.diagnostics[0]?.output.startsWith("kl "), true);
  const secret = setup(t, { analyst: [{ stdout: "{\"final\":true,\"cause\":\"nothing to read\"}" }], exec: async () => ({ exitCode: 0, stdout: "token: abcdef", stderr: "" }) });
  const other = secret.open();
  await secret.service.handleAction(other.id, "investigate");
  await secret.service.settled();
  const redacted = JSON.parse(secret.analystCalls[0]!) as { diagnostics: { output: string }[] };
  assert.equal(redacted.diagnostics[0]?.output, "token: [redacted:secret]");
  const missing = setup(t, { machines: [], analyst: [{ stdout: "{\"final\":true,\"cause\":\"nothing to read\"}" }] });
  const unknown = missing.open();
  await missing.service.handleAction(unknown.id, "investigate");
  await missing.service.settled();
  assert.equal(missing.execCalls.length, 0);
  const without = JSON.parse(missing.analystCalls[0]!) as { diagnostics: { id: string; error: string | null }[] };
  assert.equal(without.diagnostics[0]?.error, "machine gamemaster is not known");
});

test("the action endpoint answers a headless tap with the finding message", async (t) => {
  let close: (() => Promise<void>) | undefined;
  const app = setup(t, {
    analyst: [{ stdout: "{\"final\":true,\"cause\":\"the container exited\"}" }],
    after: async () => { await close?.(); },
  });
  const token = "ingest-secret";
  const server = createHub({ db: app.db, webRoot: ".", control: false, health: false, alerts: { alertsPath: "fixtures/alerts/missing.json" }, fleet: app.service });
  close = async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (body: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/api/fleet/actions", method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => { resolve({ status: res.statusCode ?? 0, body: raw.startsWith("{") ? JSON.parse(raw) : raw }); });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  const incident = app.open();
  assert.deepEqual(await call({ incidentId: incident.id, action: "investigate" }), { status: 200, body: { ok: true, message: "Investigation started. The finding will be posted here when it is ready." } });
  await app.service.settled();
  assert.equal(app.service.incident(incident.id)?.investigation?.status, "done");
});

test("the incident view carries the investigation and is null before one runs", async (t) => {
  const app = setup(t, { analyst: [{ stdout: "{\"final\":true,\"cause\":\"the container exited\",\"evidence\":\"the log is empty\"}" }] });
  const incident = app.open();
  assert.equal(app.service.incident(incident.id)?.investigation, null);
  await app.service.handleAction(incident.id, "investigate");
  await app.service.settled();
  const view = app.service.incident(incident.id)?.investigation;
  assert.equal(view?.status, "done");
  assert.equal(view?.cause, "the container exited");
  assert.equal(view?.evidence, "the log is empty");
  assert.equal(view?.startedAt, T);
  assert.equal(view?.finishedAt, T);
  assert.equal(view?.heal, null);
  assert.equal(view?.error, null);
});
