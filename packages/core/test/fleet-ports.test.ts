import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFleetConfig } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("a missing fleet file is empty and a malformed or secret-bearing file is ignored", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const missing = loadFleetConfig(join(dir, "absent.json"));
    assert.equal(missing.fileError, null);
    assert.deepEqual(missing.notifiers, []);
    assert.deepEqual(missing.digestTimes, ["08:00", "18:00"]);
    missing.digestTimes.push("09:00");
    assert.deepEqual(loadFleetConfig(join(dir, "absent.json")).digestTimes, ["08:00", "18:00"]);
    assert.equal(loadFleetConfig(join(dir, "absent.json")).notifiers.length, 0);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{", "utf8");
    assert.match(loadFleetConfig(bad).fileError ?? "", /malformed/);
    const secret = join(dir, "secret.json");
    writeFileSync(secret, JSON.stringify({ url: "https://example.test/hook" }), "utf8");
    assert.ok(loadFleetConfig(secret).fileError);
    const extra = join(dir, "extra.json");
    writeFileSync(extra, JSON.stringify({ nickname: "hub" }), "utf8");
    assert.ok(loadFleetConfig(extra).fileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook addresses are read from the environment when the notifier is used", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({ notifiers: [{ type: "webhook", urlEnv: "SCOUT_FLEET_WEBHOOK_URL" }] }), "utf8");
    let value: string | undefined;
    const file = loadFleetConfig(path, (name) => name === "SCOUT_FLEET_WEBHOOK_URL" ? value : undefined);
    assert.equal(file.fileError, null);
    assert.equal(file.notifiers[0]?.url(), undefined);
    value = "https://example.test/hook";
    assert.equal(file.notifiers[0]?.url(), value);
    writeFileSync(join(dir, "open.json"), JSON.stringify({ notifiers: [{ type: "webhook" }] }), "utf8");
    assert.ok(loadFleetConfig(join(dir, "open.json")).fileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the example fleet file loads with no embedded address", () => {
  const path = fileURLToPath(new URL("../../../fleet.example.json", import.meta.url));
  const file = loadFleetConfig(path, () => undefined);
  assert.equal(file.fileError, null);
  assert.equal(file.policy?.quietHours?.timezone, "local");
  assert.deepEqual(file.digestTimes, ["08:00", "18:00"]);
  assert.equal(file.ingestTokenEnv, "SCOUT_FLEET_INGEST_TOKEN");
  assert.equal(file.notifiers.some((row) => row.type === "webhook" && row.urlEnv === "SCOUT_FLEET_WEBHOOK_URL"), true);
  assert.equal(file.expected[0]?.host, "desktop");
});

test("catalog source config is optional and validates flags, ages, and regex lists", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    assert.equal(loadFleetConfig(path).sources?.catalog?.enabled, undefined);
    for (const data of [{}, { sources: {} }, { sources: { catalog: {} } }, { sources: { catalog: { enabled: false } } }, { sources: { catalog: { neverRan: { tasks: [] } } } }]) {
      writeFileSync(path, JSON.stringify(data), "utf8");
      const file = loadFleetConfig(path);
      assert.equal(file.fileError, null);
      assert.notEqual(file.sources?.catalog?.enabled, true);
    }
    const catalog = { enabled: true, staleScanMinutes: 15, tasks: { include: ["^Backup$"], exclude: [] }, launchd: { include: ["^org\\.example\\."], exclude: ["test"] }, systemd: { include: ["^backup\\.service$"], exclude: [] }, windowsServices: { include: ["^Backup$"] } };
    writeFileSync(path, JSON.stringify({ sources: { catalog } }), "utf8");
    const file = loadFleetConfig(path);
    assert.equal(file.fileError, null);
    assert.deepEqual(file.sources?.catalog, catalog);
    for (const tasks of [["^backup$", "^folder\\\\task$"], Array(50).fill("x".repeat(200))]) {
      writeFileSync(path, JSON.stringify({ sources: { catalog: { neverRan: { tasks } } } }), "utf8");
      const file = loadFleetConfig(path);
      assert.equal(file.fileError, null);
      assert.deepEqual(file.sources?.catalog?.neverRan, { tasks });
    }
    for (const invalid of [
      { tasks: { include: ["["] } },
      { launchd: { exclude: ["("] } },
      { systemd: { include: ["*"] } },
      { windowsServices: { include: ["["] } },
      { enabled: "true" },
      { staleScanMinutes: 0 },
      { staleScanMinutes: -1 },
      { tasks: { include: "backup" } },
      { tasks: { include: [1] } },
      { windowsServices: { exclude: [] } },
      { neverRan: null },
      { neverRan: [] },
      { neverRan: "backup" },
      { neverRan: {} },
      { neverRan: { tasks: "backup" } },
      { neverRan: { tasks: ["["] } },
      { neverRan: { tasks: Array(51).fill("backup") } },
      { neverRan: { tasks: [""] } },
      { neverRan: { tasks: ["x".repeat(201)] } },
      { neverRan: { tasks: [1] } },
      { neverRan: { tasks: [], unknown: true } },
      { unknown: true },
    ]) {
      writeFileSync(path, JSON.stringify({ ingestTokenEnv: "FLEET_TOKEN", sources: { catalog: { enabled: true, ...invalid } } }), "utf8");
      const broken = loadFleetConfig(path);
      assert.match(broken.fileError ?? "", /malformed/);
      assert.equal(broken.sources?.catalog?.enabled, undefined);
      assert.equal(broken.ingestTokenEnv, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
