import { test } from "node:test";
import assert from "node:assert/strict";

const { outageStateLabel, outageDuration, outageKindLabel, groupOutages, itemGroups, channelText, pauseText } = await import(new URL("../public/outages-model.js", import.meta.url).href);

test("outage states, kinds and durations read as plain words", () => {
  assert.deepEqual(["hung", "down", "not-running", "flapping", "monitor-gap", "other"].map((state) => outageStateLabel({ state })), ["Hung", "Down", "Not running", "Flapping", "Scout not running", "other"]);
  assert.deepEqual(["machine", "url", "service", "monitor-gap"].map(outageKindLabel), ["Machine", "Web address", "Service", "Monitor gap"]);
  assert.deepEqual([5_000, 90_000, 3_600_000, 5_400_000, 50 * 3_600_000].map(outageDuration), ["5 s", "1 min", "1 h", "1 h 30 min", "2 d 2 h"]);
});

test("outages split into open and past and watch items group by kind", () => {
  const { open, past } = groupOutages([{ id: 1, endedAt: null }, { id: 2, endedAt: "2026-10-10T00:00:00Z" }]);
  assert.deepEqual([open.map((row: any) => row.id), past.map((row: any) => row.id)], [[1], [2]]);
  const groups = itemGroups([{ kind: "machine", key: "a" }, { kind: "service", key: "b" }, { kind: "url", key: "c" }]);
  assert.deepEqual([groups.machine.length, groups.url.length, groups.service.length], [1, 1, 1]);
});

test("channel and pause text tell the reader what happens next", () => {
  assert.match(channelText({ discord: true, desktop: true }), /Discord and to a desktop/);
  assert.match(channelText({ discord: false, desktop: true }), /SCOUT_DISCORD_WEBHOOK/);
  assert.equal(pauseText({ pausedUntil: null }), "");
  assert.equal(pauseText({ pausedUntil: "2026-10-10T00:00:00Z" }, Date.parse("2026-10-11T00:00:00Z")), "");
  assert.match(pauseText({ pausedUntil: "2026-10-12T00:00:00Z" }, Date.parse("2026-10-11T00:00:00Z")), /^Paused until /);
});
