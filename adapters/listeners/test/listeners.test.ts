import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ListenerAdapter, ListenerResult, ProbeOutputs } from "@scout/core";
import { dockerPortsAdapter, linuxListenersAdapter, macListenersAdapter, windowsListenersAdapter } from "../src/index.ts";
import { DOCKER_PORTS_SCRIPT, LINUX_LISTENERS_SCRIPT, MAC_LISTENERS_SCRIPT, WINDOWS_LISTENERS_SCRIPT } from "../src/probes.ts";

const fixture = (name: string): ProbeOutputs => JSON.parse(readFileSync(new URL(`../../../fixtures/listeners/${name}/outputs.json`, import.meta.url), "utf8"));
const output = (stdout: string, exitCode = 0) => ({ stdout, exitCode, stderr: "" });

for (const [adapter, names] of [
  [windowsListenersAdapter, ["hub", "hub-owners"]],
  [macListenersAdapter, ["laptop", "server", "mini", "mini-netstat"]],
  [linuxListenersAdapter, ["arch-root", "arch-user"]],
  [dockerPortsAdapter, ["docker-laptop", "docker-server", "docker-mini"]],
] as [ListenerAdapter, string[]][]) {
  for (const name of names) {
    test(`${adapter.origin} reads the exact ${name} fixture result`, () => {
      const expected = JSON.parse(readFileSync(new URL(`../../../fixtures/listeners/${name}/expected.json`, import.meta.url), "utf8")) as ListenerResult;
      assert.deepEqual(adapter.parse(fixture(name)), expected);
    });
  }
}

