import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, putIntel, recordScan, upsertMachine } from "@scout/core";
import { installDetail } from "../src/api.ts";

const NOW = "2026-10-18T12:00:00.000Z";
const LIMIT = 64 * 1024;

function documentOfSize(bytes: number): Record<string, unknown> {
  const prefix = "{\"n\":\"";
  const suffix = "\"}";
  const fill = bytes - Buffer.byteLength(prefix + suffix, "utf8");
  const data = { n: "a".repeat(fill) };
  assert.equal(Buffer.byteLength(JSON.stringify(data), "utf8"), bytes);
  return data;
}

function seed(t: TestContext) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "host", name: "Host", os: "windows", kind: "host" });
  recordScan(db, "host", { sourceKind: "cogmodels", location: "", status: "ok", installs: [
    { ecosystem: "model", key: "hf:owner/repo", name: "Repo", kind: "model", version: "abcdefabcdef", location: "/models/repo" },
  ] }, NOW);
  const row = db.prepare("SELECT i.id AS id, p.id AS packageId FROM installs i JOIN packages p ON p.id = i.package_id").get() as { id: number; packageId: number };
  return { db, ...row };
}

test("install detail returns stored intel and an empty list when none is stored", (t) => {
  const { db, id, packageId } = seed(t);
  assert.deepEqual((installDetail(db, id) as { intel: unknown }).intel, []);
  putIntel(db, packageId, "huggingface", { latestRevision: "a".repeat(40), hasNewerRevision: false }, NOW);
  putIntel(db, packageId, "gitclone", { defaultBranch: "main", archived: false }, NOW);
  assert.deepEqual((installDetail(db, id) as { intel: unknown }).intel, [
    { source: "gitclone", fetchedAt: NOW, data: { defaultBranch: "main", archived: false } },
    { source: "huggingface", fetchedAt: NOW, data: { latestRevision: "a".repeat(40), hasNewerRevision: false } },
  ]);
});

test("install detail drops an intel document larger than 64 KB and keeps one at the limit", (t) => {
  const { db, id, packageId } = seed(t);
  const kept = documentOfSize(LIMIT);
  const dropped = documentOfSize(LIMIT + 1);
  putIntel(db, packageId, "gitclone", kept, NOW);
  putIntel(db, packageId, "huggingface", dropped, NOW);
  const intel = (installDetail(db, id) as { intel: { source: string; fetchedAt: string; data?: unknown; truncated?: boolean }[] }).intel;
  assert.deepEqual(intel, [
    { source: "gitclone", fetchedAt: NOW, data: kept },
    { source: "huggingface", fetchedAt: NOW, truncated: true },
  ]);
  assert.equal(Object.hasOwn(intel[1]!, "data"), false);
});
