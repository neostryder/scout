import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, ingest, openCatalog, parsePacket } from "@scout/core";

const script = fileURLToPath(new URL("../../../tools/fleet/scout-run.ps1", import.meta.url));
const heartbeat = fileURLToPath(new URL("../../../tools/fleet/heartbeat.mjs", import.meta.url));

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    // A detached pwsh on Windows exits 0 without running the file, so a waited wrapper stays attached and hidden.
    const child = spawn(file, args, { windowsHide: true, detached: process.platform !== "win32", env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the powershell wrapper redacts stderr, hides the ingest token, and keeps the fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-ps-"));
  try {
    const result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-FleetHost", "Desktop", "-Component", "backup", "--", process.execPath, "-e", "if (process.env.SCOUT_FLEET_TOKEN) process.exit(9); console.error('password=hunter2'); process.exit(3)"], {
      ...process.env,
      SCOUT_FLEET_SPOOL: dir,
      SCOUT_FLEET_TOKEN: "dummy-token-value",
      SCOUT_FLEET_URL: "http://127.0.0.1:9/fleet",
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /fleet post failed/);
    assert.equal(result.stderr.includes("dummy-token-value"), false);
    assert.equal(result.stderr.includes("127.0.0.1"), false);
    const raw = readFileSync(join(dir, "packets.jsonl"), "utf8").trim();
    assert.equal(raw.includes("hunter2"), false);
    assert.match(raw, /\[redacted:secret\]/);
    const parsed = parsePacket(JSON.parse(raw));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.packet.fingerprint, fingerprint("Desktop", "backup", "ran-failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later success writes a recovered packet for the open fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-ps-"));
  try {
    await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-FleetHost", "desktop", "-Component", "backup", "--", process.execPath, "-e", "process.exit(4)"], {
      ...process.env,
      SCOUT_FLEET_SPOOL: dir,
    });
    const again = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-FleetHost", "desktop", "-Component", "backup", "--", process.execPath, "-e", "process.exit(0)"], {
      ...process.env,
      SCOUT_FLEET_SPOOL: dir,
    });
    assert.equal(again.code, 0);
    const rows = readFileSync(join(dir, "packets.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { recovered?: boolean; fingerprint: string; failureClass: string });
    const recovered = rows.find((row) => row.recovered === true);
    assert.ok(recovered);
    assert.equal(recovered?.failureClass, "ran-failed");
    assert.equal(recovered?.fingerprint, fingerprint("desktop", "backup", "ran-failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty stdout is degraded output when output is required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-ps-"));
  try {
    const result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-FleetHost", "desktop", "-Component", "backup", "-ExpectOutput", "--", process.execPath, "-e", "process.exit(0)"], {
      ...process.env,
      SCOUT_FLEET_SPOOL: dir,
    });
    assert.equal(result.code, 0);
    const parsed = parsePacket(JSON.parse(readFileSync(join(dir, "packets.jsonl"), "utf8").trim()));
    assert.equal(parsed.ok && parsed.packet.failureClass, "degraded-output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat.mjs writes a heartbeat the collector records without opening an incident", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-fleet-hb-"));
  const db = openCatalog(":memory:");
  try {
    const result = await run(process.execPath, [heartbeat, "ping", "backup"], { ...process.env, SCOUT_FLEET_SPOOL: dir, SCOUT_FLEET_HOST: "desktop" });
    assert.equal(result.code, 0);
    const parsed = parsePacket(JSON.parse(readFileSync(join(dir, "packets.jsonl"), "utf8").trim()));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.packet.evidence.snapshot?.heartbeat, true);
    assert.equal(parsed.packet.fingerprint, fingerprint("desktop", "backup", "watcher-failure"));
    assert.deepEqual(ingest(db, parsed.packet, parsed.packet.lastSeen), []);
    const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get("fleet_hb:desktop/backup") as { value: string };
    assert.equal(meta.value, parsed.packet.lastSeen);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fleet_incidents").get() && (db.prepare("SELECT COUNT(*) AS n FROM fleet_incidents").get() as { n: number }).n, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
