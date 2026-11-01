import { test } from "node:test";
import assert from "node:assert/strict";
import { localConfig, openCatalog, type FleetFile, type IncidentPacket } from "@scout/core";
import { FleetLocalSource, type FleetLocalOptions } from "../src/fleet-local.ts";
import type { FleetService } from "../src/fleet.ts";

const T = "2026-10-31T18:00:00.000Z";
const eventXml = `<Events><Event><System><Provider Name="Example"/><EventID>101</EventID><TimeCreated SystemTime="${T}"/></System><EventData><Data>task failed</Data></EventData></Event></Events>`;

function fixture() {
  const db = openCatalog(":memory:");
  const local = localConfig({ enabled: true, host: "Example", disk: { paths: ["C:/"] }, windowsEvents: [{ component: "Task failures", log: "Example-Operational", ids: [101, 201], levels: [1, 2, 3] }], wsl: { enabled: true }, logs: [{ component: "Example app", path: "C:/Example/app.log", pattern: "ERROR", tailKilobytes: 32 }] })!;
  const file: FleetFile = { policy: null, notifiers: [], investigator: null, triage: null, healers: [], expected: [], ingestTokenEnv: null, digestTimes: [], fileError: null, sources: { local } };
  const batches: IncidentPacket[][] = [];
  const logs: string[] = [];
  const calls: { program: string; args: string[]; stdin: string; timeoutMs: number }[] = [];
  const reads: { path: string; bytes: number }[] = [];
  const disks: string[] = [];
  const stats: string[] = [];
  const state = { free: 4, eventCode: 0 as number | null, eventError: null as string | null, xml: eventXml, wslCode: 1 as number | null, wslError: "exit 1" as string | null, text: "ERROR failed", mtimeMs: Date.parse(T), missing: false };
  const stub: Pick<FleetService, "config" | "accept"> = {
    config: () => file,
    accept: async (items) => {
      batches.push(items as IncidentPacket[]);
      return { accepted: items.length, rejected: [] };
    },
  };
  const options: FleetLocalOptions = {
    now: () => new Date(T),
    log: (line) => { logs.push(line); },
    statfs: async (path) => { disks.push(path); return { bsize: 1024 ** 3, blocks: 100, bavail: state.free }; },
    runCapture: async (program, args, stdin, timeoutMs) => {
      calls.push({ program, args, stdin, timeoutMs });
      return program === "wsl.exe" ? { code: state.wslCode, stdout: "\u0000\ufffd", error: state.wslError } : { code: state.eventCode, stdout: state.xml, error: state.eventError };
    },
    readTail: async (path, bytes) => {
      reads.push({ path, bytes });
      if (state.missing) throw Object.assign(new Error("file missing"), { code: "ENOENT" });
      return state.text;
    },
    stat: async (path) => { stats.push(path); return { mtimeMs: state.mtimeMs }; },
  };
  const fleet = stub as FleetService;
  const healthy = () => { state.free = 80; state.xml = ""; state.wslCode = 0; state.wslError = null; state.text = "INFO healthy"; state.missing = false; state.mtimeMs = Date.parse(T); };
  const stored = () => db.prepare("SELECT value FROM meta WHERE key = 'fleet_local_state'").get() as { value: string } | undefined;
  return { db, local, file, batches, logs, calls, reads, disks, stats, state, stub, fleet, options, healthy, stored };
}

test("local source does no I/O unless explicitly enabled with a valid fleet file", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  for (const sources of [undefined, {}, { local: localConfig({})! }, { local: { ...f.local, enabled: false } }]) {
    f.file.sources = sources;
    await source.tick();
  }
  f.file.sources = { local: f.local };
  f.file.fileError = "malformed";
  await source.tick();
  assert.deepEqual(f.batches, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.disks, []);
  assert.deepEqual(f.stats, []);
  assert.equal(f.stored(), undefined);
});

test("local tick opens all four sources, repeats fingerprints, and recovers once after restart", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches.length, 1);
  assert.deepEqual(f.batches[0]?.map((item) => [item.component, item.failureClass]), [["disk:C:/", "resources"], ["Task failures", "ran-failed"], ["wsl", "dead"], ["Example app", "ran-failed"]]);
  assert.deepEqual(JSON.parse(f.stored()!.value), f.batches[0]);
  assert.deepEqual(f.disks, ["C:/"]);
  assert.deepEqual(f.reads, [{ path: "C:/Example/app.log", bytes: 32 * 1024 }]);
  assert.deepEqual(f.stats, ["C:/Example/app.log"]);
  assert.deepEqual(f.calls, [
    { program: "wevtutil.exe", args: ["qe", "Example-Operational", "/q:*[System[(EventID=101 or EventID=201) and (Level=1 or Level=2 or Level=3) and TimeCreated[timediff(@SystemTime) <= 1800000]]]", "/c:20", "/rd:true", "/f:xml"], stdin: "", timeoutMs: 15_000 },
    { program: "wsl.exe", args: ["--status"], stdin: "", timeoutMs: 15_000 },
  ]);
  await source.tick();
  assert.equal(f.batches.length, 2);
  assert.deepEqual(f.batches[1]?.map((item) => item.fingerprint), f.batches[0]?.map((item) => item.fingerprint));
  f.healthy();
  const restarted = new FleetLocalSource(f.db, f.fleet, { ...f.options, now: () => new Date("2026-10-31T18:01:00.000Z") });
  await restarted.tick();
  assert.deepEqual(f.batches[2], f.batches[0]?.map((item) => ({ ...item, recovered: true, lastSeen: "2026-10-31T18:01:00.000Z", summary: "recovered" })));
  await restarted.tick();
  assert.equal(f.batches.length, 3);
  assert.equal(f.stored()?.value, "[]");
  assert.deepEqual(f.logs, []);
});

