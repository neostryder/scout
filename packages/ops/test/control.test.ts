import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { listActions, listServices, openCatalog, recordCloudflare, recordListeners, recordServices, upsertMachine, type ActionRecord, type ControlRow, type Db, type Exec, type ServiceFact, type Transport } from "@scout/core";
import { ControlError, ControlRunner, LAUNCHD_STARTUP, MAC_PROCESS, planControl, TASK_CONTROL, UAC_CONTROL, WINDOWS_CONTROL, WINDOWS_PROCESS, type ControlClock, type ControlMachine, type ControlPlan, type ControlRunnerDeps } from "../src/control.ts";

const classification = { class: "third-party" as const, vendor: "other" as const, official: false, hidden: false, evidence: [], whatBreaks: "A local workload stops.", confidence: "default" as const };
const row = (over: Partial<ControlRow> = {}): ControlRow => ({ id: 1, machineId: "hub", machineName: "Hub", name: "DistinctService", displayName: "Distinct service", program: "C:/Tools/distinct.exe", pid: 734, state: "running", goneAt: null, kind: "windows-service", domain: "gui", classification, ports: [], ...over });
const local: ControlMachine = { id: "hub", os: "windows", transport: { type: "local" } };
const mac: ControlMachine = { id: "mini", os: "macos", transport: { type: "ssh", target: "fixture-host" } };
const pwsh = (script: string): string[] => ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script];

for (const action of ["start", "stop", "restart"] as const) {
  test(`Windows service ${action} uses a fixed script and environment data`, () => {
    const target = row({ state: action === "start" ? "stopped" : "running", pid: action === "start" ? null : 734 });
    const plan = planControl(target, action, { machine: local });
    assert.equal(plan.allowed, true);
    assert.deepEqual(plan.argv, pwsh(`$ErrorActionPreference = 'Stop'; ${action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"}-Service -Name $env:SCOUT_NAME -ErrorAction Stop`));
    assert.deepEqual(plan.env, { SCOUT_NAME: "DistinctService", SCOUT_PID: action === "start" ? "" : "734", SCOUT_PATH: "C:/Tools/distinct.exe" });
    for (const value of Object.values(plan.env).filter(Boolean)) assert.equal(plan.argv.some((part) => part.includes(value)), false);
    assert.equal(plan.argv.length, 5);
  });
  test(`scheduled task ${action} uses validated path and name through environment variables`, () => {
    const plan = planControl(row({ kind: "scheduled-task", name: "/Vendor/DistinctTask", state: action === "start" ? "stopped" : "running" }), action, { machine: local });
    assert.equal(plan.allowed, true);
    assert.deepEqual(plan.argv, pwsh(TASK_CONTROL[action]));
    assert.deepEqual(plan.env, { SCOUT_NAME: "DistinctTask", SCOUT_TASK_PATH: String.fromCharCode(92) + "Vendor" + String.fromCharCode(92) });
    assert.equal(plan.argv.some((v) => v.includes("DistinctTask") || v.includes("Vendor")), false);
  });
  test(`gui launchd ${action} uses the stored uid and label`, () => {
    const plan = planControl(row({ machineId: "mini", kind: "launchd", name: "com.example.worker", uid: 501, program: "/opt/worker", state: action === "start" ? "stopped" : "running" }), action, { machine: mac });
    assert.equal(plan.allowed, true);
    assert.deepEqual(plan.argv, action === "stop" ? ["launchctl", "kill", "SIGTERM", "gui/501/com.example.worker"] : ["launchctl", "kickstart", ...(action === "restart" ? ["-k"] : []), "gui/501/com.example.worker"]);
    assert.deepEqual(plan.transport, mac.transport);
    assert.equal(plan.admin, "none");
  });
  test(`system launchd ${action} plans sudo without changing the private command`, () => {
    const plan = planControl(row({ machineId: "mini", kind: "launchd", domain: "system", name: "com.example.worker", program: "/opt/worker", state: action === "start" ? "stopped" : "running" }), action, { machine: mac });
    assert.equal(plan.allowed, true);
    assert.deepEqual(plan.argv, action === "stop" ? ["launchctl", "kill", "SIGTERM", "system/com.example.worker"] : ["launchctl", "kickstart", ...(action === "restart" ? ["-k"] : []), "system/com.example.worker"]);
    assert.equal(plan.admin, "sudo");
    assert.equal(plan.sudoCommand, `sudo ${plan.argv.join(" ")}`);
  });
}

test("scheduled task names may hold spaces and brackets but never wildcards or traversal", () => {
  const ok = planControl(row({ kind: "scheduled-task", name: "\\Scout Version Tracker (scout.example.test)", state: "stopped" }), "start", { machine: local });
  assert.equal(ok.allowed, true);
  assert.equal(ok.env.SCOUT_NAME, "Scout Version Tracker (scout.example.test)");
  for (const name of ["\\Vendor\\*", "\\Vendor\\Task?", "\\Vendor\\[a]", "\\Vendor\\..\\Task", "\\Vendor\\ Task", "\\Vendor\\Task\"x"]) {
    assert.equal(planControl(row({ kind: "scheduled-task", name, state: "stopped" }), "start", { machine: local }).refusalKind, "unknown", name);
  }
});

