import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ProbeOutputs, ServiceAdapter, ServiceResult } from "@scout/core";
import { linuxSystemdAdapter, macLaunchdStateAdapter, windowsServicesAdapter, windowsTasksAdapter } from "../src/index.ts";
import { LINUX_SYSTEMD_SCRIPT, MAC_LAUNCHD_STATE_SCRIPT, WINDOWS_SERVICE_STATE_SCRIPT, WINDOWS_TASKS_SCRIPT } from "../src/probes.ts";

const fixture = (name: string): ProbeOutputs => JSON.parse(readFileSync(new URL(`../../../fixtures/servicestate/${name}/outputs.json`, import.meta.url), "utf8"));
const output = (stdout: string, exitCode = 0) => ({ stdout, exitCode, stderr: "" });
const serviceRow = (over: Record<string, unknown> = {}) => ({ Name: "Sample", DisplayName: "Sample", PathName: "C:\\Windows\\System32\\svc.exe", State: "Stopped", StartMode: "Manual", ProcessId: 0, StartName: "LocalSystem", ...over });
const taskRow = (over: Record<string, unknown> = {}) => ({ TaskName: "Sample", TaskPath: "\\", State: "Ready", Execute: null, Triggers: [], RunAs: null, LastRun: null, LastResult: null, ...over });

for (const [adapter, name, id] of [
  [windowsServicesAdapter, "hub-services", "services"],
  [windowsTasksAdapter, "hub-tasks", "tasks"],
  [macLaunchdStateAdapter, "laptop", "state"],
  [linuxSystemdAdapter, "arch", "state"],
] as [ServiceAdapter, string, string][]) {
  test(`${adapter.origin} reads the exact ${name} fixture result`, () => {
    const expected = JSON.parse(readFileSync(new URL(`../../../fixtures/servicestate/${name}/expected.json`, import.meta.url), "utf8")) as ServiceResult;
    assert.deepEqual(adapter.parse(fixture(name)), expected);
    assert.ok(expected.facts.length > 0);
    assert.equal(Object.keys(fixture(name)).includes(id), true);
  });
}

