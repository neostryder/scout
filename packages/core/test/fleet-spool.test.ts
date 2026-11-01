import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPOOL_FILE, createSpool, fingerprint, type IncidentPacket } from "../src/index.ts";

const AT = "2026-10-31T18:00:00.000Z";

function packet(summary: string): IncidentPacket {
  return {
    version: 1,
    host: "desktop",
    component: "backup",
    severity: "warning",
    failureClass: "ran-failed",
    firstSeen: AT,
    lastSeen: AT,
    count: 1,
    fingerprint: fingerprint("desktop", "backup", "ran-failed"),
    summary,
    evidence: {},
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
}

function lines(dir: string): IncidentPacket[] {
  const raw = readFileSync(join(dir, SPOOL_FILE), "utf8");
  return raw.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as IncidentPacket);
}

test("rotation keeps the newest line and reports the drop on the next packet", () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-spool-"));
  try {
    const spool = createSpool({ dir, maxBytes: 80, now: () => new Date(AT) });
    spool.append(packet("x".repeat(80)));
    spool.append(packet("second"));
    spool.append(packet("third"));
    const stored = lines(dir);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.summary, "third");
    assert.equal(stored[0]?.evidence.snapshot?.spoolDropped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drain stops at the first send failure and keeps later lines in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-spool-"));
  try {
    const spool = createSpool({ dir, now: () => new Date(AT) });
    spool.append(packet("a"));
    spool.append(packet("b"));
    spool.append(packet("c"));
    const result = await spool.drain(async (item) => {
      if (item.summary === "b") throw new Error("nope");
    });
    assert.equal(result.sent, 1);
    assert.equal(result.error, "nope");
    assert.deepEqual(lines(dir).map((item) => item.summary), ["b", "c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt lines are skipped and a line appended during drain is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-spool-"));
  try {
    const good = JSON.stringify(packet("good"));
    writeFileSync(join(dir, SPOOL_FILE), `not-json\n\n${good}\n`, "utf8");
    const spool = createSpool({ dir, now: () => new Date(AT) });
    let added = false;
    const result = await spool.drain(async () => {
      if (!added) {
        spool.append(packet("extra"));
        added = true;
      }
    });
    assert.equal(result.sent, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.error, null);
    assert.deepEqual(lines(dir).map((item) => item.summary), ["extra"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
