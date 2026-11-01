import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { FleetNotice } from "../../core/src/fleet-ports.ts";

const notifyUrl = new URL("../../../tools/fleet/telegram-notify.mjs", import.meta.url);
const actionUrl = new URL("../../../tools/fleet/telegram-action.mjs", import.meta.url);
const { buildMessage } = await import(notifyUrl.href);
const { parseCallback } = await import(actionUrl.href);
const token = randomBytes(24).toString("hex");
const chat = randomBytes(12).toString("hex");
const env = { SCOUT_TEST_TELEGRAM_TOKEN: token, SCOUT_TEST_TELEGRAM_CHAT: chat };
const notifyArgs = ["--token-env", "SCOUT_TEST_TELEGRAM_TOKEN", "--chat-env", "SCOUT_TEST_TELEGRAM_CHAT"];

function notice(overrides: Partial<FleetNotice> = {}): FleetNotice {
  return {
    title: "Backup failed",
    body: "The scheduled backup stopped.",
    severity: "critical",
    incidentId: 42,
    kind: "incident",
    actions: [{ id: "investigate", label: "Investigate" }, { id: "snooze", label: "Snooze" }, { id: "mute", label: "Mute" }],
    ...overrides,
  };
}

function run(script: URL, args: string[], stdin = "", overrides: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(script), ...args], {
      windowsHide: true,
      env: { ...process.env, ...env, ...overrides },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function server(t: TestContext, status = 200, response: unknown = { ok: true }) {
  const requests: { method: string | undefined; path: string | undefined; contentType: string | undefined; raw: string }[] = [];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    requests.push({ method: req.method, path: req.url, contentType: req.headers["content-type"], raw });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    if (!http.listening) return;
    return new Promise<void>((resolve, reject) => {
      http.closeAllConnections();
      http.close((error) => error ? reject(error) : resolve());
    });
  });
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests, http };
}

test("message layout uses plain text and truncates at 3900 characters", () => {
  const message = buildMessage(notice());
  assert.equal(message.text, "[critical] Backup failed\n\nThe scheduled backup stopped.");
  assert.equal(message.disable_web_page_preview, true);
  assert.equal("parse_mode" in message, false);
  const prefix = "[critical] Backup failed\n\n";
  const exact = buildMessage(notice({ body: "x".repeat(3900 - prefix.length) }));
  assert.equal(exact.text.length, 3900);
  assert.equal(exact.text.endsWith("..."), false);
  const long = buildMessage(notice({ body: "x".repeat(5000) }));
  assert.equal(long.text.length, 3900);
  assert.equal(long.text, `${prefix}${"x".repeat(3897 - prefix.length)}...`);
});

test("buttons require a positive integer incident and non-empty actions", () => {
  assert.deepEqual(buildMessage(notice()).reply_markup, {
    inline_keyboard: [[
      { text: "Investigate", callback_data: "scout:investigate:42" },
      { text: "Snooze", callback_data: "scout:snooze:42" },
      { text: "Mute", callback_data: "scout:mute:42" },
    ]],
  });
  for (const incidentId of [null, 0, -1, 1.5]) {
    assert.equal("reply_markup" in buildMessage(notice({ incidentId })), false);
  }
  assert.equal("reply_markup" in buildMessage(notice({ actions: [] })), false);
});

test("info and digest notices are silent and critical incidents send normally", () => {
  assert.equal(buildMessage(notice({ severity: "info" })).disable_notification, true);
  assert.equal(buildMessage(notice({ kind: "digest" })).disable_notification, true);
  assert.equal("disable_notification" in buildMessage(notice()), false);
});

test("notifier posts the message and credentials to Telegram", async (t) => {
  const mock = await server(t);
  const result = await run(notifyUrl, [...notifyArgs, "--api-base", `${mock.url}/`], JSON.stringify(notice()));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(mock.requests.length, 1);
  const request = mock.requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.path === `/bot${token}/sendMessage`, true);
  assert.equal(request.contentType, "application/json");
  const { chat_id, ...message } = JSON.parse(request.raw);
  assert.equal(chat_id === chat, true);
  assert.deepEqual(message, buildMessage(notice()));
});

for (const status of [200, 401]) {
  test(`notifier reports Telegram failure at HTTP ${status} without leaking the token`, async (t) => {
    const mock = await server(t, status, { ok: false, description: `Unauthorized\nhttps://api.telegram.org/bot${token}/sendMessage ${token}` });
    const result = await run(notifyUrl, [...notifyArgs, "--api-base", mock.url], JSON.stringify(notice()));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(token), false);
    assert.equal(result.stderr, `${status} Unauthorized [redacted] [redacted]\n`);
  });
}

