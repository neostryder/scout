import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutageNotice } from "@scout/core";
import { Notifier } from "../src/notify.ts";
import { Watchdog, formatSpan } from "../src/watchdog.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "scout-watchdog-"));
  const path = join(dir, "heartbeat.json");
  const sent: OutageNotice[] = [];
  let now = Date.parse("2026-10-10T08:00:00.000Z");
  const beat = (at: number) => writeFileSync(path, JSON.stringify({ at: new Date(at).toISOString(), pid: 1, startedAt: "x" }));
  const watchdog = new Watchdog({ heartbeatPath: path, notifier: new Notifier({ webhook: () => undefined, desktop: async (notice) => { sent.push(notice); }, log: () => {} }), now: () => now, log: () => {} });
  return { dir, watchdog, sent, beat, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("the watchdog stays quiet while the heartbeat is fresh, announces a stale one once, and announces the recovery with the span", async () => {
  const { dir, watchdog, sent, beat, advance, now } = setup();
  try {
    assert.equal(await watchdog.check(), null, "no heartbeat file yet");
    beat(now());
    advance(60_000);
    assert.equal(await watchdog.check(), null);
    advance(150_000);
    assert.equal(await watchdog.check(), "silent");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.title, /not responding/);
    advance(60_000);
    assert.equal(await watchdog.check(), null, "a continuing silence is not announced again");
    assert.equal(sent.length, 1);
    beat(now());
    assert.equal(await watchdog.check(), "recovered");
    assert.match(sent[1]!.body, /after 4 min/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("spans read in seconds, minutes, and hours", () => {
  assert.equal(formatSpan(30_000), "30 s");
  assert.equal(formatSpan(300_000), "5 min");
  assert.equal(formatSpan(3_900_000), "1 h 5 min");
});

test("a stored webhook is read through the decrypt step only on Windows and only when the file exists", async () => {
  const { readStoredWebhook } = await import("../src/notify.ts");
  const dir = mkdtempSync(join(tmpdir(), "scout-stored-"));
  try {
    const path = join(dir, "discord-webhook.dpapi");
    assert.equal(readStoredWebhook(path, () => "never"), undefined, "no file, no read");
    writeFileSync(path, "x");
    const read = readStoredWebhook(path, () => " https://discord.com/api/webhooks/1/abc \n");
    assert.equal(read, process.platform === "win32" ? "https://discord.com/api/webhooks/1/abc" : undefined);
    assert.equal(readStoredWebhook(path, () => { throw new Error("bad blob"); }), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
