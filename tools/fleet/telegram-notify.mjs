import { pathToFileURL } from "node:url";

export function buildMessage(notice) {
  const text = `[${notice.severity}] ${notice.title}\n\n${notice.body}`;
  const message = {
    text: text.length > 3900 ? `${text.slice(0, 3897)}...` : text,
    disable_web_page_preview: true,
  };
  if (notice.severity === "info" || notice.kind === "digest") message.disable_notification = true;
  if (Number.isInteger(notice.incidentId) && notice.incidentId > 0 && Array.isArray(notice.actions) && notice.actions.length > 0) {
    message.reply_markup = {
      inline_keyboard: [notice.actions.map((action) => ({
        text: action.label,
        callback_data: `scout:${action.id}:${notice.incidentId}`,
      }))],
    };
  }
  return message;
}

async function readNotice() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("notice exceeds 64 KB");
    chunks.push(chunk);
  }
  let notice;
  try {
    notice = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid notice JSON");
  }
  if (!notice || typeof notice.title !== "string" || !notice.title || typeof notice.body !== "string" || !notice.body) {
    throw new Error("notice requires title and body");
  }
  return notice;
}

function safeLine(text, token) {
  return text.split(token).join("[redacted]").replace(/https?:\/\/\S+/gi, "[redacted]").replace(/[\r\n\u2028\u2029]+/g, " ");
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--token-env", "--chat-env", "--api-base"].includes(flag) || !value || value.startsWith("--") || options[flag] !== undefined) {
      process.stderr.write("usage: telegram-notify.mjs --token-env NAME --chat-env NAME [--api-base URL]\n");
      return 2;
    }
    options[flag] = value;
  }
  if (![options["--token-env"], options["--chat-env"]].every((name) => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.exec(name)?.[0] === name)) {
    process.stderr.write("token and chat environment variable names are required\n");
    return 2;
  }
  for (const flag of ["--token-env", "--chat-env"]) {
    const name = options[flag];
    if (!process.env[name]) {
      process.stderr.write(`${name} is unset\n`);
      return 2;
    }
  }
  const token = process.env[options["--token-env"]];
  let notice;
  try {
    notice = await readNotice();
  } catch (error) {
    const message = ["notice exceeds 64 KB", "invalid notice JSON", "notice requires title and body"].includes(error.message) ? error.message : "could not read notice";
    process.stderr.write(`${safeLine(message, token)}\n`);
    return 2;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const base = (options["--api-base"] ?? "https://api.telegram.org").replace(/\/+$/, "");
    const response = await fetch(`${base}/bot${token}/sendMessage`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: process.env[options["--chat-env"]], ...buildMessage(notice) }),
    });
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (response.ok && result?.ok === true) return 0;
    const description = typeof result?.description === "string" ? result.description : "";
    process.stderr.write(`${response.status}${description ? ` ${safeLine(description, token)}` : ""}\n`);
    return 1;
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    const suffix = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` ${safeLine(code, token)}` : "";
    process.stderr.write(`telegram request failed${suffix}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
