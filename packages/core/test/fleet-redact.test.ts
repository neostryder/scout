import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, redact, redactPacket, type IncidentPacket } from "../src/index.ts";

const sha = "ab".repeat(20);

test("each redaction rule replaces a real-shaped sample and keeps a commit sha and a path", () => {
  const samples: { id: string; text: string }[] = [
    { id: "private-key", text: "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----" },
    { id: "discord", text: "hook https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz" },
    { id: "url-credential", text: "fetch https://user:pass@example.com/path" },
    { id: "github", text: `token ghp_${"a".repeat(36)}` },
    { id: "telegram", text: `bot ${"1".repeat(9)}:${"A".repeat(35)}` },
    { id: "aws", text: "key AKIAIOSFODNN7EXAMPLE" },
    { id: "jwt", text: "eyJaaaaaaaa.bbbbbbbb.cccccccc" },
    { id: "authorization", text: "Authorization: Bearer abcdefghijklmnop" },
    { id: "bearer", text: "saw Bearer abcdefghijklmnop" },
    { id: "secret", text: "password=hunter2" },
    { id: "hex", text: `build ${"ab".repeat(20)}` },
    { id: "base64", text: `blob ${"Ab+/".repeat(12)}` },
  ];
  for (const sample of samples) {
    const result = redact(sample.text);
    assert.ok(result.rules.includes(sample.id), sample.id);
    assert.match(result.text, new RegExp(`\\[redacted:${sample.id}\\]`));
  }
  const kept = redact(`commit ${sha}`);
  assert.equal(kept.rules.includes("hex"), false);
  assert.match(kept.text, new RegExp(sha));
  const path = redact("C:/Projects/demo/src/index.ts");
  assert.deepEqual(path.rules, []);
  assert.equal(path.text, "C:/Projects/demo/src/index.ts");
});

test("redactPacket covers summary, tails, changes and snapshot strings", () => {
  const packet: IncidentPacket = {
    version: 1,
    host: "desktop",
    component: "backup",
    severity: "warning",
    failureClass: "ran-failed",
    firstSeen: "2026-10-31T18:00:00.000Z",
    lastSeen: "2026-10-31T18:00:00.000Z",
    count: 1,
    fingerprint: fingerprint("desktop", "backup", "ran-failed"),
    summary: "password=hunter2",
    evidence: { stderrTail: "Bearer abcdefghijklmnop", recentChanges: ["api_key=abcd"], snapshot: { note: "secret=abcd", exit: 1 } },
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
  const next = redactPacket(packet);
  assert.equal(next.redaction.applied, true);
  assert.equal(next.summary.includes("hunter2"), false);
  assert.equal(next.evidence.stderrTail?.includes("abcdefghijklmnop"), false);
  assert.equal(next.evidence.recentChanges?.[0]?.includes("abcd"), false);
  assert.equal(next.evidence.snapshot?.note, "secret=[redacted:secret]");
  assert.equal(next.evidence.snapshot?.exit, 1);
});
