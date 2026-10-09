import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listListeners, listServices, openCatalog, recordListeners, recordServices, upsertMachine } from "@scout/core";
import { describeCommand } from "../src/describe.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectDescriptionSource } from "../../hub/src/descriptions-project.ts";
import { CogitatorClient } from "@scout/ops";
import { fakeGateway } from "../../ops/test/cogitator-gateway.ts";

function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "m", name: "Machine", os: "windows", kind: "host" });
  upsertMachine(db, { id: "other", name: "Other", os: "linux", kind: "host" });
  recordServices(db, "m", { origin: "services", status: "ok", facts: [{ kind: "windows-service", name: "DemoService", displayName: "Demo background service", domain: "system", program: "C:/Tools/demo.exe", state: "running", startMode: "auto", enabled: true, pid: 10, runAs: null, triggers: null, lastRun: null, lastResult: null }] }, "2026-10-07T17:00:00.000Z");
  recordListeners(db, "other", { origin: "listeners", status: "ok", facts: [{ port: 8181, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 20, processName: "OtherProgram", processPath: "/opt/other", container: null }] }, "2026-10-07T17:00:00.000Z");
  return db;
}

test("describe lists descriptions and sources and applies missing, source and machine filters", async (t) => {
  const db = seed(t);
  const lines: string[] = [];
  const write = (line: string): void => { lines.push(line); };
  await describeCommand(db, [], { write });
  assert.deepEqual(lines.map((line) => JSON.parse(line).source), ["os", "none"]);
  lines.length = 0;
  await describeCommand(db, ["--missing"], { write });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).target, "listener");
  lines.length = 0;
  await describeCommand(db, ["--source", "os", "--machine", "m"], { write });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).description.text, "Demo background service");
  lines.length = 0;
  await describeCommand(db, ["--machine", "other", "--source", "none"], { write });
  assert.equal(lines.length, 1);
  await assert.rejects(describeCommand(db, ["--source", "bad"], { write }), /unknown/);
});

test("describe set and clear write service and listener subjects in memory", async (t) => {
  const db = seed(t);
  const lines: string[] = [];
  const write = (line: string): void => { lines.push(line); };
  const serviceId = String(listServices(db)[0]!.id);
  const listenerId = String(listListeners(db)[0]!.id);
  for (const [target, id] of [["service", serviceId], ["listener", listenerId]]) {
    await describeCommand(db, ["set", target!, id!, "The service keeps the shared cache up to date."], { write });
    assert.equal(JSON.parse(lines.at(-1)!).description.source, "hand");
    await describeCommand(db, ["clear", target!, id!], { write });
    assert.equal(JSON.parse(lines.at(-1)!).description?.source ?? "none", target === "service" ? "os" : "none");
  }
  await assert.rejects(describeCommand(db, ["set", "service", serviceId, "short"], { write }), /length/);
  await assert.rejects(describeCommand(db, ["set", "service", serviceId], { write }), /required/);
  await assert.rejects(describeCommand(db, ["clear", "route", serviceId], { write }), /target/);
  await assert.rejects(describeCommand(db, ["clear", "service", "bad"], { write }), /integer/);
  await assert.rejects(describeCommand(db, ["clear", "listener", "99999"], { write }), /not found/);
});

test("describe public uses an injected runner and prints counts only", async (t) => {
  const db = seed(t);
  const lines: string[] = [];
  await describeCommand(db, ["public"], { write: (line) => { lines.push(line); }, modelLabel: "internal-label", model: async (request) => {
    assert.equal(request.dataClass, "public");
    return JSON.stringify([{ id: 0, description: "The service runs a background data service.", confidence: 0.8 }]);
  } });
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ total: 2, done: 2, applied: 1, skipped: 0, rejected: 0 }]);
  assert.equal(listServices(db)[0]!.description?.source, "public");
});

test("the CLI entry point accepts describe against a memory catalog", () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "describe", "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("project CLI list, run, force, only and show use the client and keep its key and model private", async (t) => {
  const db = seed(t);
  const folder = mkdtempSync(join(process.cwd(), ".project-cli-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const projects = ["demo", "other"].map((name) => {
    const root = join(folder, name).replace(/\\/g, "/");
    mkdirSync(root);
    writeFileSync(join(root, "README.md"), "Demo tracks installed versions.");
    return { machineId: "hub", name, root };
  });
  const fake = fakeGateway();
  const project: ProjectDescriptionSource = { client: new CogitatorClient({ gateway: "http://127.0.0.1:8470", role: "scout-describe" }, "fixture-client-credential", { fetch: fake.fetch }), projects: () => projects, reason: null };
  const lines: string[] = [];
  const options = { project, write: (line: string): void => { lines.push(line); } };
  await describeCommand(db, ["project", "list"], options);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).hashState, "missing");
  assert.equal(fake.calls.length, 0);
  lines.length = 0;
  await describeCommand(db, ["project", "run", "--only", "demo"], options);
  assert.deepEqual(JSON.parse(lines[0]!), { total: 1, done: 1, applied: 1, skipped: 0, rejected: 0 });
  lines.length = 0;
  await describeCommand(db, ["project", "run", "--only", "demo"], options);
  assert.deepEqual(JSON.parse(lines[0]!), { total: 0, done: 0, applied: 0, skipped: 1, rejected: 0 });
  lines.length = 0;
  await describeCommand(db, ["project", "run", "--force", "--only", "demo"], options);
  assert.equal(JSON.parse(lines[0]!).applied, 1);
  lines.length = 0;
  await describeCommand(db, ["project", "show", "demo"], options);
  const shown = JSON.parse(lines[0]!);
  assert.equal(shown.text, "--- README.md ---\nDemo tracks installed versions.");
  assert.deepEqual(shown.evidence, ["tracks installed versions"]);
  assert.equal(shown.confidence, 0.9);
  assert.equal(lines[0]!.includes("fixture-client-credential"), false);
  assert.equal(lines[0]!.includes("fixture-model"), false);
  lines.length = 0;
  await describeCommand(db, ["project", "list"], options);
  assert.equal(JSON.parse(lines[0]!).hashState, "unchanged");
  assert.equal(JSON.parse(lines[1]!).hashState, "missing");
  await assert.rejects(describeCommand(db, ["project", "show", "missing"], options), /project not found/);
  await assert.rejects(describeCommand(db, ["project", "run", "--only", "missing"], options), /project not found/);
  await assert.rejects(describeCommand(db, ["project", "run", "--only"], options), /requires a name/);
  await assert.rejects(describeCommand(db, ["project", "run"], { ...options, project: { ...project, client: null, reason: "no key" } }), /project descriptions are off/);
  await assert.rejects(describeCommand(db, ["project", "unknown"], options), /usage/);
});
