import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, remoteConfig, runArgv, type ExecResult, type FleetFile, type IncidentPacket, type Transport } from "@scout/core";
import { FleetRemoteSource, type FleetRemoteOptions } from "../src/fleet-remote.ts";
import type { FleetService } from "../src/fleet.ts";

const T = "2026-10-31T18:00:00.000Z";
const success: ExecResult = { exitCode: 0, stdout: "running", stderr: "" };
const check = { machine: "example", component: "Example app", argv: ["example", "status"], timeoutSeconds: 30, pattern: "error", mustMatch: "running" };
const transport: Transport = { type: "ssh", target: "example" };

function fixture() {
  const db = openCatalog(":memory:");
  const remote = remoteConfig({ enabled: true, checks: [check] })!;
  const file: FleetFile = { policy: null, notifiers: [], investigator: null, triage: null, healers: [], expected: [], ingestTokenEnv: null, digestTimes: [], fileError: null, sources: { remote } };
  const batches: IncidentPacket[][] = [];
  const logs: string[] = [];
  const calls: { transport: Transport; argv: string[]; timeoutMs: number; maxOutputBytes: number | undefined }[] = [];
  const state = { result: { exitCode: 1, stdout: "failed", stderr: "command error" }, machines: [{ id: "example", transport }], machineReads: 0 };
  const stub: Pick<FleetService, "config" | "accept"> = {
    config: () => file,
    accept: async (items) => {
      batches.push(items as IncidentPacket[]);
      return { accepted: items.length, rejected: [] };
    },
  };
  const options: FleetRemoteOptions = {
    now: () => new Date(T),
    log: (line) => { logs.push(line); },
    machines: () => { state.machineReads += 1; return state.machines; },
    exec: async (transport, argv, timeoutMs, _signal, _env, hooks) => {
      calls.push({ transport, argv, timeoutMs, maxOutputBytes: hooks?.maxOutputBytes });
      return state.result;
    },
  };
  const fleet = stub as FleetService;
  const stored = () => db.prepare("SELECT value FROM meta WHERE key = 'fleet_remote_state'").get() as { value: string } | undefined;
  return { db, remote, file, batches, logs, calls, state, stub, fleet, options, stored };
}

test("remote source does no I/O unless explicitly enabled with a valid fleet file", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  for (const sources of [undefined, {}, { remote: remoteConfig({})! }, { remote: { ...f.remote, enabled: false } }]) {
    f.file.sources = sources;
    await source.tick();
  }
  f.file.sources = { remote: f.remote };
  f.file.fileError = "malformed";
  await source.tick();
  assert.deepEqual(f.batches, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.machineReads, 0);
  assert.equal(f.stored(), undefined);
});

test("remote tick sends a failure once and recovers once after restart", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0]?.[0]?.summary, "command failed (exit 1)");
  assert.deepEqual(JSON.parse(f.stored()!.value), f.batches[0]);
  assert.deepEqual(f.calls, [{ transport, argv: check.argv, timeoutMs: 30_000, maxOutputBytes: 65_536 }]);
  await source.tick();
  assert.equal(f.batches.length, 2);
  assert.deepEqual(f.batches[1], f.batches[0]);
  f.state.result = success;
  const restarted = new FleetRemoteSource(f.db, f.fleet, { ...f.options, now: () => new Date("2026-10-31T18:01:00.000Z") });
  await restarted.tick();
  assert.deepEqual(f.batches[2], f.batches[0]?.map((item) => ({ ...item, recovered: true, lastSeen: "2026-10-31T18:01:00.000Z", summary: "recovered" })));
  await restarted.tick();
  assert.equal(f.batches.length, 3);
  assert.equal(f.stored()?.value, "[]");
  assert.deepEqual(f.logs, []);
});

