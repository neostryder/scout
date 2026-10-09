import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyListener, classifyService, type Listener, type ServiceFact } from "../src/index.ts";

const service = (overrides: Partial<ServiceFact> = {}): ServiceFact => ({
  kind: "windows-service", name: "Appinfo", displayName: "Application Information", domain: "system",
  program: "C:/Windows/System32/svchost.exe", state: "running", startMode: "manual", enabled: true, pid: 10,
  runAs: "LocalSystem", triggers: null, lastRun: null, lastResult: null, ...overrides,
});

const listener = (overrides: Partial<Listener> = {}): Listener => ({
  id: 1, machineId: "hub", machineName: "Hub", port: 8080, protocol: "tcp", address: "127.0.0.1", bind: "loopback",
  pid: 10, processName: "svchost", processPath: "C:/Windows/System32/svchost.exe", containerName: null, containerImage: null,
  firstSeenAt: "2026-10-06T12:00:00Z", lastSeenAt: "2026-10-06T12:00:00Z", goneAt: null,
  classification: classifyService(service()), description: null, health: null, ...overrides,
});

test("curated Windows services classify essential, optional and third-party entries", () => {
  assert.equal(classifyService(service()).class, "essential");
  assert.equal(classifyService(service({ name: "ALG" })).class, "optional");
  const thirdParty = classifyService(service({ name: "Adguard Service", program: "C:/Program Files/AdGuard/AdguardSvc.exe" }));
  assert.equal(thirdParty.class, "third-party");
  assert.equal(thirdParty.confidence, "default");
});

test("Microsoft tasks, Apple labels and generic paths use their platform rules", () => {
  const task = classifyService(service({ kind: "scheduled-task", name: "\\Microsoft\\Windows\\Update", program: null }));
  assert.equal(task.vendor, "microsoft");
  assert.equal(task.confidence, "rule");
  assert.ok(task.evidence.some((item) => item.includes("task path")));
  assert.equal(classifyService(service({ kind: "scheduled-task", name: "/Microsoft/Office/Office Feature Updates", program: null })).vendor, "microsoft");
  assert.equal(classifyService(service({ kind: "launchd", name: "com.apple.ftpd", program: null })).class, "optional");
  assert.equal(classifyService(service({ kind: "launchd", name: "com.vendor.agent", program: "/Applications/Vendor/agent" })).class, "third-party");
  assert.equal(classifyService(service({ kind: "launchd", name: "unknown", program: "/System/Library/unknown" })).hidden, true);
  const outside = classifyService(service({ kind: "launchd", name: "unknown", program: "/opt/unknown" }));
  assert.equal(outside.class, "third-party");
  assert.equal(outside.confidence, "default");
});

test("unusual paths stay visible and listener classification inherits service exposure", () => {
  const unusual = classifyService(service({ program: "C:/Users/alice/Downloads/tool.exe" }));
  assert.ok(unusual.evidence.includes("unusual location"));
  assert.equal(unusual.hidden, false);
  const joined = [service()];
  assert.equal(classifyListener(listener(), joined).hidden, true);
  assert.equal(classifyListener(listener({ bind: "all", address: "0.0.0.0" }), joined).hidden, false);
  const container = classifyListener(listener({ containerName: "web", processPath: null, pid: null }), []);
  assert.equal(container.class, "third-party");
  assert.equal(container.hidden, false);
});

test("service rules have unique matches and valid classes and explanations", () => {
  const rules = JSON.parse(readFileSync(new URL("../data/service-rules.json", import.meta.url), "utf8")) as { match: object; class: string; whatBreaks: string }[];
  const matches = rules.map((rule) => JSON.stringify(rule.match));
  assert.equal(new Set(matches).size, matches.length);
  for (const rule of rules) {
    assert.ok(["essential", "optional", "third-party"].includes(rule.class));
    assert.ok(rule.whatBreaks.trim().length > 0);
  }
});

test("a protected Windows process with no readable path is trusted by name only for the system list", () => {
  const kernel = classifyListener(listener({ pid: 4, processName: "System", processPath: null, bind: "all", address: "::" }));
  assert.equal(kernel.class, "essential");
  assert.equal(kernel.vendor, "microsoft");
  assert.equal(kernel.hidden, false);
  const loopback = classifyListener(listener({ pid: 4, processName: "System", processPath: null }));
  assert.equal(loopback.hidden, true);
  const other = classifyListener(listener({ pid: 99, processName: "node", processPath: null }));
  assert.equal(other.class, "third-party");
  assert.ok(other.evidence.includes("program path unreadable"));
});
