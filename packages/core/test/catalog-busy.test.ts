import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog } from "../src/db.ts";

test("a catalog connection waits for a write lock held by another connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-busy-"));
  try {
    const path = join(dir, "catalog.db");
    const holder = openCatalog(path);
    const waiter = openCatalog(path, { busyTimeoutMs: 1500 });
    assert.equal((waiter.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 1500);
    assert.equal((holder.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    holder.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    assert.throws(() => waiter.exec("BEGIN IMMEDIATE"), /database is locked/);
    assert.ok(Date.now() - started >= 1000, "the second writer waited out most of its timeout before giving up");
    holder.exec("COMMIT");
    waiter.exec("BEGIN IMMEDIATE");
    waiter.exec("COMMIT");
    holder.close();
    waiter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
