import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The child of a heartbeat post must not be this process's job. This file only writes and posts.

function fingerprint(host, component, failureClass) {
  const text = [host.toLowerCase(), component.toLowerCase(), failureClass.toLowerCase()].join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function packet(host, component) {
  const now = new Date().toISOString();
  const failureClass = "watcher-failure";
  return {
    version: 1,
    host,
    component,
    severity: "info",
    failureClass,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    fingerprint: fingerprint(host, component, failureClass),
    summary: `heartbeat ${component}`.slice(0, 300),
    evidence: { snapshot: { heartbeat: true } },
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  };
}

function writeSpool(dir, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "packets.jsonl");
  appendFileSync(path, `${body}\n`);
  return path;
}

function removeLine(path, body) {
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return; }
  const lines = raw.split(/\r?\n/).filter((line) => line !== "" && line !== body);
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

async function post(url, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
    });
    if (!response.ok) throw new Error("status");
    return true;
  } catch {
    process.stderr.write("fleet post failed\n");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const command = process.argv[2];
const name = process.argv[3];
if (command !== "ping" || !name) {
  process.stderr.write("usage: heartbeat.mjs ping <name>\n");
  process.exit(2);
}

const host = process.env.SCOUT_FLEET_HOST || "localhost";
const body = JSON.stringify(packet(host, name));
const spool = process.env.SCOUT_FLEET_SPOOL;
const path = spool ? writeSpool(spool, body) : null;
const url = process.env.SCOUT_FLEET_URL;
const token = process.env.SCOUT_FLEET_TOKEN;
if (url && token) {
  const ok = await post(url, token, body);
  if (ok && path) removeLine(path, body);
}
