import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, incidentById, listIncidents, openCatalog, type IncidentPacket } from "@scout/core";
import { commandNotifier, FleetService, runCommand } from "../src/fleet.ts";

const T = "2026-10-31T18:00:00.000Z";
const QUIET = "2026-10-31T12:00:00.000Z";
const MIN = 60_000;

function packet(overrides: Partial<IncidentPacket> = {}): IncidentPacket {
  const host = overrides.host ?? "desktop";
  const component = overrides.component ?? "backup";
  const failureClass = overrides.failureClass ?? "ran-failed";
  return {
    version: 1,
    host,
    component,
    severity: overrides.severity ?? "warning",
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

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

test("a hanging channel does not block ingest and a failure is retried once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-delivery-"));
  const db = openCatalog(":memory:");
  try {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({ ingestTokenEnv: "SCOUT_FLEET_INGEST_TOKEN", notifiers: [{ type: "webhook", urlEnv: "HOOK" }] }));
    let release: (() => void) | undefined;
    const hung = new Promise<Response>((resolve) => { release = () => resolve(new Response("ok")); });
    const scheduled: { ms: number; fn: () => void }[] = [];
    const logs: string[] = [];
    let mode: "hang" | "fail" = "hang";
    const env: Record<string, string> = { HOOK: "http://hooks.example/secret", SCOUT_FLEET_INGEST_TOKEN: "ingest-secret" };
    let now = new Date(T);
    const service = new FleetService(db, {
      configPath: path,
      env: (name) => env[name],
      now: () => now,
      log: (line) => logs.push(line),
      later: (fn, ms) => { scheduled.push({ fn, ms }); return { stop() { /* cancelled with the service */ } }; },
      every: () => ({ stop() { /* no interval in this test */ } }),
      fetch: () => mode === "hang" ? hung : Promise.reject(new Error("down http://hooks.example/secret Bearer ingest-secret")),
    });
    const first = service.accept([packet({ failureClass: "dead", severity: "critical" })]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      first.then((result) => result),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("blocked"), 500); }),
    ]);
    clearTimeout(timer);
    assert.notEqual(raced, "blocked");
    assert.equal(typeof raced === "object" && raced.accepted, 1);
    assert.equal(listIncidents(db, { state: "open" }).length, 1);
    release?.();
    await hung;

    mode = "fail";
    now = new Date(plus(T, MIN));
    const before = logs.length;
    await service.accept([packet({ component: "sync", failureClass: "dead", severity: "critical" })]);
    await until(() => logs.length > before);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.ms, 60_000);
    assert.match(logs[before] ?? "", /fleet notice not delivered \(webhook-1\)/);
    assert.equal((logs[before] ?? "").includes("hooks.example"), false);
    assert.equal((logs[before] ?? "").includes("ingest-secret"), false);
    const after = logs.length;
    scheduled[0]?.fn();
    await until(() => logs.length > after);
    assert.equal(scheduled.length, 1);
    service.stop();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command delivery passes argv and stdin without a shell", async () => {
  const seen: { program: string; args: string[]; stdin: string }[] = [];
  const notifier = commandNotifier({
    id: "command-1",
    command: ["node", "-e", "process.stdin.resume()"],
    run: async (program, args, stdin) => { seen.push({ program, args, stdin }); return { code: 0, error: null }; },
  });
  const result = await notifier.send({ title: "warning: desktop backup", body: "backup failed", severity: "warning", incidentId: 4, kind: "incident", actions: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(seen[0]?.args, ["-e", "process.stdin.resume()"]);
  assert.equal(seen[0]?.program, "node");
  assert.match(seen[0]?.stdin ?? "", /"title":"warning: desktop backup"/);

  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-cmd-"));
  try {
    const out = join(dir, "out.txt");
    const ran = await runCommand(process.execPath, ["-e", "let s=''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => { require('node:fs').writeFileSync(process.argv[1], s); });", out], "{\"ok\":true}", 15_000);
    assert.equal(ran.error, null);
    assert.equal(readFileSync(out, "utf8"), "{\"ok\":true}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(predicate(), true);
}

test("quiet-hour end and the local digest slot each send one digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-digest-"));
  const db = openCatalog(":memory:");
  try {
    const path = join(dir, "fleet.json");
    const quietNow = new Date(QUIET);
    const openNow = new Date("2026-10-31T14:00:00.000Z");
    const localSlot = new Date(2026, 9, 31, 8, 0, 0, 0);
    const hm = (date: Date): string => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const blocked = new Set([hm(quietNow), hm(openNow), "08:00"]);
    let unused = "03:33";
    if (blocked.has(unused)) unused = "03:34";
    writeFileSync(path, JSON.stringify({
      policy: { quietHours: { start: "22:00", end: "07:00", timezone: "-07:00" } },
      digestTimes: [unused],
      notifiers: [{ type: "command", command: ["node", "-e", "0"] }],
    }));
    const notes: { kind: string; incidentId: number | null }[] = [];
    let now = quietNow;
    const service = new FleetService(db, {
      configPath: path,
      now: () => now,
      every: () => ({ stop() { /* tick is called directly */ } }),
      run: async (_program, _args, stdin) => { notes.push(JSON.parse(stdin) as { kind: string; incidentId: number | null }); return { code: 0, error: null }; },
    });
    await service.accept([packet({ summary: "held for the morning" })]);
    service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notes.length, 0);
    now = openNow;
    service.tick();
    await until(() => notes.length === 1);
    assert.equal(notes[0]?.kind, "digest");
    assert.equal(notes[0]?.incidentId, null);
    writeFileSync(path, JSON.stringify({
      policy: { quietHours: { start: "22:00", end: "07:00", timezone: "-07:00" } },
      digestTimes: ["08:00"],
      notifiers: [{ type: "command", command: ["node", "-e", "0"] }],
    }));
    await service.accept([packet({ component: "sync", summary: "second held item" })]);
    now = localSlot;
    service.tick();
    await until(() => notes.length === 2);
    assert.equal(notes[1]?.kind, "digest");
    service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notes.length, 2);
    service.stop();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an open critical escalates from the sweep and a fresh heartbeat resolves a missed run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-sweep-"));
  const db = openCatalog(":memory:");
  try {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({
      expected: [{ host: "desktop", component: "backup", everyMinutes: 10, graceMinutes: 1, since: "2026-10-31T00:00:00.000Z" }],
      notifiers: [{ type: "desktop" }],
    }));
    const titles: string[] = [];
    let now = new Date("2026-10-31T18:00:00.000Z");
    const service = new FleetService(db, {
      configPath: path,
      now: () => now,
      every: () => ({ stop() { /* tick is called directly */ } }),
      desktop: async (notice) => { titles.push(notice.title); },
    });
    await service.accept([packet({ failureClass: "dead", severity: "critical", summary: "down" })]);
    await until(() => titles.some((title) => title.startsWith("critical:")));
    now = new Date(plus(T, 30 * MIN));
    service.tick();
    await until(() => titles.some((title) => title.startsWith("escalate:")));
    const open = listIncidents(db, { state: "open", failureClass: "never-ran" });
    assert.equal(open.length, 1);
    const beat = packet({ failureClass: "watcher-failure", severity: "info", evidence: { snapshot: { heartbeat: true } }, summary: "heartbeat backup" });
    await service.accept([beat]);
    assert.equal(incidentById(db, open[0]!.id)?.state, "resolved");
    service.stop();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