test("listener adapters use the exact recorded probe commands and fixed argument arrays", () => {
  for (const [adapter, file, script, argv] of [
    [windowsListenersAdapter, "windows/listeners.ps1", WINDOWS_LISTENERS_SCRIPT, ["pwsh", "-NoProfile", "-Command"]],
    [macListenersAdapter, "macos/listeners.sh", MAC_LISTENERS_SCRIPT, ["/bin/sh", "-c"]],
    [linuxListenersAdapter, "linux/listeners.sh", LINUX_LISTENERS_SCRIPT, ["/bin/sh", "-c"]],
    [dockerPortsAdapter, "macos/docker-ports.sh", DOCKER_PORTS_SCRIPT, ["/bin/sh", "-c"]],
  ] as [ListenerAdapter, string, string, string[]][]) {
    assert.equal(script, readFileSync(new URL(`../../../tools/probes/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n"));
    const probes = adapter.probes({ machineId: "test", os: adapter.os[0]!, roots: {} });
    assert.deepEqual(probes[0]!.argv, [...argv, script]);
    assert.deepEqual(probes, adapter.probes({ machineId: "other", os: adapter.os[0]!, roots: { unexpected: ["/untrusted"] } }));
  }
  assert.equal(dockerPortsAdapter.probes({ machineId: "test", os: "macos", roots: {} })[0]!.optional, true);
});

for (const [adapter, id, name] of [[windowsListenersAdapter, "listeners", "hub"], [macListenersAdapter, "listeners", "laptop"], [linuxListenersAdapter, "listeners", "arch-root"], [dockerPortsAdapter, "ports", "docker-server"]] as const) {
  test(`${adapter.origin} handles missing tools, missing outputs and non-zero exits`, () => {
    assert.equal(adapter.parse({}).status, adapter === dockerPortsAdapter ? "skipped" : "failed");
    for (const exitCode of [127, 9009]) assert.equal(adapter.parse({ [id]: output("", exitCode) }).status, "skipped");
    assert.equal(adapter.parse({ [id]: output("", 1) }).status, adapter === dockerPortsAdapter ? "skipped" : "failed");
    const outputs = fixture(name);
    outputs[id]!.exitCode = 1;
    const parsed = adapter.parse(outputs);
    assert.equal(parsed.status, "partial");
    assert.ok(parsed.facts.length > 0);
    assert.ok(parsed.message);
  });
}

test("Windows accepts empty arrays, no rows, a single object and protected processes", () => {
  for (const stdout of ["[]", ""]) assert.deepEqual(windowsListenersAdapter.parse({ listeners: output(stdout) }), { origin: "netconn", status: "ok", facts: [] });
  const row = JSON.parse(fixture("hub")["listeners"]!.stdout)[0];
  row.name = null;
  row.path = null;
  const parsed = windowsListenersAdapter.parse({ listeners: output(JSON.stringify(row)) });
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0]!.processName, null);
  assert.equal(parsed.facts[0]!.processPath, null);
});

test("Windows rejects malformed documents and retains valid rows in partial documents", () => {
  for (const stdout of ["{", "null", "42", '"text"', "{}", "[null]"]) {
    const parsed = windowsListenersAdapter.parse({ listeners: output(stdout) });
    assert.equal(parsed.status, "failed");
    assert.ok(parsed.message);
  }
  const row = JSON.parse(fixture("hub")["listeners"]!.stdout)[0];
  for (const invalid of [null, { ...row, port: 65536 }, { ...row, pid: -1 }, { ...row, address: "unknown" }, { ...row, path: 123 }, { ...row, name: {} }]) {
    const parsed = windowsListenersAdapter.parse({ listeners: output(JSON.stringify([invalid, row])) });
    assert.equal(parsed.status, "partial");
    assert.equal(parsed.facts.length, 1);
  }
});

test("Windows classifies loopback, all-interface and LAN addresses and collapses duplicate link-local zones", () => {
  const row = JSON.parse(fixture("hub")["listeners"]!.stdout)[0];
  const addresses = ["127.0.2.3", "::1", "localhost", "*", "0.0.0.0", "::", "192.168.1.100", "fe80::1%en0", "fe80::1%en1", "::ffff:127.0.0.1"];
  const parsed = windowsListenersAdapter.parse({ listeners: output(JSON.stringify(addresses.map((address) => ({ ...row, address })))) });
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.facts.map((fact) => fact.bind), ["loopback", "loopback", "loopback", "all", "all", "all", "lan", "lan", "loopback"]);
  assert.equal(parsed.facts.filter((fact) => fact.address === "fe80::1").length, 1);
});

test("macOS uses the ps executable basename when the c field is truncated", () => {
  const outputs = fixture("server");
  outputs["listeners"]!.stdout = outputs["listeners"]!.stdout.replace("cGoogle Drive", "cGoogle");
  const parsed = macListenersAdapter.parse(outputs);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.facts.find((fact) => fact.port === 7679)!.processName, "Google Drive");
  assert.equal(parsed.facts.find((fact) => fact.port === 7679)!.address, "::1");
});

test("macOS decodes escaped c fields when the pid has no absolute executable path", () => {
  for (const escaped of ["LM\\x20Studio", "LM\\040Studio", "LM\\ Studio"]) {
    const outputs = fixture("server");
    outputs["listeners"]!.stdout = outputs["listeners"]!.stdout.replace("cLM Studio", `c${escaped}`).replace(/^\s*2961 \/Applications\/LM Studio.*\n/m, "");
    const parsed = macListenersAdapter.parse(outputs);
    assert.equal(parsed.status, "ok");
    const facts = parsed.facts.filter((fact) => fact.pid === 2961);
    assert.equal(facts.length, 2);
    assert.ok(facts.every((fact) => fact.processName === "LM Studio" && fact.processPath === null));
  }
});

test("macOS drops rewritten ps titles instead of retaining process arguments", () => {
  const outputs = fixture("laptop");
  outputs["listeners"]!.stdout = outputs["listeners"]!.stdout.replace(/^\s*892 \/Applications\/Synergy.*$/m, " 892 synergy-service: worker [socket]");
  const parsed = macListenersAdapter.parse(outputs);
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.facts.filter((fact) => fact.pid === 892).every((fact) => fact.processPath === null));
  assert.ok(!JSON.stringify(parsed).includes("[socket]"));
});

test("macOS retains facts when the ps section is missing or a listener line is malformed", () => {
  const outputs = fixture("laptop");
  outputs["listeners"]!.stdout = outputs["listeners"]!.stdout.split("---SCOUT-PS---")[0]!;
  assert.equal(macListenersAdapter.parse(outputs).status, "partial");
  outputs["listeners"]!.stdout += "pbad\ncwrong\nn*:7000\n";
  const parsed = macListenersAdapter.parse(outputs);
  assert.equal(parsed.status, "partial");
  assert.equal(parsed.facts.length, 6);
  for (const stdout of ["garbage", "p1\ncnode\nn*:invalid\n---SCOUT-PS---\n", "n*:7000\n---SCOUT-PS---\n"]) assert.equal(macListenersAdapter.parse({ listeners: output(stdout) }).status, "failed");
  assert.deepEqual(macListenersAdapter.parse({ listeners: output("---SCOUT-PS---\n") }), { origin: "lsof", status: "ok", facts: [] });
});

test("macOS marks a truncated process or file group partial without discarding earlier facts", () => {
  for (const suffix of ["p999\n", "p999\ncnode\nf4\n", "p999\ncnode\nf4\nf5\nn*:8080\n"]) {
    const outputs = fixture("laptop");
    outputs["listeners"]!.stdout = outputs["listeners"]!.stdout.replace("---SCOUT-PS---", `${suffix}---SCOUT-PS---`);
    const parsed = macListenersAdapter.parse(outputs);
    assert.equal(parsed.status, "partial");
    assert.ok(parsed.facts.length >= 6);
  }
});

test("Docker retains distinct addresses and mapped container ports and collapses duplicates", () => {
  const outputs = fixture("docker-server");
  outputs["ports"]!.stdout += outputs["ports"]!.stdout.split("\n")[0] + "\n";
  const parsed = dockerPortsAdapter.parse(outputs);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.facts.length, 4);
  assert.deepEqual(parsed.facts.filter((fact) => fact.port === 3310).map((fact) => [fact.address, fact.container!.containerPort]), [["0.0.0.0", 3300], ["::", 3300]]);
});

test("Docker ignores unpublished and UDP ports and marks malformed mappings partial", () => {
  const line = fixture("docker-server")["ports"]!.stdout.split("\n")[0]!;
  const fields = line.split("|");
  fields[2] = "3300/tcp, 3301/udp, 0.0.0.0:3310->3300/udp";
  assert.deepEqual(dockerPortsAdapter.parse({ ports: output(fields.join("|")) }), { origin: "docker-ports", status: "ok", facts: [] });
  for (const malformed of ["bad", line.replace("3310->3300", "65536->3300"), line.replace("0.0.0.0", "unknown"), line.replace("3310->3300", "3310->0")]) {
    const parsed = dockerPortsAdapter.parse({ ports: output(`${line}\n${malformed}\n`) });
    assert.equal(parsed.status, "partial");
    assert.ok(parsed.message);
  }
  assert.equal(dockerPortsAdapter.parse({ ports: output("bad") }).status, "failed");
});

test("runtime listeners carry the script they run and nothing else from the command line", async () => {
  const { scriptOf } = await import("../src/index.ts");
  assert.equal(scriptOf("node", String.raw`"C:\Program Files\nodejs\node.exe" --import tsx "C:\Users\aaron\repo\src\server.ts" --token s3cret`), "C:/Users/USER/repo/src/server.ts");
  assert.equal(scriptOf("node", "node --max-old-space-size 4096 -r ts-node/register app.js --port 80"), "app.js");
  assert.equal(scriptOf("python3", "/usr/bin/python3 -m http.server 8000"), "http.server");
  assert.equal(scriptOf("java", "java -Xmx1g -jar /opt/app/app.jar --secret x"), "/opt/app/app.jar");
  assert.equal(scriptOf("deno", "deno run -A main.ts"), "main.ts");
  assert.equal(scriptOf("nginx", "nginx -g daemon off"), null);
  assert.equal(scriptOf("node", null), null);
  assert.equal(scriptOf("node", "node"), null);

  const row = { address: "127.0.0.1", port: 3310, pid: 7, name: "node", path: "C:/nodejs/node.exe", cmd: String.raw`"C:\nodejs\node.exe" C:\Repositories\ark-overseer\dist\index.js --key abc` };
  const win = windowsListenersAdapter.parse({ listeners: output(JSON.stringify([row, { ...row, port: 22, name: "sshd", cmd: null }])) });
  assert.equal(win.status, "ok");
  assert.equal(win.facts[0]!.scriptPath, "C:/Repositories/ark-overseer/dist/index.js");
  assert.equal("scriptPath" in win.facts[1]!, false);

  const wrapped = { address: "::", port: 3310, pid: 26536, name: "node", path: String.raw`C:\ProgramData\ARK Overseer\runtime\node\node.exe`, cmd: String.raw`"C:\ProgramData\ARK Overseer\runtime\node\node.exe" "C:\ProgramData\ARK Overseer\app\src\main.js"`, cwd: null };
  const service = windowsListenersAdapter.parse({ listeners: output(JSON.stringify([wrapped])) });
  assert.equal(service.status, "ok");
  assert.equal(service.facts[0]!.scriptPath, "C:/ProgramData/ARK Overseer/app/src/main.js");

  const mac = macListenersAdapter.parse({ listeners: output("p42\ncnode\nn127.0.0.1:8787\n---SCOUT-PS---\n42 /opt/homebrew/bin/node\n---SCOUT-ARGS---\n42 /opt/homebrew/bin/node /Users/me/proj/dist/worker.js --secret x\n") });
  assert.equal(mac.status, "ok");
  assert.equal(mac.facts[0]!.scriptPath, "/Users/USER/proj/dist/worker.js");
});

test("lsof reads the parent of each listening process from the ppid section", () => {
  const stdout = ["p17215", "cpython", "f4", "n127.0.0.1:8010", "---SCOUT-PS---", "17215 /opt/venv/bin/python", "---SCOUT-ARGS---", "17215 /opt/venv/bin/python /srv/serve.py", "---SCOUT-PPID---", "17215 17214", "17214 1", ""].join("\n");
  const parsed = macListenersAdapter.parse({ listeners: output(stdout) });
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.facts.map((fact) => [fact.port, fact.pid, fact.ppid]), [[8010, 17215, 17214]]);
});

test("Linux names a socket by its service when ss cannot show the process, and picks the master that shares a socket with its workers", () => {
  const root = linuxListenersAdapter.parse(fixture("arch-root"));
  const nginx = root.facts.find((fact) => fact.port === 80)!;
  assert.equal(nginx.processName, "nginx");
  assert.equal(nginx.pid, 350);
  const user = linuxListenersAdapter.parse(fixture("arch-user"));
  const sshd = user.facts.find((fact) => fact.port === 22)!;
  assert.equal(sshd.pid, null);
  assert.equal(sshd.processName, null);
  assert.equal(sshd.owner, "sshd");
  assert.ok(user.facts.every((fact) => fact.owner || fact.processName));
  const stdout = [
    'LISTEN 0 128 [::1]:631 [::]:* users:(("cupsd",pid=900,fd=6)) uid:0 ino:1 sk:1 cgroup:/system.slice/cups.service <->',
    'LISTEN 0 4096 *:8443 *:* users:(("we\\"ird",pid=901,fd=3)) uid:1000 ino:2 sk:2 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/dev.service <->',
    "---SCOUT-PS---",
    "  900 1 cupsd",
    '  901 1 we"ird',
    "---SCOUT-ARGS---",
    "",
  ].join("\n");
  const parsed = linuxListenersAdapter.parse({ listeners: output(stdout) });
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.facts.map((fact) => [fact.port, fact.bind, fact.processName, fact.owner ?? null]), [[631, "loopback", "cupsd", "cups"], [8443, "all", 'we"ird', "dev"]]);
  for (const bad of ["garbage", "LISTEN 0 4096 nonsense:abc x"]) assert.equal(linuxListenersAdapter.parse({ listeners: output(bad) }).status, "failed");
});