test("hard stops retain fixed Windows scripts and launchd uses SIGKILL with KeepAlive effects", () => {
  const windows = planControl(row(), "stop", { machine: local, hard: true });
  assert.deepEqual(windows.argv, pwsh(WINDOWS_CONTROL.hard));
  assert.match(windows.argv[4]!, /Stop-Service -Name \$env:SCOUT_NAME -Force/);
  assert.match(windows.argv[4]!, /ProcessId -eq \[int\]\$env:SCOUT_PID/);
  assert.equal(windows.argv.some((part) => part.includes("DistinctService") || part.includes("734")), false);
  for (const domain of ["gui", "system"] as const) {
    const plan = planControl(row({ machineId: "mini", kind: "launchd", domain, uid: 501, name: "com.example.worker", program: "/opt/worker", keepAlive: true }), "stop", { machine: mac, hard: true });
    assert.deepEqual(plan.argv, ["launchctl", "kill", "SIGKILL", `${domain === "gui" ? "gui/501" : "system"}/com.example.worker`]);
    assert.equal(plan.graceful, false);
    assert.ok(plan.effects.includes("KeepAlive will start this launchd job again."));
  }
  assert.equal(planControl(row({ kind: "scheduled-task" }), "stop", { machine: local, hard: true }).refusalKind, "unsupported");
});

for (const hard of [false, true]) {
  test(`bare process stop hard=${hard} checks the executable path`, () => {
    const windows = planControl(row({ kind: null }), "stop", { target: "listener", machine: local, hard });
    assert.deepEqual(windows.argv, pwsh(WINDOWS_PROCESS[hard ? "hard" : "stop"]));
    assert.deepEqual(windows.env, { SCOUT_PID: "734", SCOUT_PATH: "C:/Tools/distinct.exe" });
    assert.match(windows.argv[4]!, /exit 3/);
    assert.match(windows.argv[4]!, hard ? /Stop-Process.*-Force/ : /CloseMainWindow\(\)/);
    const unix = planControl(row({ machineId: "mini", kind: null, program: "/opt/worker" }), "stop", { target: "listener", machine: mac, hard });
    assert.deepEqual(unix.argv, ["zsh", "-c", MAC_PROCESS[hard ? "hard" : "stop"], "scout-control", "734", "/opt/worker"]);
    assert.match(unix.argv[2]!, /\[ "\$path" = "\$expected" \] \|\| exit 3/);
    assert.match(unix.argv[2]!, hard ? /kill -KILL/ : /kill -TERM/);
  });
}

for (const bad of ["a b", "a'b", 'a"b', "a;b", "a$(b)", "a`b", "a..b", "../a"]) {
  test(`validation refuses the invalid name ${JSON.stringify(bad)}`, () => {
    for (const kind of ["windows-service", "scheduled-task", "launchd"] as const) {
      if (bad === "a b" && kind === "scheduled-task") continue; // Task names carry spaces; the next test covers them.
      const target = row({ kind, name: bad, ...(kind === "launchd" ? { machineId: "mini", program: "/opt/worker", uid: 501 } : {}) });
      assert.equal(planControl(target, "stop", { machine: kind === "launchd" ? mac : local }).refusalKind, "unknown");
    }
  });
}

test("the planner refuses protection, unsupported actions, missing configuration, state conflicts and invalid identities", () => {
  for (const action of ["stop", "restart"] as const) assert.equal(planControl(row({ name: "cloudflared" }), action, { machine: local }).refusalKind, "protected");
  assert.equal(planControl(row({ name: "cloudflared", state: "stopped", pid: null }), "start", { machine: local }).allowed, true);
  for (const action of ["start", "restart"] as const) assert.equal(planControl(row({ kind: null }), action, { machine: local }).refusalKind, "unsupported");
  assert.equal(planControl(row(), "stop", { machine: null }).refusalKind, "unavailable");
  assert.equal(planControl(row(), "start", { machine: local }).refusalKind, "unavailable");
  assert.equal(planControl(row({ state: "stopped" }), "stop", { machine: local }).refusalKind, "unavailable");
  assert.equal(planControl(row(), "restart", { machine: local, hard: true }).refusalKind, "unknown");
  for (const pid of [0, -1, 1.5, NaN, 2_147_483_648]) assert.equal(planControl(row({ pid }), "stop", { machine: local }).refusalKind, "unknown");
  for (const program of ["relative", "C:/Tools/../worker.exe", "C:/Tools/'worker.exe", "C:/Tools/worker;run.exe", "C:/Tools/$(x).exe", "C:/Tools/`x.exe"]) assert.equal(planControl(row({ program }), "stop", { machine: local }).refusalKind, "unknown");
  assert.equal(planControl(row({ machineId: "mini", kind: "launchd", name: "com.example.worker", program: "/opt/worker" }), "stop", { machine: mac }).refusalKind, "unknown");
  assert.equal(planControl(row({ kind: null, program: null }), "stop", { machine: local }).refusalKind, "unknown");
});

