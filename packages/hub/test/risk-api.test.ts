import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openCatalog } from "@scout/core";
import { createHub } from "../src/server.ts";

const db = openCatalog(":memory:");
const server = createHub({ db, webRoot: process.cwd(), control: false, health: false });
const base = await new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
after(() => { server.close(); server.closeAllConnections(); db.close(); });

test("/api/risk returns machine risks and a generation timestamp for an empty catalog", async () => {
  const response = await fetch(`${base}/api/risk`);
  const body = await response.json() as { machines: unknown[]; generatedAt: string };
  assert.equal(response.status, 200);
  assert.deepEqual(body.machines, []);
  assert.equal(Number.isNaN(Date.parse(body.generatedAt)), false);
});

test("/api/risk reuses its response inside the default TTL", async () => {
  const first = await fetch(`${base}/api/risk`).then((response) => response.json()) as { generatedAt: string };
  const second = await fetch(`${base}/api/risk`).then((response) => response.json()) as { generatedAt: string };
  assert.equal(second.generatedAt, first.generatedAt);
});

test("/api/risk recomputes when the TTL is zero", async () => {
  const zeroTtlDb = openCatalog(":memory:");
  const zeroTtlServer = createHub({ db: zeroTtlDb, webRoot: process.cwd(), control: false, health: false, riskTtlMs: 0 });
  const zeroTtlBase = await new Promise<string>((resolve) => zeroTtlServer.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(zeroTtlServer.address() as AddressInfo).port}`)));
  try {
    const first = await fetch(`${zeroTtlBase}/api/risk`).then((response) => response.json()) as { generatedAt: string };
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await fetch(`${zeroTtlBase}/api/risk`).then((response) => response.json()) as { generatedAt: string };
    assert.notEqual(second.generatedAt, first.generatedAt);
  } finally {
    zeroTtlServer.close();
    zeroTtlServer.closeAllConnections();
    zeroTtlDb.close();
  }
});