test("service adapters use the exact recorded probe commands and fixed argument arrays", () => {
  for (const [adapter, file, script, argv] of [
    [windowsServicesAdapter, "windows/service-state.ps1", WINDOWS_SERVICE_STATE_SCRIPT, ["pwsh", "-NoProfile", "-Command"]],
    [windowsTasksAdapter, "windows/tasks.ps1", WINDOWS_TASKS_SCRIPT, ["pwsh", "-NoProfile", "-Command"]],
    [macLaunchdStateAdapter, "macos/launchd-state.sh", MAC_LAUNCHD_STATE_SCRIPT, ["/bin/sh", "-c"]],
    [linuxSystemdAdapter, "linux/systemd.sh", LINUX_SYSTEMD_SCRIPT, ["/bin/sh", "-c"]],
  ] as [ServiceAdapter, string, string, string[]][]) {
    assert.equal(script, readFileSync(new URL(`../../../tools/probes/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n"));
    const probes = adapter.probes({ machineId: "test", os: adapter.os[0]!, roots: {} });
    assert.deepEqual(probes[0]!.argv, [...argv, script]);
    assert.deepEqual(probes, adapter.probes({ machineId: "other", os: adapter.os[0]!, roots: { unexpected: ["/untrusted"] } }));
  }
});

for (const [adapter, id, name] of [[windowsServicesAdapter, "services", "hub-services"], [windowsTasksAdapter, "tasks", "hub-tasks"], [macLaunchdStateAdapter, "state", "laptop"]] as const) {
  test(`${adapter.origin} handles missing tools, missing outputs and non-zero exits`, () => {
    assert.equal(adapter.parse({}).status, "failed");
    for (const exitCode of [127, 9009]) assert.equal(adapter.parse({ [id]: output("", exitCode) }).status, "skipped");
    assert.equal(adapter.parse({ [id]: output("", 1) }).status, "failed");
    const outputs = fixture(name);
    outputs[id]!.exitCode = 1;
    const parsed = adapter.parse(outputs);
    assert.equal(parsed.status, "partial");
    assert.ok(parsed.facts.length > 0);
    assert.ok(parsed.message);
  });
}

test("Windows service paths keep the executable and drop arguments", () => {
  const parsed = windowsServicesAdapter.parse(fixture("hub-services"));
  assert.equal(parsed.status, "ok");
  const byName = (name: string) => parsed.facts.find((fact) => fact.name === name)!;
  assert.equal(byName("Appinfo").program, "C:/WINDOWS/system32/svchost.exe");
  assert.equal(byName("edgeupdate").program, "C:/Program Files (x86)/Microsoft/EdgeUpdate/MicrosoftEdgeUpdate.exe");
  assert.equal(byName("LSM").program, null);
  assert.equal(byName("LSM").startMode, null);
  assert.equal(byName("LSM").enabled, null);
  assert.equal(byName("LSM").state, "running");
  assert.equal(byName("LSM").runAs, null);
  assert.notEqual(byName("LSM").pid, null);
  assert.equal(byName("AppVClient").state, "disabled");
  assert.equal(byName("AppVClient").enabled, false);
  assert.equal(byName("AppVClient").pid, null);
  assert.ok(byName("UpcElevationService").program!.includes("Program Files (x86)"));
  assert.ok(byName("UpcElevationService").program!.endsWith("UpcElevationService.exe"));
  assert.ok(byName("GalaxyCommunication").program!.includes("GOG.com"));
  assert.ok(byName("GalaxyCommunication").program!.endsWith("GalaxyCommunication.exe"));
  assert.ok(byName("com.docker.service").program!.includes(" "));
  assert.equal(byName("com.docker.service").program!.includes("\""), false);
  assert.equal(byName("ALG").runAs, "NT AUTHORITY\\LocalService");
  assert.ok(parsed.facts.every((fact) => fact.program === null || !/ -k | \/svc\b/.test(fact.program)));
  assert.equal(JSON.stringify(parsed).includes(" -k "), false);
});

test("Windows accepts one object, empty output and mapped start modes", () => {
  for (const stdout of ["[]", ""]) assert.deepEqual(windowsServicesAdapter.parse({ services: output(stdout) }), { origin: "win-services", status: "ok", facts: [] });
  const single = windowsServicesAdapter.parse({ services: output(JSON.stringify(serviceRow({ State: "Running", StartMode: "Boot", ProcessId: 4 }))) });
  assert.equal(single.status, "ok");
  assert.equal(single.facts[0]!.startMode, "boot");
  assert.equal(single.facts[0]!.state, "running");
  assert.equal(single.facts[0]!.enabled, true);
  const disabledRunning = windowsServicesAdapter.parse({ services: output(JSON.stringify(serviceRow({ State: "Running", StartMode: "Disabled", ProcessId: 4 }))) });
  assert.equal(disabledRunning.facts[0]!.state, "running");
  assert.equal(disabledRunning.facts[0]!.enabled, false);
  const system = windowsServicesAdapter.parse({ services: output(JSON.stringify(serviceRow({ StartMode: "System" }))) });
  assert.equal(system.facts[0]!.startMode, null);
  assert.equal(system.facts[0]!.enabled, null);
  const quoted = windowsServicesAdapter.parse({ services: output(JSON.stringify(serviceRow({ PathName: "\"C:\\Users\\someone\\App\\tool.exe\" --flag" }))) });
  assert.equal(quoted.facts[0]!.program, "C:/Users/USER/App/tool.exe");
  const open = windowsServicesAdapter.parse({ services: output(JSON.stringify(serviceRow({ PathName: "\"C:\\Program Files\\tool.exe --flag" }))) });
  assert.equal(open.facts[0]!.program, "C:/Program Files/tool.exe --flag");
  const firstToken = windowsServicesAdapter.parse({ services: output(JSON.stringify(serviceRow({ PathName: "C:\\Program Files\\tool --flag" }))) });
  assert.equal(firstToken.facts[0]!.program, "C:/Program");
});

test("Windows rejects malformed service documents and retains valid rows", () => {
  for (const stdout of ["{", "null", "42", "\"text\"", "{}"]) {
    const parsed = windowsServicesAdapter.parse({ services: output(stdout) });
    assert.equal(parsed.status, "failed");
    assert.ok(parsed.message);
  }
  const row = serviceRow();
  for (const invalid of [null, { ...row, Name: "" }, { ...row, ProcessId: -1 }, { ...row, PathName: 5 }, { ...row, State: 1 }]) {
    const parsed = windowsServicesAdapter.parse({ services: output(JSON.stringify([invalid, row])) });
    assert.equal(parsed.status, "partial");
    assert.equal(parsed.facts.length, 1);
  }
});

test("scheduled tasks map states and keep the execute path without arguments", () => {
  const parsed = windowsTasksAdapter.parse(fixture("hub-tasks"));
  assert.equal(parsed.status, "ok");
  const byDisplay = (name: string) => parsed.facts.find((fact) => fact.displayName === name)!;
  assert.deepEqual(byDisplay("Adobe Acrobat Update Task").triggers, ["Logon", "Daily"]);
  assert.equal(byDisplay("Adobe Acrobat Update Task").runAs, null);
  assert.equal(byDisplay("Adobe Acrobat Update Task").state, "stopped");
  assert.equal(byDisplay("Adobe Acrobat Update Task").enabled, true);
  assert.ok(byDisplay("Adobe Acrobat Update Task").program!.endsWith("AdobeARM.exe"));
  assert.ok((byDisplay("Office Feature Updates").triggers?.length ?? 0) >= 3);
  assert.ok(byDisplay("Office Feature Updates").program!.includes("Program Files"));
  assert.equal(byDisplay("PolicyConverter").state, "disabled");
  assert.equal(byDisplay("PolicyConverter").lastRun, null);
  assert.deepEqual(byDisplay("PolicyConverter").triggers, [""]);
  assert.equal(byDisplay("PolicyConverter").program, "%windir%/system32/appidpolicyconverter.exe");
  assert.equal(byDisplay("SystemSoundsService").state, "running");
  assert.equal(byDisplay("SystemSoundsService").program, null);
  assert.equal(byDisplay("UpdateLibrary").lastRun, null);
  assert.equal(byDisplay("UpdateLibrary").program, "%ProgramFiles%/Windows Media Player/wmpnscfg.exe");
  assert.equal(byDisplay("Driver Easy Scheduled Scan").runAs, "USER");
  assert.equal(byDisplay("AD RMS Rights Policy Template Management (Automated)").program, null);
  assert.equal(byDisplay("AD RMS Rights Policy Template Management (Automated)").lastRun, null);
  const queued = windowsTasksAdapter.parse({ tasks: output(JSON.stringify(taskRow({ State: "Queued", Triggers: ["Time"], Execute: "C:\\Windows\\System32\\conhost.exe", RunAs: "USER" }))) });
  assert.equal(queued.facts[0]!.state, "other");
  assert.equal(queued.facts[0]!.enabled, true);
  assert.equal(queued.facts[0]!.program, "C:/Windows/System32/conhost.exe");
  assert.deepEqual(queued.facts[0]!.triggers, ["Time"]);
  const unknown = windowsTasksAdapter.parse({ tasks: output(JSON.stringify(taskRow({ State: "Unknown" }))) });
  assert.equal(unknown.facts[0]!.state, "other");
  assert.equal(unknown.facts[0]!.enabled, null);
  assert.deepEqual(unknown.facts[0]!.triggers, []);
  const spaced = windowsTasksAdapter.parse({ tasks: output(JSON.stringify(taskRow({ Execute: "C:\\Program Files\\Vendor\\tool.exe" }))) });
  assert.equal(spaced.facts[0]!.program, "C:/Program Files/Vendor/tool.exe");
});

test("scheduled tasks reject a bad trigger list and keep a valid neighbor", () => {
  for (const stdout of ["{", "null", "[]"]) {
    const parsed = windowsTasksAdapter.parse({ tasks: output(stdout) });
    assert.equal(parsed.status, stdout === "[]" ? "ok" : "failed");
  }
  const row = taskRow();
  const parsed = windowsTasksAdapter.parse({ tasks: output(JSON.stringify([taskRow({ Triggers: [1] }), row])) });
  assert.equal(parsed.status, "partial");
  assert.equal(parsed.facts.length, 1);
});

test("launchd keeps both domains, disabled-only rows and a running pid", () => {
  const parsed = macLaunchdStateAdapter.parse(fixture("laptop"));
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.facts.every((fact) => fact.kind === "launchd" && fact.program === null));
  assert.ok(parsed.facts.some((fact) => fact.state === "running" && fact.pid !== null));
  assert.ok(parsed.facts.some((fact) => fact.pid === null && fact.state === "stopped"));
  assert.ok(parsed.facts.some((fact) => fact.state === "disabled" && fact.enabled === false));
  assert.ok(parsed.facts.some((fact) => fact.state === "stopped" && fact.enabled === true && fact.pid === null));
  assert.ok(parsed.facts.some((fact) => fact.domain === "gui" && parsed.facts.some((other) => other.domain === "system" && other.name === fact.name)));
  const running = parsed.facts.find((fact) => fact.domain === "system" && fact.state === "running" && fact.enabled === null)!;
  const outputs = fixture("laptop");
  outputs["state"]!.stdout = outputs["state"]!.stdout.replace("---SCOUT-DISABLED-SYSTEM---\n", `---SCOUT-DISABLED-SYSTEM---\n\t"${running.name}" => disabled\n`);
  const overridden = macLaunchdStateAdapter.parse(outputs);
  const row = overridden.facts.find((fact) => fact.domain === "system" && fact.name === running.name)!;
  assert.equal(row.state, "running");
  assert.equal(row.enabled, false);
  assert.equal(row.pid, running.pid);
});

test("launchd accepts pid 0, status flags and a disabled-only label", () => {
  const stdout = [
    "---SCOUT-SYSTEM---",
    "\t\t       0      - \tcom.apple.stopped",
    "\t\t      40   (pe) \tcom.apple.running",
    "\t\t      41    (jt) \tcom.apple.throttled",
    "\t\t      42     -9 \tcom.apple.signaled",
    "---SCOUT-GUI---",
    "\t\t       0      0 \tcom.apple.stopped",
    "---SCOUT-DISABLED-SYSTEM---",
    "\tdisabled services = {",
    "\t\t\"com.apple.only\" => disabled",
    "\t\t\"com.apple.stopped\" => enabled",
    "\t}",
    "---SCOUT-DISABLED-GUI---",
    "\tdisabled services = {",
    "\t}",
    "",
  ].join("\n");
  const parsed = macLaunchdStateAdapter.parse({ state: output(stdout) });
  assert.equal(parsed.status, "ok");
  const byName = (domain: string, name: string) => parsed.facts.find((fact) => fact.domain === domain && fact.name === name)!;
  assert.equal(byName("system", "com.apple.stopped").state, "stopped");
  assert.equal(byName("system", "com.apple.stopped").enabled, true);
  assert.equal(byName("system", "com.apple.stopped").pid, null);
  assert.equal(byName("system", "com.apple.running").state, "running");
  assert.equal(byName("system", "com.apple.running").pid, 40);
  assert.equal(byName("system", "com.apple.throttled").pid, 41);
  assert.equal(byName("system", "com.apple.signaled").pid, 42);
  assert.equal(byName("gui", "com.apple.stopped").state, "stopped");
  assert.equal(byName("gui", "com.apple.stopped").enabled, null);
  assert.equal(byName("system", "com.apple.only").state, "disabled");
  assert.equal(byName("system", "com.apple.only").pid, null);
  assert.equal(macLaunchdStateAdapter.parse({ state: output("garbage") }).status, "failed");
  const partial = macLaunchdStateAdapter.parse({ state: output(`${stdout}not a row\n`) });
  assert.equal(partial.status, "partial");
  assert.ok(partial.facts.length >= 5);
});

test("systemd units map to running, failed, disabled and unit-file-only rows", () => {
  const parsed = linuxSystemdAdapter.parse(fixture("arch"));
  assert.equal(parsed.status, "ok");
  const byName = (name: string) => parsed.facts.find((fact) => fact.name === name)!;
  assert.deepEqual([byName("sshd").state, byName("sshd").startMode, byName("sshd").pid !== null, byName("sshd").program, byName("sshd").keepAlive], ["running", "auto", true, "/usr/bin/sshd", true]);
  assert.deepEqual([byName("scout-broken").state, byName("scout-broken").lastResult], ["stopped", "failed"]);
  assert.deepEqual([byName("auditd").state, byName("auditd").enabled, byName("auditd").program], ["disabled", false, null]);
  assert.equal(byName("ldconfig").state, "other");
  assert.equal(byName("ldconfig").keepAlive, false);
  assert.ok(parsed.facts.every((fact) => fact.kind === "systemd" && fact.domain === "system" && !fact.name.endsWith(".service") && !fact.name.endsWith("@")));
  assert.equal(new Set(parsed.facts.map((fact) => fact.name)).size, parsed.facts.length);
});

test("systemd reports skipped without systemctl or a running systemd, partial on a failed probe with output, and failed on a missing output", () => {
  const output = (stdout: string, exitCode: number) => ({ stdout, exitCode, stderr: "" });
  assert.equal(linuxSystemdAdapter.parse({}).status, "failed");
  assert.equal(linuxSystemdAdapter.parse({ state: output("", 127) }).status, "skipped");
  assert.equal(linuxSystemdAdapter.parse({ state: output(["---SCOUT-FILES---", "cups.service disabled disabled", ""].join("\n"), 0) }).status, "skipped");
  const outputs = fixture("arch");
  outputs["state"]!.exitCode = 1;
  const parsed = linuxSystemdAdapter.parse(outputs);
  assert.equal(parsed.status, "partial");
  assert.ok(parsed.facts.length > 0);
  const broken = linuxSystemdAdapter.parse({ state: output(["Description=no id", "LoadState=loaded", ""].join("\n"), 0) });
  assert.equal(broken.status, "failed");
});
