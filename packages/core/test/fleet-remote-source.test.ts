import { test } from "node:test";
import assert from "node:assert/strict";
import { FAILURE_CLASSES, SEVERITIES, fingerprint, parsePacket, reconcileCatalog, remoteConfig, remotePackets, type FleetRemoteConfig, type RemoteCommandResult, type RemoteObservation } from "../src/index.ts";

const T = "2026-10-31T18:00:00.000Z";
const check = { machine: "example", component: "Example app", argv: ["example", "status"] };
const success: RemoteCommandResult = { code: 0, stdout: "", stderr: "", error: null };

function packets(result: Partial<RemoteCommandResult>, settings: FleetRemoteConfig = remoteConfig({ checks: [check] })!) {
  const items = remotePackets(settings, [{ kind: "result", index: 0, result: { ...success, ...result } }], T);
  for (const item of items) {
    assert.equal(parsePacket(item).ok, true);
    assert.equal(item.host, "example");
    assert.equal(item.fingerprint, fingerprint(item.host, item.component, item.failureClass));
    assert.ok(item.summary.length <= 299);
    assert.ok((item.evidence.stderrTail?.length ?? 0) <= 1500);
    assert.ok((item.evidence.journalTail?.length ?? 0) <= 1500);
  }
  return items;
}

test("remote config supplies defaults and accepts bounded checks with explicit enablement", () => {
  assert.deepEqual(remoteConfig({}), { checks: [] });
  const config = remoteConfig({ enabled: true, checks: [check] });
  assert.deepEqual(config, { enabled: true, checks: [{ ...check, timeoutSeconds: 20, failureClass: "ran-failed", unreachable: "report" }] });
  const full = { ...check, timeoutSeconds: 120, failureClass: "dead", severity: "critical", pattern: "error|fatal", ignore: "benign", mustMatch: "running", unreachable: "ignore" };
  assert.deepEqual(remoteConfig({ enabled: false, checks: [full] }), { enabled: false, checks: [full] });
  for (const failureClass of FAILURE_CLASSES) assert.ok(remoteConfig({ checks: [{ ...check, failureClass }] }));
  for (const severity of SEVERITIES) assert.ok(remoteConfig({ checks: [{ ...check, severity }] }));
  assert.ok(remoteConfig({ checks: Array.from({ length: 60 }, (_, i) => ({ ...check, component: `Example ${i}` })) }));
  assert.ok(remoteConfig({ checks: [{ ...check, machine: `a${"_".repeat(63)}`, component: "x".repeat(180), argv: Array(20).fill("x".repeat(500)), timeoutSeconds: 1, pattern: "x".repeat(200), ignore: "", mustMatch: "" }] }));
  assert.ok(remoteConfig({ checks: [check, { ...check, machine: "alpha" }, { ...check, component: "Other" }] }));
});

test("remote config rejects unknown keys, invalid types, bounds, duplicates, and regexes", () => {
  const invalid: unknown[] = [null, [], true, "example", { unknown: true }, { enabled: null }, { enabled: "true" }, { checks: null }, { checks: {} }, { checks: "example" }, { checks: [null] }, { checks: [[]] }, { checks: [true] }, { checks: [check, check] }, { checks: Array.from({ length: 61 }, (_, i) => ({ ...check, component: `Example ${i}` })) }];
  for (const bad of [
    { unknown: 1 }, { machine: undefined }, { machine: null }, { machine: 1 }, { machine: "" }, { machine: "Alpha" }, { machine: "-alpha" }, { machine: "alpha.test" }, { machine: "a".repeat(65) }, { machine: "alpha\n" },
    { component: undefined }, { component: null }, { component: 1 }, { component: "" }, { component: " " }, { component: "x".repeat(181) }, { component: "line\nbreak" }, { component: "example\u007f" }, { component: "example\u0085" },
    { argv: undefined }, { argv: null }, { argv: "example" }, { argv: [] }, { argv: [1] }, { argv: [""] }, { argv: ["x".repeat(501)] }, { argv: ["line\nbreak"] }, { argv: ["example\u0000"] }, { argv: ["example\u007f"] }, { argv: Array(21).fill("example") },
    { timeoutSeconds: null }, { timeoutSeconds: "20" }, { timeoutSeconds: 0 }, { timeoutSeconds: 121 }, { timeoutSeconds: 1.5 }, { timeoutSeconds: NaN }, { timeoutSeconds: Infinity }, { failureClass: null }, { failureClass: "other" }, { severity: null }, { severity: "other" }, { unreachable: null }, { unreachable: true }, { unreachable: "other" },
  ]) invalid.push({ checks: [{ ...check, ...bad }] });
  for (const key of ["pattern", "ignore", "mustMatch"]) {
    for (const value of [null, true, 1, "[", "x".repeat(201)]) invalid.push({ checks: [{ ...check, [key]: value }] });
  }
  invalid.push({ checks: Array.from({ length: 60 }, (_, i) => ({ ...check, component: `Example ${i}`, argv: Array(20).fill("x".repeat(500)) })) });
  for (const value of invalid) assert.equal(remoteConfig(value), null);
});

