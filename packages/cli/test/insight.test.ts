import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, recordServices, upsertMachine, type Db, type ServiceFact } from "@scout/core";
import { localPaths } from "@scout/ops";
import { mapCommand, statusCommand, whoisCommand } from "../src/insight.ts";

const AT = "2026-10-10T12:00:00.000Z";
const svc = (over: Partial<ServiceFact>): ServiceFact => ({ kind: "windows-service", name: "worker", displayName: "Worker", domain: "system", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null, ...over });

function seed(t: TestContext): { db: Db; paths: ReturnType<typeof localPaths>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "insight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "eru", name: "Eru", os: "windows", kind: "host" });
  db.prepare("UPDATE machines SET state = 'reachable' WHERE kind = 'host'").run();
  recordServices(db, "eru", { origin: "services", status: "ok", facts: [svc({ name: "worker" }), svc({ name: "Spooler", displayName: "Print Spooler" })] }, AT);
  return { db, paths: localPaths(dir, ":memory:"), dir };
}

test("status prints the overall state and one line per machine, or JSON with --json", (t) => {
  const { db, paths } = seed(t);
  const lines: string[] = [];
  statusCommand(db, [], { paths, now: AT, write: (l) => { lines.push(l); } });
  assert.match(lines[0]!, /^Overall: up\. Open outages: 0\./);
  assert.ok(lines.some((l) => l.startsWith("Eru")));
  const json: string[] = [];
  statusCommand(db, ["--json"], { paths, now: AT, write: (l) => { json.push(l); } });
  const status = JSON.parse(json[0]!);
  assert.equal(status.machines[0].id, "eru");
  assert.deepEqual(status.outages, []);
});

test("whois answers a name, says so when nothing matches, and refuses a missing query", (t) => {
  const { db, paths } = seed(t);
  const lines: string[] = [];
  whoisCommand(db, ["spool"], { paths, write: (l) => { lines.push(l); } });
  assert.match(lines[0]!, /^Eru: service Print Spooler/);
  whoisCommand(db, ["nothing-here"], { paths, write: (l) => { lines.push(l); } });
  assert.equal(lines[1], "Nothing matches nothing-here.");
  assert.throws(() => whoisCommand(db, ["--json"], { paths }), /requires a port number or a name/);
});

test("map prints markdown, or writes it to a file and creates the folder", (t) => {
  const { db, paths, dir } = seed(t);
  const lines: string[] = [];
  mapCommand(db, [], { paths, now: AT, write: (l) => { lines.push(l); } });
  assert.match(lines[0]!, /^# Systems map/);
  const target = join(dir, "vault", "notes", "map.md");
  mapCommand(db, ["--out", target], { paths, now: AT, write: (l) => { lines.push(l); } });
  assert.match(readFileSync(target, "utf8"), /## Eru/);
  assert.match(lines[1]!, /^Wrote /);
  assert.throws(() => mapCommand(db, ["--out"], { paths }), /--out requires a file path/);
});
