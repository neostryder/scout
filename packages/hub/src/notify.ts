import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutageNotice } from "@scout/core";

// Notices leave the hub two ways: a Discord webhook whose address lives only in the environment (SCOUT_DISCORD_WEBHOOK), and a desktop
// notification on the hub machine. Neither address nor text is ever written to a tracked file, and the webhook address is never logged.

export interface ChannelResult { channel: "discord" | "desktop" | "cresset"; ok: boolean; error: string | null }
export interface NotifierOptions {
  webhook?: () => string | undefined;
  readStored?: () => string | undefined;
  fetch?: typeof fetch;
  desktop?: (notice: OutageNotice) => Promise<void>;
  /** Sends the notice to Cresset. Resolves false when Scout is not set up as a Cresset sender, so nothing was sent. */
  cresset?: (notice: OutageNotice) => Promise<boolean>;
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

let storedMemo: { value: string | undefined } | undefined;

export function resetStoredWebhook(): void {
  storedMemo = undefined;
}

/** The sender name Scout posts under. Cresset takes notices only from a sender that the client kit config lists for it. */
export const CRESSET_SENDER = "scout-notify";
const CRESSET_SEVERITY = { high: "error", warn: "warning", info: "info" } as const;

interface CressetKit { kit: string; sender: string }

/** The client kit and sender to use, or null while the kit config has no active `scout-notify` sender (absent, or mode direct). */
export function cressetKit(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (path) => readFileSync(path, "utf8")): CressetKit | null {
  const home = env["CRESSET_HOME"] ?? join(homedir(), ".cresset");
  const configPath = env["CRESSET_CONFIG"] ?? join(home, "cresset.json");
  try {
    const config = JSON.parse(read(configPath)) as { default_mode?: unknown; senders?: Record<string, { mode?: unknown }> };
    const entry = config.senders?.[CRESSET_SENDER];
    if (!entry) return null;
    const mode = typeof entry.mode === "string" ? entry.mode : typeof config.default_mode === "string" ? config.default_mode : "direct";
    return mode === "direct" ? null : { kit: join(dirname(configPath), "cresset-notify.mjs"), sender: CRESSET_SENDER };
  } catch { return null; }
}

/** Hands one notice to the Cresset client kit. In both mode Scout's own channels have already run, so the kit only posts to Cresset and spools the post when Cresset cannot be reached. */
export function cressetNotice(notice: OutageNotice, kit: CressetKit | null = cressetKit()): Promise<boolean> {
  if (kit === null) return Promise.resolve(false);
  const args = [kit.kit, "send", "--sender", kit.sender, "--title", notice.title, "--description", notice.body, "--severity", CRESSET_SEVERITY[notice.severity], "--component", "scout", "--class", "outage"];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { windowsHide: true, timeout: 30_000 }, (error) => {
      // Exit 1 means nothing was delivered but the kit spooled the post for its next run; only a usage or config error (2) is lost.
      if (error && (error as { code?: unknown }).code !== 1) reject(error);
      else resolve(true);
    });
  });
}

export class Notifier {
  private options: NotifierOptions;

  constructor(options: NotifierOptions = {}) {
    this.options = options;
  }

  private webhook(): string | undefined {
    if (this.options.webhook !== undefined) return this.options.webhook()?.trim() || undefined;
    const fromEnv = process.env["SCOUT_DISCORD_WEBHOOK"]?.trim();
    if (fromEnv) return fromEnv;
    storedMemo ??= { value: (this.options.readStored ?? readStoredWebhook)() };
    return storedMemo.value;
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
    const cresset = this.options.cresset ?? (this.options.desktop === undefined && this.options.fetch === undefined ? cressetNotice : undefined);
    if (cresset) {
      try { if (await cresset(notice)) results.push({ channel: "cresset", ok: true, error: null }); }
      catch (err) { results.push({ channel: "cresset", ok: false, error: err instanceof Error ? err.message : "cresset send failed" }); }
    }
    for (const result of results) if (!result.ok) (this.options.log ?? console.error)(`notice not delivered (${result.channel}): ${result.error}`);
    return results;
  }
}
