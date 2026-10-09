import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlRow, isProtected, joinedInstall, listListeners, listServices, openCatalog, protectedFileReader, protectedResponse, recordListeners, recordServices, rowControl, SCHEMA_VERSION, uninstallInstructions, upsertMachine, type ControlRow, type ServiceFact } from "../src/index.ts";

const classification = { class: "third-party" as const, vendor: "other" as const, official: false, hidden: false, evidence: [], whatBreaks: null, confidence: "default" as const };
const row = (over: Partial<ControlRow> = {}): ControlRow => ({ id: 1, machineId: "hub", machineName: "Hub", name: "ExampleService", displayName: null, program: "C:/Tools/example.exe", pid: 321, state: "running", goneAt: null, kind: "windows-service", domain: "system", classification, ports: [], ...over });

for (const [name, group] of [["cloudflared", "cloudflared"], ["sshd", "ssh"], ["Cogitator", "cogitator"], ["ARDAgent", "remote-access"], ["com.apple.screensharing.helper", "remote-access"], ["RemoteManagement", "remote-access"], ["TermService", "remote-access"], ["Remote Desktop Services", "remote-access"], ["TAILSCALED", "remote-access"], ["warp-svc", "dns-network"], ["Cloudflare WARP", "dns-network"], ["NordVPNService", "dns-network"], ["AdGuardHelper", "dns-network"], ["colima", "containers"], ["limactl", "containers"], ["com.docker.backend", "containers"], ["Docker Desktop Service", "containers"]]) {
  test(`protection recognizes ${name}`, () => {
    assert.equal(isProtected(row({ name: name! }), { windows: true }).group, group);
    assert.equal(isProtected(row({ name: "unrelated", program: `C:/Tools/${name}.exe` }), { windows: true }).group, group);
  });
}

test("protection covers essential rows and the hub pid, parent and listening port on its machine", () => {
  assert.equal(isProtected(row({ classification: { ...classification, class: "essential" } })).group, "essential");
  const context = { machineId: "hub", pid: 321, parentPid: 322, port: 4870 };
  assert.equal(isProtected(row(), context).group, "scout");
  assert.equal(isProtected(row({ pid: 322 }), context).group, "scout");
  assert.equal(isProtected(row({ pid: 500, ports: [{ port: 4870 }] }), context).group, "scout");
  assert.equal(isProtected(row({ pid: 500, ports: [], ...{ port: 4870 } }), context).group, "scout");
  assert.equal(isProtected(row({ machineId: "mini" }), context).protected, false);
});

test("switchable groups can be disabled while every always-on group remains protected", () => {
  const config = { disable: ["essential", "scout", "cloudflared", "ssh", "cogitator", "remote-access", "dns-network", "containers"], names: [] };
  for (const name of ["tailscale", "warp-svc", "docker"]) assert.equal(isProtected(row({ name }), { config }).protected, false);
  for (const name of ["cloudflared", "sshd", "cogitator"]) assert.equal(isProtected(row({ name }), { config }).protected, true);
  assert.equal(isProtected(row({ classification: { ...classification, class: "essential" } }), { config }).protected, true);
  assert.equal(isProtected(row(), { config, pid: 321 }).protected, true);
});

test("custom machine and name or path globs respect Windows case and macOS case", () => {
  const config = { disable: [], names: [{ machine: "hu?", match: "C:/TOOLS/*.EXE", reason: "The program holds a local workload." }] };
  assert.equal(isProtected(row(), { windows: true, config }).group, "custom");
  assert.equal(isProtected(row({ machineId: "mini" }), { windows: true, config }).protected, false);
  assert.equal(isProtected(row(), { windows: false, config }).protected, false);
  assert.equal(isProtected(row(), { config: { disable: [], names: [{ machine: "*", match: "Example*", reason: "A private service depends on it." }] } }).reason, "A private service depends on it.");
});

