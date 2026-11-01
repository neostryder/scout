import { pathToFileURL } from "node:url";

export function parseCallback(data) {
  if (typeof data !== "string") return null;
  const match = /^scout:(investigate|snooze|mute):([1-9][0-9]{0,9})$/.exec(data);
  if (!match || match[0] !== data) return null;
  return { action: match[1], incidentId: Number(match[2]) };
}

async function main() {
  const callback = parseCallback(process.argv[2]);
  const args = process.argv.slice(3);
  const options = {};
  let valid = callback !== null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--hub", "--actor", "--token-env"].includes(flag) || !value || value.startsWith("--") || options[flag] !== undefined) {
      valid = false;
      break;
    }
    options[flag] = value;
  }
  const actor = options["--actor"];
  if (actor !== undefined && /^[A-Za-z0-9 _.-]{1,40}$/.exec(actor)?.[0] !== actor) valid = false;
  const tokenName = options["--token-env"] ?? "SCOUT_FLEET_INGEST_TOKEN";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenName)) valid = false;
  if (!valid) {
    process.stderr.write("usage: telegram-action.mjs <callback_data> [--hub URL] [--actor NAME] [--token-env NAME]\n");
    return 2;
  }
  const { action, incidentId } = callback;
  const token = process.env[tokenName];
  if (!token) {
    process.stderr.write(`${tokenName} is unset\n`);
    return 2;
  }
  const body = { incidentId, action, ...(actor === undefined ? {} : { actor }) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), action === "investigate" ? 120_000 : 15_000);
  let ok = false;
  let message = "hub request failed";
  try {
    const base = (options["--hub"] ?? "http://127.0.0.1:4870").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/fleet/actions`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = null; }
    ok = response.ok && result?.ok === true;
    message = response.status === 401 ? "hub refused the token"
      : response.status === 503 ? "hub has no ingest token configured"
      : typeof result?.message === "string" ? result.message : `hub status ${response.status}`;
    message = message.split(token).join("[redacted]");
  } catch {
    message = "hub request failed";
  } finally {
    clearTimeout(timer);
  }
  process.stdout.write(`${JSON.stringify({ ok, action, incidentId, message })}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