test("changed failure evidence and severity are delivered for the same fingerprint", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  await source.tick();
  f.state.result.stderr = "different error";
  await source.tick();
  f.remote.checks[0]!.severity = "critical";
  await source.tick();
  assert.equal(f.batches.length, 3);
  assert.equal(f.batches[1]?.[0]?.evidence.stderrTail, "different error");
  assert.equal(f.batches[2]?.[0]?.severity, "critical");
  assert.equal(f.batches[2]?.[0]?.fingerprint, f.batches[0]?.[0]?.fingerprint);
});

test("unknown or paused machines share a watcher incident without running commands", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.remote.checks.push({ ...f.remote.checks[0]!, component: "Other", unreachable: "ignore" });
  f.state.machines = [];
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  await assert.doesNotReject(source.tick());
  assert.deepEqual(f.calls, []);
  assert.equal(f.batches[0]?.length, 1);
  assert.equal(f.batches[0]?.[0]?.host, "example");
  assert.equal(f.batches[0]?.[0]?.component, "remote:example");
  assert.equal(f.batches[0]?.[0]?.failureClass, "watcher-failure");
  assert.equal(f.batches[0]?.[0]?.summary, "machine is not in the machine list");
  await source.tick();
  assert.equal(f.batches.length, 2);
  f.state.machines = [{ id: "example", transport }];
  f.state.result = success;
  await source.tick();
  assert.equal(f.batches[2]?.[0]?.recovered, true);
});

test("transport failures and runner timeouts report a watcher incident and recover", async (t) => {
  for (const exitCode of [255, -1]) {
    const f = fixture();
    t.after(() => f.db.close());
    f.state.result = { exitCode, stdout: "", stderr: exitCode === -1 ? "" : "connection refused" };
    const source = new FleetRemoteSource(f.db, f.fleet, f.options);
    await source.tick();
    assert.equal(f.batches[0]?.[0]?.component, "remote:example");
    assert.equal(f.batches[0]?.[0]?.summary, "remote checks could not reach the machine");
    assert.equal(f.batches[0]?.[0]?.evidence.stderrTail, exitCode === -1 ? "timeout" : "connection refused");
    f.state.result = success;
    await source.tick();
    assert.equal(f.batches[1]?.[0]?.recovered, true);
  }
});

test("remote checks use at most four workers and skip overlapping ticks", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.remote.checks = Array.from({ length: 11 }, (_, i) => ({ ...f.remote.checks[0]!, component: `Example ${i}` }));
  let active = 0;
  let maximum = 0;
  let count = 0;
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const source = new FleetRemoteSource(f.db, f.fleet, { ...f.options, exec: async () => {
    count += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await pending;
    active -= 1;
    return success;
  } });
  const first = source.tick();
  await source.tick();
  assert.equal(count, 4);
  assert.equal(maximum, 4);
  release();
  await first;
  assert.equal(count, 11);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  await source.tick();
  assert.equal(count, 22);
});

test("throwing commands stay contained and other checks still report", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.remote.checks.push({ ...f.remote.checks[0]!, component: "Other", argv: ["other", "status"] });
  const source = new FleetRemoteSource(f.db, f.fleet, { ...f.options, exec: async (_transport, argv) => {
    if (argv[0] === "example") throw new Error("process failed");
    return f.state.result;
  } });
  await assert.doesNotReject(source.tick());
  assert.deepEqual(f.batches[0]?.map((item) => item.component), ["Example app", "Other"]);
  assert.equal(f.batches[0]?.[0]?.evidence.stderrTail, "process failed");
  assert.deepEqual(f.logs, []);
});

test("machine-list failures stay contained and release the busy guard", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, { ...f.options, machines: () => { throw new Error("machine list unreadable"); } });
  await assert.doesNotReject(source.tick());
  await assert.doesNotReject(source.tick());
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, Array(2).fill("fleet remote tick failed: machine list unreadable"));
});