test("the protected file reader reports missing and malformed files, reloads by mtime and retains always-on groups", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-protected-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "protected.json");
  const read = protectedFileReader(path);
  assert.ok(read().fileError);
  writeFileSync(path, JSON.stringify({ disable: ["containers", "ssh"], names: [{ machine: "*", match: "Example*", reason: "The workload needs it." }] }));
  const loaded = read();
  assert.equal(loaded.fileError, null);
  assert.equal(read(), loaded);
  const response = protectedResponse(loaded) as { groups: { id: string; enabled: boolean }[]; custom: unknown[]; fileError: string | null };
  assert.equal(response.groups.find((g) => g.id === "ssh")!.enabled, true);
  assert.equal(response.groups.find((g) => g.id === "containers")!.enabled, false);
  assert.equal(response.custom.length, 1);
  writeFileSync(path, "[]");
  utimesSync(path, new Date(1000), new Date(1000));
  assert.ok(read().fileError);
  assert.equal(isProtected(row({ name: "docker" }), { config: read().config }).protected, true);
  const malformed = read();
  assert.equal(read(), malformed);
  for (const data of ["null", "{", JSON.stringify({ disable: [], names: [{ machine: "*", match: "*", reason: 7 }] })]) { writeFileSync(path, data); assert.ok(read().fileError); }
  writeFileSync(path, JSON.stringify({ disable: ["containers"] }));
  assert.equal(read().fileError, null);
  assert.deepEqual(read().config.names, []);
});

test("row control lists three actions and blocks protected stops, bare starts and off-state actions", () => {
  assert.deepEqual(rowControl(row()).actions.map((a) => a.action), ["start", "stop", "restart"]);
  assert.equal(rowControl(row()).actions[0]!.reason, "Already running");
  assert.equal(rowControl(row({ state: "stopped", pid: null })).actions[1]!.reason, "Not running");
  const protectedControl = rowControl(row({ name: "cloudflared", state: "stopped" }));
  assert.equal(protectedControl.actions[0]!.available, true);
  assert.equal(protectedControl.actions[1]!.available, false);
  assert.equal(rowControl(row({ kind: null })).actions[0]!.reason, "A bare process has no start command");
  assert.equal(rowControl(row({ kind: null, pid: null })).mechanism, null);
  assert.ok(rowControl(row(), {}, false).actions.every((a) => !a.available && a.reason === "Control is off."));
  assert.equal(rowControl(row({ kind: "launchd", domain: "system" })).needsAdmin, true);
  assert.equal(rowControl(row({ kind: "launchd", domain: "gui", uid: 501 })).needsAdmin, false);
  assert.equal(rowControl(row({ kind: "launchd", domain: "gui", program: "/opt/worker" })).actions[1]!.available, true);
});

test("service facts retain uid, KeepAlive and plist through cheap reads and listeners join their manager", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  const fact: ServiceFact = { kind: "launchd", name: "com.example.worker", displayName: null, domain: "gui", program: "/opt/worker", state: "running", startMode: null, enabled: true, pid: 40, runAs: null, triggers: null, lastRun: null, lastResult: null, uid: 501, keepAlive: true, plist: "/Library/LaunchAgents/com.example.worker.plist" };
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [fact] }, "2026-10-07T00:00:00Z");
  const { uid, keepAlive, plist, ...cheap } = fact;
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [cheap] }, "2026-10-07T00:01:00Z");
  const services = listServices(db);
  assert.equal(services[0]!.uid, 501);
  assert.equal(services[0]!.keepAlive, true);
  assert.equal(services[0]!.plist, fact.plist);
  recordListeners(db, "mini", { origin: "lsof", status: "ok", facts: [{ port: 8800, protocol: "tcp", bind: "loopback", address: "127.0.0.1", pid: 40, processName: "worker", processPath: "/opt/worker", container: null }] }, "2026-10-07T00:00:00Z");
  const joined = controlRow(listListeners(db)[0]!, services);
  assert.equal(joined.kind, "launchd");
  assert.equal(joined.serviceId, services[0]!.id);
  assert.equal(SCHEMA_VERSION, 3);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'actions'").get());
});

