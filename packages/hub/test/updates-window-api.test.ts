import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { openCatalog, recordResearch, recordScan, upsertMachine, type Exec } from "@scout/core";
import { createHub } from "../src/server.ts";

test("the window route lists each machine's pending updates in a safe batch", async () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordScan(db, "mini", { sourceKind: "brew", location: "", status: "ok", installs: [{ ecosystem: "brew", key: "git", name: "git", kind: "package", version: "1.0", location: "" }] }, new Date().toISOString());
  const pkg = (db.prepare("SELECT id FROM packages").get() as { id: number }).id;
  recordResearch(db, pkg, "brew-api", "ok", [{ channel: "stable", version: "2.0", installable: true }], null);
  const exec: Exec = async () => ({ exitCode: 0, stdout: "git 1.0\n", stderr: "" });
  const server = createHub({ db, webRoot: process.cwd(), jobs: { machines: [{ id: "mini", transport: { type: "local" } }], exec } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const { status, data } = await get("/api/updates/window");
    assert.equal(status, 200);
    assert.equal(data.machines.length, 1);
    const machine = data.machines[0];
    assert.equal(machine.machineId, "mini");
    assert.deepEqual(machine.now.map((item: { name: string }) => item.name), ["git"]);
    assert.deepEqual(machine.atQuietHour, []);
    assert.deepEqual(machine.held, []);
    assert.equal(machine.quietHour.basis, "default");
    assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
