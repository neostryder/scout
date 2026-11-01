import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFleetConfig } from "../src/index.ts";

test("a missing fleet file is empty and a malformed or secret-bearing file is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-file-"));
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
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-file-"));
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