test("notifier hides the token when the connection is refused", async (t) => {
  const mock = await server(t);
  await new Promise<void>((resolve, reject) => mock.http.close((error) => error ? reject(error) : resolve()));
  const result = await run(notifyUrl, [...notifyArgs, "--api-base", mock.url], JSON.stringify(notice()));
  assert.equal(result.code, 1);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^telegram request failed(?: ECONNREFUSED)?\n$/);
});

for (const name of Object.keys(env)) {
  test(`notifier names the unset variable ${name}`, async () => {
    const result = await run(notifyUrl, notifyArgs, JSON.stringify(notice()), { [name]: "" });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${name} is unset\n`);
  });
}

test("notifier rejects invalid JSON, missing text, and more than 64 KB", async (t) => {
  for (const input of ["{", "null", "{}", JSON.stringify({ title: "Title" }), JSON.stringify({ body: "Body" }), "x".repeat(65537)]) {
    const result = await run(notifyUrl, notifyArgs, input);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^(invalid notice JSON|notice requires title and body|notice exceeds 64 KB)\n$/);
  }
  const prefix = '{"title":"Title","body":"';
  const suffix = '"}';
  const exact = `${prefix}${"x".repeat(65536 - prefix.length - suffix.length)}${suffix}`;
  const mock = await server(t);
  const result = await run(notifyUrl, [...notifyArgs, "--api-base", mock.url], exact);
  assert.equal(result.code, 0);
});

test("callback parser accepts only the three actions and strict positive ids", () => {
  for (const action of ["investigate", "snooze", "mute"]) {
    assert.deepEqual(parseCallback(`scout:${action}:42`), { action, incidentId: 42 });
  }
  assert.deepEqual(parseCallback("scout:mute:9999999999"), { action: "mute", incidentId: 9999999999 });
  for (const data of ["scout:investigate:0", "scout:other:1", "scout:mute:1\n", "scout:mute:10000000000", "scout:mute:01", "scout:mute:-1", " scout:mute:1", "scout:mute:1\r\n", "", null]) {
    assert.equal(parseCallback(data), null);
  }
});

for (const action of ["investigate", "snooze", "mute"] as const) {
  test(`relay posts ${action} to the matching hub route`, async (t) => {
    const mock = await server(t, 200, action === "investigate" ? { ok: true } : { incident: { id: 42 } });
    const result = await run(actionUrl, [`scout:${action}:42`, "--hub", `${mock.url}/`]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const messages = { investigate: "Investigation started.", snooze: "Snoozed for an hour.", mute: "Muted this rule." };
    assert.equal(result.stdout, `${JSON.stringify({ ok: true, action, incidentId: 42, message: messages[action] })}\n`);
    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.path, `/api/fleet/incidents/42/${action}`);
    if (action === "investigate") {
      assert.equal(request.raw, "");
    } else {
      assert.equal(request.contentType, "application/json");
      assert.deepEqual(JSON.parse(request.raw), action === "snooze" ? { minutes: 60 } : { reason: "muted from Telegram" });
    }
  });
}

test("relay includes a valid actor in the mute reason", async (t) => {
  const mock = await server(t);
  const actor = "Test_actor 1.-";
  const result = await run(actionUrl, ["scout:mute:42", "--hub", mock.url, "--actor", actor]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(mock.requests[0]!.raw), { reason: `muted from Telegram by ${actor}` });
});

test("relay rejects invalid callbacks and actors as usage errors", async () => {
  for (const args of [["scout:other:1"], ["scout:mute:1\n"], ["scout:mute:1", "--actor", "x".repeat(41)], ["scout:mute:1", "--actor", "invalid/name"], ["scout:mute:1", "--actor", "actor\n"], ["scout:mute:1", "--hub"]]) {
    const result = await run(actionUrl, args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^usage: [^\n]+\n$/);
  }
});

for (const [status, response] of [[404, { error: "not found" }], [501, { error: "no investigator configured" }], [200, { ok: false, error: "investigation failed" }]] as const) {
  test(`relay reports the hub error at HTTP ${status}`, async (t) => {
    const mock = await server(t, status, response);
    const result = await run(actionUrl, ["scout:investigate:42", "--hub", mock.url]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${JSON.stringify({ ok: false, action: "investigate", incidentId: 42, message: response.error })}\n`);
  });
}