for (const [ecosystem, command] of [["winget", "winget uninstall --id Demo.App"], ["msstore", "winget uninstall --id Demo.App --source msstore"], ["brew", "brew uninstall Demo.App"], ["cask", "brew uninstall --cask Demo.App"], ["npm", "npm uninstall -g Demo.App"], ["pipx", "pipx uninstall Demo.App"], ["uv-tool", "uv tool uninstall Demo.App"]]) {
  test(`uninstall instructions name ${ecosystem} without executing anything`, () => {
    const instructions = uninstallInstructions(row(), { ecosystem: ecosystem!, key: "Demo.App", location: "C:/Tools" });
    assert.equal(instructions.command, command);
    assert.equal(instructions.note, "Scout never runs an uninstall.");
    assert.ok(instructions.steps.length);
    if (ecosystem === "cask") assert.ok(instructions.leftovers.some((s) => s.includes("--zap")));
  });
}

test("uninstall instructions cover plists, service deletion, invalid ids and fallback", () => {
  const launchd = uninstallInstructions(row({ kind: "launchd", name: "com.example.worker", program: "/opt/worker", plist: "/Library/LaunchAgents/com.example.worker.plist" }));
  assert.equal(launchd.command, null);
  assert.ok(launchd.steps.some((s) => s.includes("remove the launchd plist")));
  assert.ok(launchd.leftovers[0]!.includes("Application Support"));
  const windows = uninstallInstructions(row());
  assert.equal(windows.command, "sc.exe delete ExampleService");
  assert.ok(windows.leftovers[0]!.includes("can break its installer"));
  const bare = row({ kind: null });
  assert.deepEqual(uninstallInstructions(bare).steps, []);
  assert.equal(uninstallInstructions(bare).available, false);
  assert.equal(uninstallInstructions(bare, { ecosystem: "npm", key: "bad;key", location: "C:/Tools" }).command, null);
  assert.ok(uninstallInstructions(bare, { ecosystem: "unknown", key: "Demo", location: "C:/Tools" }).steps.length);
});

test("uninstall joins the deepest install location and its module cannot reach execution", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  db.exec("INSERT INTO sources (id, machine_id, kind) VALUES (1, 'hub', 'winget'); INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'winget', 'Demo.App', 'Demo'); INSERT INTO installs (machine_id, source_id, package_id, location, kind, first_seen, last_seen) VALUES ('hub', 1, 1, 'C:/Tools', 'app', 't', 't'), ('hub', 1, 1, 'C:/Tools/Specific', 'app', 't', 't')");
  assert.equal(joinedInstall(db, row({ program: "c:/tools/specific/demo.exe" }))!.location, "C:/Tools/Specific");
  assert.equal(joinedInstall(db, row({ program: "C:/Unrelated/demo.exe" })), null);
  const source = readFileSync(new URL("../src/uninstall.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:Exec|runArgv|runProbe|spawn|exec|Transport)\b|node:child_process/);
  assert.doesNotMatch(source, /import\s+[^;]+(?:transport|ops)/);
});

test("launchd rows join program, KeepAlive and plist facts from the recorded install", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  db.exec("INSERT INTO sources (id, machine_id, kind) VALUES (1, 'mini', 'launchd'); INSERT INTO packages (id, ecosystem, key, name) VALUES (1, 'launchd', 'com.example.worker', 'Worker'); INSERT INTO installs (machine_id, source_id, package_id, location, kind, first_seen, last_seen, details_json) VALUES ('mini', 1, 1, '/Library/LaunchAgents/com.example.worker.plist', 'service', 't', 't', '{\"domain\":\"agent\",\"program\":\"/opt/worker\",\"keepAlive\":true}')");
  recordServices(db, "mini", { origin: "launchd-state", status: "ok", facts: [{ kind: "launchd", name: "com.example.worker", displayName: null, domain: "gui", program: null, state: "running", startMode: null, enabled: true, pid: 40, runAs: null, triggers: null, lastRun: null, lastResult: null }] }, "2026-10-07T00:00:00Z");
  const service = listServices(db)[0]!;
  assert.equal(service.program, "/opt/worker");
  assert.equal(service.keepAlive, true);
  assert.equal(service.plist, "/Library/LaunchAgents/com.example.worker.plist");
  const install = joinedInstall(db, controlRow(service));
  assert.equal(install!.ecosystem, "launchd");
  const instructions = uninstallInstructions(controlRow(service), install);
  assert.ok(instructions.steps.some((s) => s.includes("remove the launchd plist")));
});