test("task probe uses PowerShell with a longer timeout and recovers failed tasks", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.healthy();
  f.local.tasks.enabled = true;
  const task = { path: "\\Example\\Watchdog", name: "Watchdog", state: "Ready", enabled: true, lastRun: T, lastResult: 2147942402, nextRun: null };
  const capture = f.options.runCapture!;
  let result = { code: 0 as number | null, stdout: JSON.stringify([task]), error: null as string | null };
  f.options.runCapture = async (program, args, stdin, timeoutMs) => {
    if (program !== "pwsh.exe") return capture(program, args, stdin, timeoutMs);
    f.calls.push({ program, args, stdin, timeoutMs });
    return result;
  };
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  const call = f.calls.find((item) => item.program === "pwsh.exe")!;
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(call.args[3]!, /ConvertTo-Json -Compress -InputObject @\(Get-ScheduledTask \| ForEach-Object/);
  assert.match(call.args[3]!, /Get-ScheduledTaskInfo/);
  assert.match(call.args[3]!, /\$ErrorActionPreference = 'Stop'/);
  assert.equal(call.stdin, "");
  assert.equal(call.timeoutMs, 40_000);
  assert.ok(f.calls.filter((item) => item.program !== "pwsh.exe").every((item) => item.timeoutMs === 15_000));
  assert.equal(f.batches[0]?.[0]?.component, `task:${task.path}`);
  assert.equal(f.batches[0]?.[0]?.failureClass, "ran-failed");
  await source.tick();
  assert.equal(f.batches[1]?.[0]?.fingerprint, f.batches[0]?.[0]?.fingerprint);
  result = { ...result, stdout: JSON.stringify([{ ...task, lastResult: 0 }]) };
  const restarted = new FleetLocalSource(f.db, f.fleet, f.options);
  await restarted.tick();
  assert.equal(f.batches[2]?.[0]?.recovered, true);
  await restarted.tick();
  assert.equal(f.batches.length, 3);
  result = { code: null, stdout: "", error: "timeout" };
  await restarted.tick();
  assert.equal(f.batches[3]?.[0]?.component, "tasks");
  assert.equal(f.batches[3]?.[0]?.failureClass, "watcher-failure");
  result = { code: 0, stdout: "[]", error: null };
  await restarted.tick();
  assert.equal(f.batches[4]?.[0]?.recovered, true);
  assert.deepEqual(f.logs, []);
});

test("query failure produces one watcher fingerprint and recovers when the query succeeds", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.healthy();
  f.state.eventCode = 1;
  f.state.eventError = "access denied";
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  await source.tick();
  assert.equal(f.batches[0]?.length, 1);
  assert.equal(f.batches[0]?.[0]?.component, "windowsEvents:Task failures");
  assert.equal(f.batches[0]?.[0]?.failureClass, "watcher-failure");
  assert.equal(f.batches[1]?.[0]?.fingerprint, f.batches[0]?.[0]?.fingerprint);
  f.state.eventCode = 0;
  f.state.eventError = null;
  await source.tick();
  assert.equal(f.batches[2]?.[0]?.recovered, true);
  await source.tick();
  assert.equal(f.batches.length, 3);
});

test("missing logs report with null staleness and recover after the file appears", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.healthy();
  f.state.missing = true;
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  await source.tick();
  assert.equal(f.batches[0]?.[0]?.component, "log:Example app");
  assert.equal(f.batches[0]?.[0]?.failureClass, "watcher-failure");
  assert.equal(f.batches[1]?.[0]?.fingerprint, f.batches[0]?.[0]?.fingerprint);
  f.state.missing = false;
  await source.tick();
  assert.equal(f.batches[2]?.[0]?.recovered, true);
});

test("stale logs produce critical incidents and recover after mtime advances", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.healthy();
  f.local.logs[0]!.staleAfterMinutes = 30;
  f.state.mtimeMs -= 31 * 60_000;
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches[0]?.[0]?.failureClass, "wedged");
  assert.equal(f.batches[0]?.[0]?.severity, "critical");
  f.state.mtimeMs = Date.parse(T);
  await source.tick();
  assert.equal(f.batches[1]?.[0]?.recovered, true);
});

