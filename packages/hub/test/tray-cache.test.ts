import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { emptyProvenance, openCatalog, parseTrayRules, recordServices, upsertMachine, type ProtectedContext, type ServiceFact } from "@scout/core";
import { trayApi, type TrayDeps } from "../src/tray-api.ts";

const AT = new Date().toISOString();
const svc = (name: string): ServiceFact => ({ kind: "windows-service", name, displayName: name, domain: "system", program: `C:/Tools/${name}.exe`, state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null });

function rowCount(db: ReturnType<typeof openCatalog>, deps: TrayDeps): Promise<number> {
  const req = { method: "GET", headers: {} } as unknown as IncomingMessage;
  const res = { setHeader: () => undefined, writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse;
  let body: any;
  return trayApi(db, req, new URL("http://hub/api/tray"), res, () => true, (_res, _status, value) => { body = value; }, deps).then(() => body.machines[0].rows.length);
}

test("a read model is reused inside the cache window and rebuilt after it", async () => {
  const db = openCatalog(":memory:");
  try {
    upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
    db.prepare("UPDATE machines SET state = 'reachable' WHERE id = 'hub'").run();
    recordServices(db, "hub", { origin: "services", status: "ok", facts: [svc("worker")] }, AT);
    let clock = 1_000;
    let stackReads = 0;
    const deps: TrayDeps = {
      rulesPath: "unused",
      read: () => ({ rules: parseTrayRules({}), fileError: null }),
      stacks: () => { stackReads++; return []; },
      provenance: () => emptyProvenance(),
      control: { context: () => ({}) as ProtectedContext },
      cacheMs: 4000,
      now: () => clock,
    };
    assert.equal(await rowCount(db, deps), 1);
    assert.equal(stackReads, 1);
    recordServices(db, "hub", { origin: "services", status: "ok", facts: [svc("worker"), svc("spooler")] }, AT);
    clock += 3_999;
    assert.equal(await rowCount(db, deps), 1);
    assert.equal(stackReads, 1);
    clock += 1;
    assert.equal(await rowCount(db, deps), 2);
    assert.equal(stackReads, 2);
    recordServices(db, "hub", { origin: "services", status: "ok", facts: [svc("worker")] }, AT);
    const uncached: TrayDeps = { ...deps, cacheMs: 0 };
    assert.equal(await rowCount(db, uncached), 1);
    assert.equal(stackReads, 3);
  } finally {
    db.close();
  }
});

test("a changed rules file is never answered from the cache", async () => {
  const db = openCatalog(":memory:");
  try {
    upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
    db.prepare("UPDATE machines SET state = 'reachable' WHERE id = 'hub'").run();
    recordServices(db, "hub", { origin: "services", status: "ok", facts: [svc("worker"), svc("spooler")] }, AT);
    let rules = parseTrayRules({});
    const deps: TrayDeps = {
      rulesPath: "unused",
      read: () => ({ rules, fileError: null }),
      stacks: () => [],
      provenance: () => emptyProvenance(),
      control: { context: () => ({}) as ProtectedContext },
      cacheMs: 60_000,
      now: () => 5_000,
    };
    assert.equal(await rowCount(db, deps), 2);
    rules = parseTrayRules({ hide: { names: [{ match: "spooler" }] } });
    assert.equal(await rowCount(db, deps), 1);
  } finally {
    db.close();
  }
});