test("Hub elevation wraps each fixed command and never places variable values in argv", () => {
  for (const action of ["start", "stop", "restart"] as const) {
    const plan = planControl(row({ domain: "system", state: action === "start" ? "stopped" : "running" }), action, { machine: local });
    assert.deepEqual(plan.argv, pwsh(UAC_CONTROL));
    assert.equal(plan.env.SCOUT_SCRIPT, WINDOWS_CONTROL[action]);
    assert.equal(plan.admin, "uac");
    assert.equal(plan.argv.some((s) => s.includes("DistinctService") || s.includes("734") || s.includes("C:/Tools/distinct.exe")), false);
  }
  assert.match(UAC_CONTROL, /Start-Process.*-Verb RunAs -WindowStyle Hidden -Wait/);
  assert.match(UAC_CONTROL, /Elapsed.TotalSeconds -ge 120/);
  assert.match(UAC_CONTROL, /WaitForExit\(60000\)/);
});

class Clock implements ControlClock {
  time = Date.parse("2026-10-07T00:00:00Z");
  sleeps: number[] = [];
  now(): number { return this.time; }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.time += ms; }
}
function seed(t: TestContext, over: Partial<ServiceFact> = {}): { db: Db; id: number } {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  const fact: ServiceFact = { kind: "windows-service", name: "DistinctService", displayName: "Distinct service", domain: "gui", program: "C:/Tools/distinct.exe", state: "running", startMode: "manual", enabled: true, pid: 734, runAs: null, triggers: null, lastRun: null, lastResult: null, ...over };
  const machine = fact.kind === "launchd" ? "mini" : "hub";
  recordServices(db, machine, { origin: "services", status: "ok", facts: [fact] }, "2026-10-07T00:00:00Z");
  return { db, id: listServices(db)[0]!.id };
}
function runner(db: Db, deps: Partial<ControlRunnerDeps> = {}): ControlRunner {
  return new ControlRunner(db, { machines: [local, mac], clock: new Clock(), reader: async (_m, r) => r, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), ...deps });
}
function allowed(plan: ControlPlan | null): asserts plan is ControlPlan & { id: string; token: string } {
  assert.equal(plan?.allowed, true);
  assert.equal(typeof plan!.id, "string");
  assert.equal(typeof plan!.token, "string");
}
const status = (code: number, message?: string) => (err: unknown): boolean => err instanceof ControlError && err.status === code && (message === undefined || err.message === message);

test("tokens reject wrong values, expire after two minutes and work once", async (t) => {
  const { db, id } = seed(t);
  const clock = new Clock();
  const control = runner(db, { clock, reader: async (_m, r) => ({ ...r, state: db.prepare("SELECT state FROM services WHERE id = ?").get(id)!.state as string }), exec: async () => { db.prepare("UPDATE services SET state = 'stopped' WHERE id = ?").run(id); return { exitCode: 0, stdout: "", stderr: "" }; } });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  await assert.rejects(control.run(plan.id, "wrong"), status(404));
  const result = await control.run(plan.id, plan.token);
  await control.wait(result.actionId);
  await assert.rejects(control.run(plan.id, plan.token), status(404));
  db.prepare("UPDATE services SET state = 'running' WHERE id = ?").run(id);
  const expired = await control.plan("service", id, "stop");
  allowed(expired);
  clock.time += 120_000;
  await assert.rejects(control.run(expired.id, expired.token), status(404, "unknown or expired plan"));
});

test("a changed pid or newly protected rule rejects confirmation before execution", async (t) => {
  const { db, id } = seed(t);
  let executions = 0;
  const control = runner(db, { exec: async () => { executions++; return { exitCode: 0, stdout: "", stderr: "" }; } });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  db.prepare("UPDATE services SET pid = 999 WHERE id = ?").run(id);
  await assert.rejects(control.run(plan.id, plan.token), status(409, "changed since the plan"));
  const protectedPlan = await control.plan("service", id, "stop");
  allowed(protectedPlan);
  control.setContext({ pid: 999, machineId: "hub" });
  await assert.rejects(control.run(protectedPlan.id, protectedPlan.token), status(409));
  assert.equal(executions, 0);
  assert.equal(listActions(db).length, 0);
});

