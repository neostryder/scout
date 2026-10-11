import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openCatalog, recordServices, upsertMachine, type ServiceFact } from "@scout/core";
import { createHub } from "../src/server.ts";

const AT = new Date().toISOString();
const svc = (over: Partial<ServiceFact>): ServiceFact => ({ kind: "windows-service", name: "worker", displayName: "Worker", domain: "system", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null, ...over });

const db = openCatalog(":memory:");
upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
db.prepare("UPDATE machines SET state = 'reachable' WHERE id = 'hub'").run();
recordServices(db, "hub", { origin: "services", status: "ok", facts: [svc({ name: "worker" }), svc({ name: "Spooler", displayName: "Print Spooler" })] }, AT);

const dir = mkdtempSync(join(tmpdir(), "scout-tray-api-"));
const trayPath = join(dir, "tray.json");
const server = createHub({ db, webRoot: dir, trayPath });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); db.close(); rmSync(dir, { recursive: true, force: true }); });
const send = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const labels = async (): Promise<string[]> => ((await (await send("/api/tray", "GET")).json()) as any).machines[0].rows.map((r: any) => r.label);

test("the tray response lists each machine's rows with a version that serves a 304 when nothing changed", async () => {
  const res = await send("/api/tray", "GET");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.machines[0].id, "hub");
  assert.deepEqual(body.machines[0].rows.map((r: any) => r.label), ["Print Spooler", "Worker"]);
  assert.equal(body.fileError, null);
  const etag = res.headers.get("etag")!;
  assert.equal(etag, `"${body.version}"`);
  assert.equal((await send("/api/tray", "GET", undefined, { "if-none-match": etag })).status, 304);
});

test("saving rules hides rows, rejects a malformed document, and survives a bad edit on disk", async () => {
  const put = await send("/api/tray/rules", "PUT", { rules: { hide: { names: [{ match: "print*" }] } } });
  assert.equal(put.status, 200);
  assert.deepEqual(await labels(), ["Worker"]);
  assert.equal(JSON.parse(readFileSync(trayPath, "utf8")).hide.names[0].match, "print*");
  const bad = await send("/api/tray/rules", "PUT", { rules: { hide: { kinds: ["nonsense"] } } });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).error, /unknown value/);
  assert.deepEqual(await labels(), ["Worker"]);
  const got = (await (await send("/api/tray/rules", "GET")).json()) as any;
  assert.equal(got.rules.hide.names.length, 1);
  assert.equal((await send("/api/tray/rules", "DELETE")).status, 405);
});

test("hide and undo from the panel's right-click menu edit the rules without replacing the document", async () => {
  await send("/api/tray/rules", "PUT", { rules: { hide: { kinds: [] } } });
  assert.equal((await send("/api/tray/hide", "POST", { machine: "hub", name: "Worker" })).status, 200);
  assert.deepEqual(await labels(), ["Print Spooler"]);
  const key = ((await (await send("/api/tray", "GET")).json()) as any).machines[0].rows[0].key as string;
  assert.equal((await send("/api/tray/hide", "POST", { machine: "hub", name: "Worker", undo: true })).status, 200);
  assert.deepEqual(await labels(), ["Print Spooler", "Worker"]);
  assert.equal((await send("/api/tray/hide", "POST", { machine: "hub" })).status, 400);
  assert.ok(key);
});

test("a damaged rules file is ignored with a visible error", async () => {
  writeFileSync(trayPath, "{ nope");
  const body = (await (await send("/api/tray", "GET")).json()) as any;
  assert.match(body.fileError, /damaged and is ignored/);
  assert.equal(body.machines[0].rows.length, 2);
});
