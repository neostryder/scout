import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutageNotice } from "@scout/core";

// Notices leave the hub two ways: a Discord webhook whose address lives only in the environment (SCOUT_DISCORD_WEBHOOK), and a desktop
// notification on the hub machine. Neither address nor text is ever written to a tracked file, and the webhook address is never logged.

export interface ChannelResult { channel: "discord" | "desktop"; ok: boolean; error: string | null }
export interface NotifierOptions {
  webhook?: () => string | undefined;
  fetch?: typeof fetch;
  desktop?: (notice: OutageNotice) => Promise<void>;
  log?: (line: string) => void;
}

const WEBHOOK = /^https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

/** The script reads its text from the environment, so nothing a notice says can become a command. Windows needs no module: a tray balloon shows as a toast. */
const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing",
  "$n = New-Object System.Windows.Forms.NotifyIcon",
  "$n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true",
  "$n.ShowBalloonTip(15000, $env:SCOUT_NOTICE_TITLE, $env:SCOUT_NOTICE_BODY, [System.Windows.Forms.ToolTipIcon]::Warning)",
  "Start-Sleep -Seconds 16; $n.Dispose()",
].join("; ");

const MAC_SCRIPT = 'display notification (system attribute "SCOUT_NOTICE_BODY") with title (system attribute "SCOUT_NOTICE_TITLE")';

export function desktopNotice(notice: OutageNotice): Promise<void> {
  const title = notice.title.slice(0, 120);
  const body = notice.body.slice(0, 400);
  const env = { ...process.env, SCOUT_NOTICE_TITLE: title, SCOUT_NOTICE_BODY: body };
  const [file, args]: [string, string[]] =
    process.platform === "win32" ? ["pwsh", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT]] :
    process.platform === "darwin" ? ["osascript", ["-e", MAC_SCRIPT]] :
    ["notify-send", [title, body]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** On Windows the address may sit in .scout-data/discord-webhook.dpapi, encrypted for this user with DPAPI, so no logon-task script has to hold it. */
const STORED_WEBHOOK = join(dirname(fileURLToPath(import.meta.url)), "../../../.scout-data/discord-webhook.dpapi");
const DECRYPT_SCRIPT = "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString (Get-Content -Raw -LiteralPath $env:SCOUT_STORED_WEBHOOK).Trim())))";

export function readStoredWebhook(path: string = STORED_WEBHOOK, decrypt: (path: string) => string = decryptWithDpapi): string | undefined {
  if (process.platform !== "win32" || !existsSync(path)) return undefined;
  try { return decrypt(path).trim() || undefined; } catch { return undefined; }
}

function decryptWithDpapi(path: string): string {
  return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", DECRYPT_SCRIPT], { env: { ...process.env, SCOUT_STORED_WEBHOOK: path }, encoding: "utf8", windowsHide: true, timeout: 15_000 });
}

export class Notifier {
  private options: NotifierOptions;
  private stored: string | undefined;

  constructor(options: NotifierOptions = {}) {
    this.options = options;
  }

  private webhook(): string | undefined {
    if (this.options.webhook !== undefined) return this.options.webhook()?.trim() || undefined;
    const fromEnv = process.env["SCOUT_DISCORD_WEBHOOK"]?.trim();
    if (fromEnv) return fromEnv;
    this.stored ??= readStoredWebhook();
    return this.stored;
  }

  /** Which channels are set up, for the page. */
  channels(): { discord: boolean; desktop: boolean } {
    return { discord: this.webhook() !== undefined, desktop: true };
  }

  async send(notice: OutageNotice): Promise<ChannelResult[]> {
    const results: ChannelResult[] = [];
    const url = this.webhook();
    if (url !== undefined) {
      try {
        if (!WEBHOOK.test(url)) throw new Error("SCOUT_DISCORD_WEBHOOK is not a Discord webhook address");
        const response = await (this.options.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `**${notice.title}**\n${notice.body}`.slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Discord answered ${response.status}`);
        results.push({ channel: "discord", ok: true, error: null });
      } catch (err) { results.push({ channel: "discord", ok: false, error: err instanceof Error ? err.message : "send failed" }); }
    }
    try {
      await (this.options.desktop ?? desktopNotice)(notice);
      results.push({ channel: "desktop", ok: true, error: null });
    } catch (err) { results.push({ channel: "desktop", ok: false, error: err instanceof Error ? err.message : "notification failed" }); }
    for (const result of results) if (!result.ok) (this.options.log ?? console.error)(`notice not delivered (${result.channel}): ${result.error}`);
    return results;
  }
}
