import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openCatalog, recordResearch, recordScan, upsertMachine, type Exec } from "@scout/core";
import { createHub } from "../src/server.ts";
import { Runner } from "@scout/ops";
import { createJobsResponse } from "../src/jobs-api.ts";

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