test("the graceful wait re-reads every two seconds, audits the result and emits ordered events", async (t) => {
  const { db, id } = seed(t);
  const clock = new Clock();
  const reads: number[] = [];
  const calls: { transport: Transport; argv: string[]; timeout: number; env: unknown }[] = [];
  let executing = false;
  const exec: Exec = async (transport, argv, timeout, _signal, env) => { executing = true; calls.push({ transport, argv, timeout, env }); return { exitCode: 0, stdout: "", stderr: "" }; };
  const control = runner(db, { clock, exec, reader: async (_m, r) => { if (executing) reads.push(clock.time); return { ...r, state: executing && clock.sleeps.length >= 2 ? "stopped" : "running" }; } });
  const events: ActionRecord[] = [];
  control.on("action", (event) => events.push(event));
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  assert.equal("argv" in plan || "env" in plan || "transport" in plan, false);
  const result = await control.run(plan.id, plan.token);
  const audit = await control.wait(result.actionId);
  assert.deepEqual(calls, [{ transport: { type: "local" }, argv: pwsh(WINDOWS_CONTROL.stop), timeout: 60_000, env: { SCOUT_NAME: "DistinctService", SCOUT_PID: "734", SCOUT_PATH: "C:/Tools/distinct.exe" } }]);
  assert.deepEqual(clock.sleeps, [2000, 2000]);
  assert.deepEqual(reads.map((n) => n - reads[0]!), [0, 2000, 4000]);
  assert.deepEqual(events.map((e) => e.state), ["running", "done"]);
  assert.equal(audit!.message, "The service stopped after 4 s.");
  assert.ok(audit!.finishedAt);
  assert.equal(listActions(db, { machine: "hub", limit: 1 })[0]!.id, result.actionId);
  const stored = db.prepare("SELECT plan_json AS plan FROM actions WHERE id = ?").get(result.actionId)!.plan as string;
  assert.equal("token" in JSON.parse(stored), false);
  assert.equal(stored.includes(plan.token), false);
});

test("a still-running graceful stop fails with the real wait length and a plain message", async (t) => {
  const { db, id } = seed(t);
  const clock = new Clock();
  const control = runner(db, { clock });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  const result = await control.run(plan.id, plan.token);
  const audit = await control.wait(result.actionId);
  assert.equal(audit!.state, "failed");
  assert.equal(audit!.message, "The service is still running after 20 s.");
  assert.equal(clock.sleeps.reduce((sum, n) => sum + n, 0), 20_000);
});

for (const exitCode of [3, 7]) {
  test(`a command exit code ${exitCode} records a failure without trusting its output`, async (t) => {
    const { db, id } = seed(t);
    const control = runner(db, { exec: async () => ({ exitCode, stdout: "private-output", stderr: "private-output" }) });
    const plan = await control.plan("service", id, "stop");
    allowed(plan);
    const result = await control.run(plan.id, plan.token);
    const audit = await control.wait(result.actionId);
    assert.equal(audit!.state, "failed");
    assert.equal(audit!.exitCode, exitCode);
    assert.match(audit!.message!, exitCode === 3 ? /identity changed/ : /code 7/);
    assert.equal(JSON.stringify(audit).includes("private-output"), false);
  });
}

for (const confirmed of [false, true]) {
  test(`the sudo watch executes nothing and ends ${confirmed ? "confirmed" : "expired"}`, async (t) => {
    const { db, id } = seed(t, { kind: "launchd", name: "com.example.worker", domain: "system", program: "/opt/worker" });
    const clock = new Clock();
    let executions = 0;
    const control = runner(db, { clock, exec: async () => { executions++; throw new Error("A sudo watch must not execute."); }, reader: async (_m, r) => ({ ...r, state: confirmed && clock.sleeps.length >= 2 ? "stopped" : "running" }) });
    const states: string[] = [];
    control.on("action", (event) => states.push(event.state));
    const plan = await control.plan("service", id, "stop");
    allowed(plan);
    const result = await control.run(plan.id, plan.token);
    assert.equal(result.status, 200);
    assert.equal(result.state, "waiting");
    assert.equal(result.sudoCommand, "sudo launchctl kill SIGTERM system/com.example.worker");
    const audit = await control.wait(result.actionId);
    assert.equal(executions, 0);
    assert.equal(audit!.state, confirmed ? "confirmed" : "expired");
    assert.deepEqual(states, ["waiting", confirmed ? "confirmed" : "expired"]);
    assert.ok(clock.sleeps.every((n) => n === 10_000));
    assert.equal(clock.sleeps.reduce((n, v) => n + v, 0), confirmed ? 20_000 : 600_000);
  });
}

for (const exitCode of [1223]) {
  test(`UAC exit code ${exitCode} ends declined`, async (t) => {
    const { db, id } = seed(t, { domain: "system" });
    const control = runner(db, { exec: async (_t, argv, timeout) => { assert.deepEqual(argv, pwsh(UAC_CONTROL)); assert.equal(timeout, 185_000); return { exitCode, stdout: "", stderr: "" }; } });
    const plan = await control.plan("service", id, "stop");
    allowed(plan);
    const result = await control.run(plan.id, plan.token);
    assert.equal((await control.wait(result.actionId))!.state, "declined");
  });
}

