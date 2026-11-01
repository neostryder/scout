import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openCatalog, recordResearch, recordScan, setAutoUpdate, upsertMachine, type Exec } from "@scout/core";
import { createHub } from "../src/server.ts";
import { Runner, type Preview, type UpdateWindows } from "@scout/ops";
import { createJobsResponse, planResponse, windowResponse } from "../src/jobs-api.ts";
import { WindowRun } from "../src/update-window-schedule.ts";

test("job routes plan, confirm, list, inspect, and refuse duplicates", async () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [
    { ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.0", location: "" },
  ] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
  recordResearch(db, pkg, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  let release: (() => void) | undefined;
  let aborted = false;
  const exec: Exec = async (_transport, argv, _timeout, signal) => {
    if (argv[1] === "list") return { exitCode: 0, stdout: "git 1.0\n", stderr: "" };
    await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
    return { exitCode: -1, stdout: "", stderr: "stopped" };
  };
  const server = createHub({ db, webRoot: process.cwd(), jobs: { machines: [{ id: "mini", transport: { type: "local" } }], exec } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const plan = await call(`/api/updates/plan?installId=${id}`);
    assert.equal(plan.data.allowed, true);
    assert.equal(plan.data.command, "brew upgrade git");
    assert.equal((await call("/api/jobs", "POST", { installIds: [id], confirm: false }, { "content-type": "application/json" })).status, 400);
    assert.equal((await call("/api/jobs", "POST", { installIds: [id], confirm: true }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await call("/api/jobs", "POST", { installIds: [id], confirm: true }, { "content-type": "application/json", origin: "http://evil.test" })).status, 403);
    const created = await call("/api/jobs", "POST", { installIds: [id], confirm: true }, { "content-type": "application/json" });
    assert.equal(created.status, 202);
    const jobId = created.data.jobs[0].id as number;
    assert.equal((await call("/api/jobs")).data.jobs[0].id, jobId);
    assert.equal((await call(`/api/jobs/${jobId}`)).data.installId, id);
    assert.equal((await call("/api/jobs", "POST", { installIds: [id], confirm: true }, { "content-type": "application/json" })).data.refused[0].reason, "an update for this install is already queued");
    assert.equal((await call(`/api/jobs/${jobId}/stop`, "POST", {}, { "content-type": "application/json" })).status, 200);
    assert.equal(aborted, true);
    assert.equal((await call(`/api/jobs/${jobId}/stop`, "POST", {}, { "content-type": "application/json" })).status, 409);
  } finally {
    release?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("disruptive jobs need an explicit second confirmation", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "cask", location: "", status: "ok", installs: [
    { ecosystem: "cask", key: "firefox", name: "Firefox", kind: "app", version: "1.0", location: "" },
  ] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  const id = (db.prepare("SELECT id FROM installs").get() as { id: number }).id;
  recordResearch(db, pkg, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  const runner = new Runner(db, { machines: [{ id: "mini", transport: { type: "local" } }], exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }) });
  assert.equal(createJobsResponse(db, runner, { installIds: [id], confirm: "true", allowDisruptive: true }).status, 400);
  const result = createJobsResponse(db, runner, { installIds: [id], confirm: true, allowDisruptive: false });
  assert.equal(result.status, 400);
  assert.deepEqual((result.body as { refused: { reason: string }[] }).refused[0]?.reason, "disruptive update needs confirmation");
  db.close();
});

test("externally managed winget updates show their refusal and cannot queue manually or automatically", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const cases = [
    { key: "MSYS2.MSYS2", version: "2025.12.13", target: "2026.10.26", refusal: "MSYS2 updates through its own package manager; run pacman -Syu in the MSYS2 shell, because winget cannot upgrade it." },
    { key: "ItchIo.Itch", version: "25.6.0", target: "26.1.9", refusal: "itch updates itself when it runs, and winget cannot see the new version; open itch to update it." },
    { key: "Audacity.Audacity", version: "3.7.9", target: "4.0.0", refusal: "this version uses a different installer type; uninstall Audacity and install the new version." },
  ];
  const now = new Date("2026-10-20T04:00:00.000Z");
  upsertMachine(db, { id: "pc", name: "PC", os: "windows", kind: "host" });
  recordScan(db, "pc", { sourceKind: "winget", location: "", status: "ok", installs: cases.map(({ key, version }) => ({ ecosystem: "winget", key, name: key, version, kind: "app", location: "" })) }, now.toISOString());
  let calls = 0;
  const runner = new Runner(db, { machines: [{ id: "pc", transport: { type: "local" } }], exec: async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; } });
  const refused = cases.map(({ key, target, refusal }) => {
    const pkg = db.prepare("SELECT id FROM packages WHERE key = ?").get(key) as { id: number };
    const install = db.prepare("SELECT id FROM installs WHERE package_id = ?").get(pkg.id) as { id: number };
    recordResearch(db, pkg.id, "test", "ok", [{ channel: "stable", version: target, installable: true }], null, now.toISOString());
    setAutoUpdate(db, install.id, "major");
    const plan = planResponse(db, runner, install.id) as Preview;
    assert.equal(plan.allowed, false);
    assert.equal(plan.refusal, refusal);
    assert.equal(plan.command, "");
    return { installId: install.id, reason: refusal };
  });
  const manual = createJobsResponse(db, runner, { installIds: refused.map((entry) => entry.installId), confirm: true, allowDisruptive: true, allowAdmin: true, confirmSoft: true });
  assert.equal(manual.status, 400);
  assert.deepEqual(manual.body, { batchId: null, jobs: [], refused });
  const window = windowResponse(db, runner, null, now) as UpdateWindows;
  assert.deepEqual(window.machines[0]?.now, []);
  assert.deepEqual(window.machines[0]?.atQuietHour, []);
  assert.deepEqual(window.machines[0]?.held.map(({ installId, kind, reason }) => ({ installId, kind, reason })).sort((a, b) => a.installId - b.installId), refused.map((entry) => ({ ...entry, kind: "blocked" })).sort((a, b) => a.installId - b.installId));
  for (const scope of ["all", "opted-in"] as const) {
    const run = new WindowRun(db, runner, { clock: { now: () => now.getTime(), setTimeout: () => ({}), clearTimeout: () => undefined }, offsetMinutes: () => 0 });
    run.setScope(scope);
    run.setEnabled(true);
    assert.equal(run.tick(), 0);
    assert.equal(run.status().lastQueued, 0);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
  assert.equal(calls, 0);
});