test("unreachable checks report one shared watcher incident per machine or skip when ignored", () => {
  const config = remoteConfig({ checks: [check, { ...check, component: "Other" }, { ...check, machine: "alpha" }] })!;
  const observations: RemoteObservation[] = config.checks.map((_, index) => ({ kind: "result", index, result: { ...success, code: 255, stderr: "connection refused" } }));
  const items = remotePackets(config, observations, T);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => [item.host, item.component, item.failureClass]), [["example", "remote:example", "watcher-failure"], ["alpha", "remote:alpha", "watcher-failure"]]);
  assert.equal(items[0]?.summary, "remote checks could not reach the machine");
  assert.equal(items[0]?.evidence.stderrTail, "connection refused");
  assert.equal(packets({ code: null, error: "timeout" })[0]?.evidence.stderrTail, "timeout");
  assert.equal(packets({ code: 255, error: "failure ".repeat(300) })[0]?.evidence.stderrTail?.length, 1500);
  assert.deepEqual(packets({ code: 255 }, remoteConfig({ checks: [{ ...check, unreachable: "ignore" }] })!), []);
  assert.deepEqual(packets({ code: null, error: "timeout" }, remoteConfig({ checks: [{ ...check, unreachable: "ignore" }] })!), []);
  const recovered = reconcileCatalog(new Map(items.map((item) => [item.fingerprint, item])), [], T);
  assert.ok(recovered.send.every((item) => item.recovered));
  assert.equal(recovered.send.length, 2);
});

test("unknown machines report even when unreachable checks would be ignored", () => {
  const config = remoteConfig({ checks: [{ ...check, unreachable: "ignore" }] })!;
  const item = remotePackets(config, [{ kind: "missing-machine", index: 0 }], T)[0]!;
  assert.equal(item.component, "remote:example");
  assert.equal(item.failureClass, "watcher-failure");
  assert.equal(item.summary, "machine is not in the machine list");
});

test("nonzero exits take precedence and include bounded stderr and newest stdout lines", () => {
  const item = packets({ code: 2, stdout: "old\n1\n2\n3\n4\n5", stderr: `${"a ".repeat(1000)}newest` }, remoteConfig({ checks: [{ ...check, failureClass: "dead", pattern: "error", mustMatch: "running" }] })!)[0]!;
  assert.equal(item.summary, "command failed (exit 2)");
  assert.equal(item.failureClass, "dead");
  assert.equal(item.severity, "critical");
  assert.equal(item.evidence.exitCode, 2);
  assert.equal(item.evidence.stderrTail?.length, 1500);
  assert.ok(item.evidence.stderrTail?.endsWith("newest"));
  assert.equal(item.evidence.journalTail, "1\n2\n3\n4\n5");
  const thrown = packets({ code: null, error: "spawn failed" })[0]!;
  assert.equal(thrown.summary, "command failed (exit null)");
  assert.equal(thrown.evidence.exitCode, undefined);
  assert.equal(thrown.evidence.stderrTail, "spawn failed");
});

test("patterns and ignore expressions match without case sensitivity and keep the newest hits", () => {
  const config = remoteConfig({ checks: [{ ...check, pattern: "error", ignore: "benign" }] })!;
  const stdout = ["INFO healthy", "ERROR BENIGN", ...Array.from({ length: 10 }, (_, i) => `error line ${i} ${"x ".repeat(200)}`)].join("\r\n");
  const item = packets({ stdout }, config)[0]!;
  assert.equal(item.summary, "10 matching lines");
  assert.equal(item.evidence.journalTail?.length, 1500);
  assert.equal(item.evidence.journalTail?.split("\n").length, 5);
  assert.match(item.evidence.journalTail!, /^error line 5/);
  assert.match(item.evidence.journalTail!, /error line 9/);
  for (const line of item.evidence.journalTail!.split("\n")) assert.ok(line.length <= 300);
  assert.doesNotMatch(item.evidence.journalTail!, /BENIGN|healthy/);
  assert.deepEqual(packets({ stdout: "ERROR benign\nINFO healthy" }, config), []);
});

test("missing required output opens one packet and pattern hits take precedence when both fail", () => {
  const config = remoteConfig({ checks: [{ ...check, pattern: "error", mustMatch: "running" }] })!;
  assert.equal(packets({ stdout: "stopped" }, config)[0]?.summary, "expected output missing");
  assert.equal(packets({ stdout: "error stopped" }, config)[0]?.summary, "1 matching lines");
  assert.equal(packets({ stdout: "error RUNNING" }, config)[0]?.summary, "1 matching lines");
  assert.equal(packets({ stdout: "error stopped" }, config).length, 1);
  assert.deepEqual(packets({ stdout: "RUNNING" }, config), []);
  assert.deepEqual(packets({ stdout: "error stopped" }), []);
  assert.deepEqual(packets({}), []);
  const required = remoteConfig({ checks: [{ ...check, mustMatch: "running", ignore: "running" }] })!;
  assert.deepEqual(packets({ stdout: "RUNNING" }, required), []);
  assert.equal(packets({ stdout: "old\n1\n2\n3\n4\n5" }, required)[0]?.evidence.journalTail, "1\n2\n3\n4\n5");
});

test("severity overrides and secret redaction apply before packets leave core", () => {
  const config = remoteConfig({ checks: [{ ...check, failureClass: "dead", severity: "info", pattern: "error" }] })!;
  const item = packets({ stdout: "ERROR password=example-value" }, config)[0]!;
  assert.equal(item.severity, "info");
  assert.equal(item.redaction.applied, true);
  assert.doesNotMatch(JSON.stringify(item), /example-value/);
  assert.equal(packets({ code: 1 }, config)[0]?.severity, "info");
  assert.equal(packets({ code: 255 }, config)[0]?.severity, "warning");
  assert.deepEqual(remotePackets(config, [{ kind: "result", index: 10, result: success }], T), []);
  assert.deepEqual(remotePackets(config, [{ kind: "result", index: 0, result: success }], "invalid"), []);
});