test("the row guard refuses concurrent actions and releases after completion", async (t) => {
  const { db, id } = seed(t);
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const control = runner(db, { exec: async () => { await barrier; return { exitCode: 7, stdout: "", stderr: "" }; } });
  const first = await control.plan("service", id, "stop");
  const second = await control.plan("service", id, "restart");
  allowed(first); allowed(second);
  const result = await control.run(first.id, first.token);
  assert.equal(control.running(), 1);
  await assert.rejects(control.run(second.id, second.token), status(409, "an action is already running for this row"));
  release();
  await control.wait(result.actionId);
  assert.equal(control.running(), 0);
});

test("the listener and its joined service share the same action guard", async (t) => {
  const { db, id } = seed(t);
  recordListeners(db, "hub", { origin: "netconn", status: "ok", facts: [{ port: 8900, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 734, processName: "distinct", processPath: "C:/Tools/distinct.exe", container: null }] }, "2026-10-07T00:00:00Z");
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const control = runner(db, { exec: async () => { await barrier; return { exitCode: 7, stdout: "", stderr: "" }; } });
  const servicePlan = await control.plan("service", id, "stop");
  const listenerPlan = await control.plan("listener", 1, "stop");
  allowed(servicePlan); allowed(listenerPlan);
  assert.equal(listenerPlan.mechanism, "windows-service");
  const result = await control.run(servicePlan.id, servicePlan.token);
  await assert.rejects(control.run(listenerPlan.id, listenerPlan.token), status(409));
  release();
  await control.wait(result.actionId);
});

test("missing rows and reader failures never execute an action", async (t) => {
  const { db, id } = seed(t);
  const control = runner(db, { reader: async () => null, exec: async () => { throw new Error("Execution is forbidden."); } });
  assert.equal(await control.plan("service", 999, "stop"), null);
  assert.equal((await control.plan("service", id, "stop"))!.allowed, false);
  assert.equal(listActions(db).length, 0);
});

