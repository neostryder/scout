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