test("WSL ENOENT skips both returned and thrown errors and timeouts produce dead incidents", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.healthy();
  f.state.wslCode = null;
  f.state.wslError = "spawn wsl.exe ENOENT";
  await new FleetLocalSource(f.db, f.fleet, f.options).tick();
  assert.equal(f.batches.length, 0);
  const capture = f.options.runCapture!;
  f.options.runCapture = async (...args) => {
    if (args[0] === "wsl.exe") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return capture(...args);
  };
  await new FleetLocalSource(f.db, f.fleet, f.options).tick();
  assert.equal(f.batches.length, 0);
  f.options.runCapture = capture;
  f.state.wslError = "timeout";
  await new FleetLocalSource(f.db, f.fleet, f.options).tick();
  assert.equal(f.batches[0]?.[0]?.failureClass, "dead");
  assert.equal(f.batches[0]?.[0]?.evidence.snapshot?.timedOut, true);
});

test("probe exceptions stay contained and do not prevent the other probes from reporting", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetLocalSource(f.db, f.fleet, {
    ...f.options,
    statfs: async () => { throw new Error("disk denied"); },
    runCapture: async () => { throw new Error("process failed"); },
    stat: async () => { throw new Error("stat denied"); },
  });
  await assert.doesNotReject(source.tick());
  assert.deepEqual(f.batches[0]?.map((item) => item.failureClass), ["watcher-failure", "watcher-failure", "dead", "watcher-failure"]);
  assert.deepEqual(f.logs, []);
});

test("busy guard skips overlapping ticks and releases after completion", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  let release: (value: { bsize: number; blocks: number; bavail: number }) => void = () => undefined;
  const pending = new Promise<{ bsize: number; blocks: number; bavail: number }>((resolve) => { release = resolve; });
  let count = 0;
  const source = new FleetLocalSource(f.db, f.fleet, { ...f.options, statfs: () => { count += 1; return pending; } });
  const first = source.tick();
  await source.tick();
  assert.equal(count, 1);
  assert.equal(f.batches.length, 0);
  release({ bsize: 1024, blocks: 100, bavail: 4 });
  await first;
  assert.equal(f.batches.length, 1);
  await source.tick();
  assert.equal(count, 2);
});

test("failed acceptance preserves state for recovery retry and logs bounded errors", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  const saved = f.stored()!.value;
  const accept = f.stub.accept;
  f.stub.accept = async () => { throw new Error(`https://example.test/private Bearer example-credential ${"x".repeat(300)}`); };
  f.healthy();
  await assert.doesNotReject(source.tick());
  assert.equal(f.stored()?.value, saved);
  assert.doesNotMatch(f.logs[0]!, /example\.test|example-credential/);
  assert.ok(f.logs[0]!.length <= "fleet local tick failed: ".length + 200);
  f.stub.accept = accept;
  await source.tick();
  assert.equal(f.batches[1]?.length, 4);
  assert.ok(f.batches[1]?.every((item) => item.recovered));
  assert.equal(f.stored()?.value, "[]");
});

test("log evidence is redacted and capped before delivery, persistence, and recovery", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.healthy();
  f.state.text = Array(5).fill(`ERROR ${"password=example-value ".repeat(20)}`).join("\n");
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  const item = f.batches[0]![0]!;
  assert.equal(item.redaction.applied, true);
  assert.ok(item.evidence.journalTail!.length <= 1500);
  assert.doesNotMatch(JSON.stringify(item), /example-value/);
  assert.doesNotMatch(f.stored()!.value, /example-value/);
  f.healthy();
  await source.tick();
  assert.equal(f.batches[1]?.[0]?.recovered, true);
  assert.ok(f.batches[1]![0]!.evidence.journalTail!.length <= 1500);
});

test("rejected packets and malformed persisted state do not advance state", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.stub.accept = async () => ({ accepted: 0, rejected: [{ index: 0, error: "ingest failed" }] });
  const source = new FleetLocalSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.stored(), undefined);
  assert.deepEqual(f.logs, ["fleet local tick failed: local source packets were rejected"]);
  for (const value of ["{", "{}", "[{}]"]) {
    f.db.prepare("INSERT INTO meta (key, value) VALUES ('fleet_local_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
    await assert.doesNotReject(source.tick());
    assert.equal(f.stored()?.value, value);
  }
  assert.equal(f.logs.length, 4);
});

test("start and stop manage one timer with the default or supplied interval", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const callbacks: (() => void)[] = [];
  const intervals: number[] = [];
  let stops = 0;
  const every = (fn: () => void, ms: number) => { callbacks.push(fn); intervals.push(ms); return { stop: () => { stops += 1; } }; };
  const source = new FleetLocalSource(f.db, f.fleet, { ...f.options, every });
  source.start();
  source.start();
  assert.deepEqual(intervals, [120_000]);
  callbacks[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.batches.length, 1);
  source.stop();
  source.stop();
  assert.equal(stops, 1);
  const custom = new FleetLocalSource(f.db, f.fleet, { ...f.options, every, intervalMs: 1000 });
  custom.start();
  assert.deepEqual(intervals, [120_000, 1000]);
  custom.stop();
  assert.equal(stops, 2);
});