test("the control scripts use constants and fixed argument entry points", () => {
  const source = readFileSync(new URL("../src/control.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Invoke-Expression|\beval\b/);
  assert.match(source, /timingSafeEqual/);
});

test("PowerShell parses the fixed scripts and elevated child scripts without executing actions", { skip: process.platform !== "win32" }, () => {
  const scripts = [...Object.values(WINDOWS_CONTROL), ...Object.values(TASK_CONTROL), ...Object.values(WINDOWS_PROCESS), UAC_CONTROL];
  const parser = `$scripts = ConvertFrom-Json -InputObject $env:SCOUT_PARSE_DATA; $count = 0; foreach ($script in $scripts) { $parseErrors = $null; $ast = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$null, [ref]$parseErrors); if ($parseErrors.Count) { $parseErrors | ForEach-Object { $_.Message }; exit 1 }; $count++; foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.StartsWith('$ErrorActionPreference') }, $true)) { $childErrors = $null; [System.Management.Automation.Language.Parser]::ParseInput($node.Value, [ref]$null, [ref]$childErrors) | Out-Null; if ($childErrors.Count) { $childErrors | ForEach-Object { $_.Message }; exit 1 }; $count++ } }; $count`;
  const parsed = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", parser], { windowsHide: true, encoding: "utf8", timeout: 10_000, env: { ...process.env, SCOUT_PARSE_DATA: JSON.stringify(scripts) } });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  assert.equal(Number(parsed.stdout.trim()), scripts.length + 2);
});

test("route effects join owned listeners and retain configured tunnel placement", async (t) => {
  const { db, id } = seed(t);
  recordListeners(db, "hub", { origin: "netconn", status: "ok", facts: [{ port: 8900, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 734, processName: "distinct", processPath: "C:/Tools/distinct.exe", container: null }] }, "2026-10-07T00:00:00Z");
  recordCloudflare(db, { zones: [{ id: "z", name: "example.test" }], tunnels: [{ id: "t", name: "private-tunnel", status: "healthy", connections: 1, remoteManaged: true }], dns: [{ zone: "z", name: "work.example.test", type: "CNAME", content: "t.cfargotunnel.com", proxied: true }], ingress: [{ tunnelId: "t", position: 0, hostname: "work.example.test", path: null, service: "http://localhost:8900" }] }, "2026-10-07T00:00:00Z", null);
  const plan = await runner(db, { tunnelHosts: { "private-tunnel": "hub" } }).plan("service", id, "stop");
  allowed(plan);
  assert.ok(plan.effects.includes("Stops the listener on port 8900"));
  assert.ok(plan.effects.includes("The domain work.example.test is served by it"));
});

for (const action of ["start", "restart"] as const) {
  test(`the runner confirms ${action} after a successful manager command`, async (t) => {
    const { db, id } = seed(t, { state: action === "start" ? "stopped" : "running", pid: action === "start" ? null : 734 });
    let executed = false;
    const control = runner(db, { exec: async () => { executed = true; return { exitCode: 0, stdout: "", stderr: "" }; }, reader: async (_m, r) => executed ? { ...r, state: "running", pid: 900 } : r });
    const plan = await control.plan("service", id, action);
    allowed(plan);
    const result = await control.run(plan.id, plan.token);
    assert.equal((await control.wait(result.actionId))!.state, "done");
  });
}

test("a sudo restart waits for a changed process identity instead of confirming the initial running state", async (t) => {
  const { db, id } = seed(t, { kind: "launchd", name: "com.example.worker", domain: "system", program: "/opt/worker" });
  const clock = new Clock();
  const control = runner(db, { clock, reader: async (_m, r) => ({ ...r, pid: clock.sleeps.length >= 2 ? 900 : r.pid }), exec: async () => { throw new Error("Execution is forbidden."); } });
  const plan = await control.plan("service", id, "restart");
  allowed(plan);
  const result = await control.run(plan.id, plan.token);
  assert.equal((await control.wait(result.actionId))!.state, "confirmed");
  assert.deepEqual(clock.sleeps, [10_000, 10_000]);
});

test("the default reader targets one scheduled task with environment data and no slow task scan", async (t) => {
  const { db, id } = seed(t, { kind: "scheduled-task", name: "/Vendor/DistinctTask" });
  const calls: { argv: string[]; env: unknown; timeout: number }[] = [];
  const control = new ControlRunner(db, { machines: [local], clock: new Clock(), exec: async (_m, argv, timeout, _signal, env) => {
    calls.push({ argv, env, timeout });
    return { exitCode: 0, stderr: "", stdout: JSON.stringify([{ TaskName: "DistinctTask", TaskPath: "/Vendor/", State: "Running", Execute: "C:/Tools/distinct.exe", Triggers: [], RunAs: null, LastRun: null, LastResult: null }]) };
  } });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.argv.length, 5);
  assert.match(calls[0]!.argv[4]!, /Get-ScheduledTask -TaskPath \$env:SCOUT_TASK_PATH -TaskName \$env:SCOUT_NAME/);
  assert.equal(calls[0]!.argv.some((s) => s.includes("DistinctTask")), false);
  assert.equal(calls[0]!.timeout, 30_000);
  assert.deepEqual(calls[0]!.env, { SCOUT_NAME: "DistinctTask", SCOUT_TASK_PATH: String.fromCharCode(92) + "Vendor" + String.fromCharCode(92) });
});

test("the default launchd reader records a missing uid before planning a gui command", async (t) => {
  const { db, id } = seed(t, { kind: "launchd", name: "com.example.worker", domain: "gui", program: null });
  const calls: string[][] = [];
  const control = new ControlRunner(db, { machines: [mac], clock: new Clock(), exec: async (_m, argv) => {
    calls.push(argv);
    if (argv[0] === "id") return { exitCode: 0, stdout: "501\n", stderr: "" };
    const script = argv.join(" ");
    if (script.includes("SCOUT-SYSTEM")) return { exitCode: 0, stdout: "---SCOUT-SYSTEM---\n---SCOUT-GUI---\n734 0\tcom.example.worker\n---SCOUT-DISABLED-SYSTEM---\n---SCOUT-DISABLED-GUI---\n", stderr: "" };
    if (script.includes("SCOUT-PS")) return { exitCode: 0, stdout: "---SCOUT-PS---\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  assert.equal(plan.command, "launchctl kill SIGTERM gui/501/com.example.worker");
  assert.equal(listServices(db)[0]!.uid, 501);
  assert.deepEqual(calls.at(-1), ["id", "-u"]);
  assert.equal(calls.some((argv) => argv[0] === "launchctl"), false);
});

test("the default reader retries one partial pass before refusing a machine", async (t) => {
  let dropped = false;
  const flakyExec = async (_m: unknown, argv: string[]) => {
    if (argv[0] === "id") return { exitCode: 0, stdout: "501\n", stderr: "" };
    const script = argv.join(" ");
    if (script.includes("SCOUT-SYSTEM")) {
      if (!dropped) { dropped = true; return { exitCode: 255, stdout: "", stderr: "ssh: connection reset" }; }
      return { exitCode: 0, stdout: "---SCOUT-SYSTEM---\n---SCOUT-GUI---\n734 0\tcom.example.worker\n---SCOUT-DISABLED-SYSTEM---\n---SCOUT-DISABLED-GUI---\n", stderr: "" };
    }
    if (script.includes("SCOUT-PS")) return { exitCode: 0, stdout: "---SCOUT-PS---\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const flaky = seed(t, { kind: "launchd", name: "com.example.worker", domain: "gui", program: null });
  allowed(await new ControlRunner(flaky.db, { machines: [mac], clock: new Clock(), exec: flakyExec }).plan("service", flaky.id, "stop"));
  const down = seed(t, { kind: "launchd", name: "com.example.worker", domain: "gui", program: null });
  const dead = new ControlRunner(down.db, { machines: [mac], clock: new Clock(), exec: async () => ({ exitCode: 255, stdout: "", stderr: "" }) });
  assert.equal((await dead.plan("service", down.id, "stop"))!.refusalKind, "unavailable");
});

test("reader failures, prompt-command timeouts and subscriber errors keep plain audit outcomes", async (t) => {
  const { db, id } = seed(t, { domain: "system" });
  const unavailable = runner(db, { reader: async () => { throw new Error("private-output"); } });
  assert.equal((await unavailable.plan("service", id, "stop"))!.refusalKind, "unavailable");
  for (const exitCode of [124, -1]) {
    const control = runner(db, { exec: async () => ({ exitCode, stdout: "", stderr: "" }) });
    control.on("action", () => { throw new Error("A subscriber failed."); });
    const plan = await control.plan("service", id, "stop");
    allowed(plan);
    const result = await control.run(plan.id, plan.token);
    const audit = await control.wait(result.actionId);
    assert.equal(audit!.state, "failed");
    assert.match(audit!.message!, /command timed out/);
  }
});

test("a token that expires while the confirmation re-read runs cannot start an action", async (t) => {
  const { db, id } = seed(t);
  const clock = new Clock();
  let reads = 0;
  let calls = 0;
  const control = runner(db, { clock, reader: async (_m, r) => { if (++reads === 2) clock.time += 120_000; return r; }, exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  await assert.rejects(control.run(plan.id, plan.token), status(404));
  assert.equal(calls, 0);
});

test("a sudo watch retries temporary read failures and can confirm a later read", async (t) => {
  const { db, id } = seed(t, { kind: "launchd", name: "com.example.worker", domain: "system", program: "/opt/worker" });
  const clock = new Clock();
  let reads = 0;
  const control = runner(db, { clock, reader: async (_m, r) => { reads++; if (reads === 3) throw new Error("A temporary read failed."); return reads >= 4 ? { ...r, state: "stopped" } : r; } });
  const plan = await control.plan("service", id, "stop");
  allowed(plan);
  const result = await control.run(plan.id, plan.token);
  assert.equal((await control.wait(result.actionId))!.state, "confirmed");
  assert.deepEqual(clock.sleeps, [10_000]);
});

test("process identity scripts resolve catalog USER paths only for the current account", () => {
  const windows = planControl(row({ kind: null, program: "C:/Users/USER/Tools/worker.exe" }), "stop", { machine: local });
  assert.equal(windows.allowed, true);
  assert.equal(windows.env.SCOUT_PATH, "C:/Users/USER/Tools/worker.exe");
  assert.match(windows.argv[4]!, /GetFolderPath\(\[Environment\+SpecialFolder\]::UserProfile\)/);
  assert.match(windows.argv[4]!, /-ine \$expected/);
  const unix = planControl(row({ machineId: "mini", kind: null, program: "/Users/USER/Tools/worker" }), "stop", { machine: mac });
  assert.equal(unix.allowed, true);
  assert.equal(unix.argv.at(-1), "/Users/USER/Tools/worker");
  assert.match(unix.argv[2]!, /\/Users\/USER\/\*\) expected="\$HOME\//);
});

test("disable and enable plan fixed launchd and scheduled task commands and refuse everything else", () => {
  const job = (over: Partial<ControlRow> = {}): ControlRow => row({ machineId: "mini", kind: "launchd", name: "com.example.worker", uid: 501, program: "/opt/worker", state: "running", pid: 88, enabled: null, ...over });
  const gui = planControl(job(), "disable", { machine: mac });
  assert.equal(gui.allowed, true);
  assert.deepEqual(gui.argv, ["zsh", "-c", LAUNCHD_STARTUP.disable, "scout-control", "gui/501/com.example.worker", "gui/501", ""]);
  assert.equal(gui.command, "launchctl disable gui/501/com.example.worker; launchctl bootout gui/501/com.example.worker");
  assert.equal(gui.admin, "none");
  assert.ok(gui.effects.some((effect) => /stays off/.test(effect)));
  const system = planControl(job({ domain: "system", uid: null }), "disable", { machine: mac });
  assert.equal(system.admin, "sudo");
  assert.equal(system.sudoCommand, "sudo launchctl disable system/com.example.worker && sudo launchctl bootout system/com.example.worker");
  const enable = planControl(job({ state: "disabled", pid: null, enabled: false, plist: "/Users/USER/Library/LaunchAgents/com.example.worker.plist" }), "enable", { machine: mac });
  assert.equal(enable.allowed, true);
  assert.deepEqual(enable.argv, ["zsh", "-c", LAUNCHD_STARTUP.enable, "scout-control", "gui/501/com.example.worker", "gui/501", "/Users/USER/Library/LaunchAgents/com.example.worker.plist"]);
  assert.equal(enable.command, 'launchctl enable gui/501/com.example.worker; launchctl bootstrap gui/501 "/Users/USER/Library/LaunchAgents/com.example.worker.plist"');
  const unloaded = planControl(job({ state: "disabled", pid: null, enabled: false }), "enable", { machine: mac });
  assert.equal(unloaded.argv[6], "");
  assert.equal(unloaded.command, "launchctl enable gui/501/com.example.worker");
  assert.equal(planControl(job({ state: "disabled", pid: null, enabled: false, plist: "/tmp/a;b.plist" }), "enable", { machine: mac }).refusalKind, "unknown");
  assert.equal(planControl(job({ state: "disabled", pid: null, enabled: false }), "disable", { machine: mac }).refusal, "Already disabled");
  assert.equal(planControl(job({ enabled: true }), "enable", { machine: mac }).refusal, "Already enabled");

  const task = row({ kind: "scheduled-task", name: "/Vendor/DistinctTask", state: "running", enabled: true });
  const off = planControl(task, "disable", { machine: local });
  assert.deepEqual(off.argv, pwsh(TASK_CONTROL.disable));
  assert.deepEqual(off.env, { SCOUT_NAME: "DistinctTask", SCOUT_TASK_PATH: String.fromCharCode(92) + "Vendor" + String.fromCharCode(92) });
  assert.match(TASK_CONTROL.disable, /Disable-ScheduledTask[^;]*; Stop-ScheduledTask/);
  const on = planControl({ ...task, state: "disabled", enabled: false }, "enable", { machine: local });
  assert.deepEqual(on.argv, pwsh(TASK_CONTROL.enable));
  assert.equal(planControl({ ...task, enabled: null }, "disable", { machine: local }).refusal, "Enabled state unknown");

  assert.equal(planControl(row({ enabled: true }), "disable", { machine: local }).refusalKind, "unavailable");
  assert.equal(planControl(row({ kind: null, enabled: true }), "enable", { machine: local }).refusalKind, "unsupported");
  const protectedJob = job({ name: "com.apple.screensharing.helper" });
  assert.equal(planControl(protectedJob, "disable", { machine: mac }).refusalKind, "protected");
  assert.equal(planControl({ ...protectedJob, state: "disabled", pid: null, enabled: false }, "enable", { machine: mac }).allowed, true);
  assert.equal(planControl(job(), "disable", { machine: mac, hard: true }).refusalKind, "unknown");
});

test("the launchd startup scripts disable then unload and enable then load, expanding a catalog USER plist path", { skip: spawnSync("sh", ["-c", "exit 0"]).status !== 0 }, () => {
  const run = (script: string, args: string[], launchctl: string) => spawnSync("sh", ["-c", `launchctl() { echo "$@"; ${launchctl}; }\n${script}`, "scout-control", ...args], { encoding: "utf8", env: { ...process.env, HOME: "/home/real" } });
  const off = run(LAUNCHD_STARTUP.disable, ["gui/501/x", "gui/501", ""], "[ \"$1\" = bootout ] && return 3; return 0");
  assert.equal(off.status, 0);
  assert.equal(off.stdout, "disable gui/501/x\nbootout gui/501/x\n");
  const refused = run(LAUNCHD_STARTUP.disable, ["gui/501/x", "gui/501", ""], "return 5");
  assert.equal(refused.status, 5);
  assert.equal(refused.stdout, "disable gui/501/x\n");
  const on = run(LAUNCHD_STARTUP.enable, ["gui/501/x", "gui/501", "/Users/USER/Library/LaunchAgents/x.plist"], "return 0");
  assert.equal(on.stdout, "enable gui/501/x\nbootstrap gui/501 /home/real/Library/LaunchAgents/x.plist\n");
  assert.equal(run(LAUNCHD_STARTUP.enable, ["gui/501/x", "gui/501", ""], "return 0").stdout, "enable gui/501/x\n");
});

test("a disable waits for the catalog to show the job disabled and stopped, and an enable waits for it to show enabled", async (t) => {
  const { db, id } = seed(t, { kind: "launchd", name: "com.example.worker", program: "/opt/worker", pid: 88, enabled: null, uid: 501 });
  const clock = new Clock();
  let executed: string[] = [];
  let done = false;
  const exec: Exec = async (_t, argv) => { executed = argv; done = true; return { exitCode: 0, stdout: "", stderr: "" }; };
  const control = runner(db, { clock, exec, reader: async (_m, r) => done ? { ...r, state: "disabled", pid: null, enabled: clock.sleeps.length >= 1 ? false : null } : r });
  const off = await control.plan("service", id, "disable");
  allowed(off);
  const result = await control.run(off.id, off.token);
  const audit = await control.wait(result.actionId);
  assert.equal(executed[2], LAUNCHD_STARTUP.disable);
  assert.equal(audit!.action, "disable");
  assert.equal(audit!.state, "done");
  assert.equal(audit!.message, "The launchd job disabled after 2 s.");
  done = false;
  db.prepare("UPDATE services SET enabled = 0, state = 'disabled', pid = NULL").run();
  const none = runner(db, { exec, reader: async (_m, r) => done ? { ...r, state: "stopped", pid: null, enabled: true } : { ...r, state: "disabled", pid: null, enabled: false } });
  const on = await none.plan("service", id, "enable");
  allowed(on);
  const enabled = await none.wait((await none.run(on.id, on.token)).actionId);
  assert.equal(enabled!.state, "done");
  assert.match(enabled!.message!, /^The launchd job enabled after /);
  assert.equal(executed[2], LAUNCHD_STARTUP.enable);
});