test("command output is capped per stream before matching and evidence is redacted", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  f.state.result = { exitCode: 0, stdout: `running\n${"x ".repeat(32_764)}\nERROR outside cap`, stderr: "" };
  await source.tick();
  assert.equal(f.batches.length, 0);
  f.state.result = { exitCode: 1, stdout: "ERROR password=example-value", stderr: `${"a ".repeat(32_768)}outside cap` };
  await source.tick();
  const item = f.batches[0]![0]!;
  assert.equal(item.redaction.applied, true);
  assert.doesNotMatch(JSON.stringify(item), /example-value|outside cap/);
  assert.doesNotMatch(f.stored()!.value, /example-value|outside cap/);
  assert.ok(item.evidence.journalTail!.length <= 1500);
  assert.ok(item.evidence.stderrTail!.length <= 1500);
});

test("runArgv bounds both captured streams by bytes without splitting UTF-8 characters", async () => {
  const result = await runArgv({ type: "local" }, [process.execPath, "-e", "process.stdout.write('\\u00e9'.repeat(50000)); process.stderr.write('x'.repeat(100000));"], 15_000, undefined, undefined, { maxOutputBytes: 65_535 });
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 65_535);
  assert.ok(Buffer.byteLength(result.stdout) >= 65_532);
  assert.equal(Buffer.byteLength(result.stderr), 65_535);
  assert.doesNotMatch(result.stdout, /\ufffd/);
});

test("failed acceptance preserves state for recovery retry and logs bounded errors", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  await source.tick();
  const saved = f.stored()!.value;
  const accept = f.stub.accept;
  f.stub.accept = async () => { throw new Error(`https://example.test/private Bearer example-credential ${"x".repeat(300)}`); };
  f.state.result = success;
  await assert.doesNotReject(source.tick());
  assert.equal(f.stored()?.value, saved);
  assert.doesNotMatch(f.logs[0]!, /example\.test|example-credential/);
  assert.ok(f.logs[0]!.length <= "fleet remote tick failed: ".length + 200);
  f.stub.accept = accept;
  await source.tick();
  assert.equal(f.batches[1]?.[0]?.recovered, true);
  assert.equal(f.stored()?.value, "[]");
});

test("rejected packets and malformed persisted state do not advance state", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.stub.accept = async () => ({ accepted: 0, rejected: [{ index: 0, error: "ingest failed" }] });
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.stored(), undefined);
  assert.deepEqual(f.logs, ["fleet remote tick failed: remote source packets were rejected"]);
  for (const value of ["{", "{}", "[{}]"]) {
    f.db.prepare("INSERT INTO meta (key, value) VALUES ('fleet_remote_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
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
  const source = new FleetRemoteSource(f.db, f.fleet, { ...f.options, every });
  source.start();
  source.start();
  assert.deepEqual(intervals, [120_000]);
  callbacks[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.batches.length, 1);
  source.stop();
  source.stop();
  assert.equal(stops, 1);
  const custom = new FleetRemoteSource(f.db, f.fleet, { ...f.options, every, intervalMs: 1000 });
  custom.start();
  assert.deepEqual(intervals, [120_000, 1000]);
  custom.stop();
  assert.equal(stops, 2);
});

test("a check that cannot reach its machine keeps the open incident instead of recovering it", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const source = new FleetRemoteSource(f.db, f.fleet, f.options);
  await source.tick();
  assert.equal(f.batches[0]?.[0]?.summary, "command failed (exit 1)");
  f.remote.checks[0]!.unreachable = "ignore";
  f.state.result = { exitCode: 255, stdout: "", stderr: "connection refused" };
  await source.tick();
  assert.equal(f.batches.length, 2);
  assert.equal(f.batches[1]?.[0]?.recovered, undefined);
  assert.equal(f.batches[1]?.[0]?.summary, "command failed (exit 1)");
  f.state.result = success;
  await source.tick();
  assert.equal(f.batches[2]?.[0]?.recovered, true);
});
