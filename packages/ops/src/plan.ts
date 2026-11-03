import { compareVersions, type ConfirmedDownload, type Transport } from "@scout/core";

export interface PlanInstall { ecosystem: string; key: string; kind: string; version?: string | null; details?: Record<string, unknown> }
export interface PlanMachine { transport: Transport }
export interface UpdatePlan {
  allowed: boolean; refusal: string | null; command: string; argv: string[]; disruptive: boolean; needsAdmin: boolean;
  verify: { argv: string[]; parse: (stdout: string) => string | null };
  /** Runs on the machine just before the update; the update waits while it exits with `busyExit`, and stops on any other failure. */
  guard: { argv: string[]; busyExit: number; busy: string } | null;
}

const ID = /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?)$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const WINDOWS_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?: [A-Za-z0-9._+-]+)*(?: \([A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*\))?$/;
const WINGET_EXTERNAL_UPDATES = new Map<string, { refusal: string; majorChangeOnly?: boolean }>([
  ["MSYS2.MSYS2", { refusal: "MSYS2 updates through its own package manager; run pacman -Syu in the MSYS2 shell, because winget cannot upgrade it." }],
  ["ItchIo.Itch", { refusal: "itch updates itself when it runs, and winget cannot see the new version; open itch to update it." }],
  ["Audacity.Audacity", { refusal: "this version uses a different installer type; uninstall Audacity and install the new version.", majorChangeOnly: true }],
]);
const HAS_UPDATER = new Set(["winget", "msstore", "brew", "cask", "npm", "pipx", "uv-tool", "pacman", "aur", "flatpak"]);
const majorVersion = (version: string | null | undefined): number | null => {
  const match = /^\d+/.exec(version ?? "");
  return match ? Number(match[0]) : null;
};
// pacman names may carry + and @, and its versions an epoch such as 1:2.3-1.
const PACMAN_ID = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/;
const PACMAN_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:~-]*$/;
const versionMatch = (value: string): string | null => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) ? value : null;
const parseBrew = (key: string, stdout: string): string | null => {
  const line = stdout.trim().split(/\r?\n/).find((part) => part.startsWith(`${key} `));
  // Homebrew lists every installed keg on one line; the newest one is what an upgrade produced.
  const versions = (line ? line.slice(key.length + 1).split(/\s+/) : []).map(versionMatch).filter((v): v is string => v !== null);
  return versions.reduce<string | null>((best, v) => best === null || (compareVersions(v, best) ?? 0) > 0 ? v : best, null);
};
const parseWinget = (key: string, stdout: string): string | null => {
  // A full column leaves only one separator; a parenthesized build still belongs to the version.
  const lines = stdout.split(/\r?\n/);
  const header = lines.find((line) => /\bId\s+Version\b/.test(line));
  const start = header?.indexOf("Version") ?? -1;
  const end = header?.search(/\b(?:Available|Source)\b/) ?? -1;
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    const at = tokens.indexOf(key);
    if (at < 0) continue;
    if (start >= 0 && line.slice(0, start).trimEnd().endsWith(key)) {
      const column = line.slice(start, end > start ? end : undefined).trim().replace(/^[<>]\s*/, "");
      if (WINDOWS_VERSION.test(column)) return column;
    }
    const rest = tokens.slice(at + 1).filter((t) => t !== "<" && t !== ">");
    const suffix = rest[1]?.startsWith("(") ? rest.slice(1).join(" ").match(/^\([A-Za-z0-9._+-]+(?: [A-Za-z0-9._+-]+)*\)/)?.[0] : undefined;
    const version = `${rest[0] ?? ""}${suffix ? ` ${suffix}` : ""}`;
    return WINDOWS_VERSION.test(version) ? version : null;
  }
  return null;
};
const parseNpm = (key: string, stdout: string): string | null => {
  try { return versionMatch((JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> }).dependencies?.[key]?.version ?? ""); } catch { return null; }
};
const parsePipx = (key: string, stdout: string): string | null => {
  try {
    const data = JSON.parse(stdout) as { venvs?: Record<string, { metadata?: { main_package?: { package_version?: string } } }> };
    return versionMatch(data.venvs?.[key]?.metadata?.main_package?.package_version ?? "");
  } catch { return null; }
};
const parseUv = (key: string, stdout: string): string | null => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped} v?([^\\s]+)`, "m").exec(stdout);
  return versionMatch(match?.[1] ?? "");
};

// Arch cannot upgrade one package alone, so updating any package row runs the whole-system update: Omarchy's own updater when it
// exists (snapshot, keyring, pacman, AUR, mise, migrations) and a plain pacman and yay upgrade otherwise. Its reboot prompt reads the
// terminal, which is absent here, so it answers no; the runner restarts the machine afterward only when the running kernel was replaced
// and the update ran in the quiet window (see rebootIfNeeded).
const ARCH_UPDATE = "if command -v omarchy-update >/dev/null 2>&1; then omarchy-update -y </dev/null; else sudo -n pacman -Syu --noconfirm </dev/null && { ! command -v yay >/dev/null 2>&1 || yay -Sua --noconfirm </dev/null; }; fi";
const parsePacman = (key: string, stdout: string): string | null => {
  const line = stdout.trim().split(/\r?\n/).find((part) => part.startsWith(`${key} `));
  const version = line ? line.slice(key.length + 1).trim() : "";
  return PACMAN_VERSION.test(version) ? version : null;
};
// Steam wraps every game it launches, in Game Mode and on the desktop alike, in a `reaper SteamLaunch AppId=<id>` process. The bracket keeps
// pgrep from matching the shell that carries this very script. Exit 10 means a game is running, 0 means none, and 2 means pgrep is missing.
export const GAME_GUARD = "command -v pgrep >/dev/null 2>&1 || exit 2; if pgrep -f '[S]teamLaunch AppId=[1-9]' >/dev/null 2>&1; then exit 10; fi; exit 0";
export const GAME_BUSY = "a game is running on this machine; Scout does not update Flatpak apps while one is open. Try again after it closes";
const parseFlatpak = (stdout: string): string | null => versionMatch(/^\s*Version:\s*(\S+)/m.exec(stdout)?.[1] ?? "");
/** True when the kernel the machine is running was replaced by an update: its module folder is gone. */
export const ARCH_NEEDS_REBOOT = "[ ! -d \"/usr/lib/modules/$(uname -r)\" ]";
/** Schedules a restart two minutes out so the job can finish and be read back first; `shutdown -c` cancels it. */
export const ARCH_REBOOT = "sudo -n shutdown -r +2 'Scout: restarting to finish a kernel update'";

export function planUpdate(install: PlanInstall, target: string, machine: PlanMachine | null, running = false): UpdatePlan {
  const disruptive = install.kind === "app" || running || install.ecosystem === "pacman" || install.ecosystem === "aur";
  const arch = install.ecosystem === "pacman" || install.ecosystem === "aur";
  const needsAdmin = install.details?.scope === "machine" || install.details?.needsAdmin === true || install.details?.requiresSudo === true;
  const external = ["winget", "msstore"].includes(install.ecosystem) ? WINGET_EXTERNAL_UPDATES.get(install.key) : undefined;
  const installedMajor = majorVersion(install.version);
  const targetMajor = majorVersion(target);
  let refusal: string | null = null;
  let argv: string[] = [];
  let verify: UpdatePlan["verify"] = { argv: [], parse: () => null };
  let guard: UpdatePlan["guard"] = null;
  if (!machine) refusal = "machine is not configured";
  // An image reference such as ghcr.io/org/name has more path segments than ID allows, so say there is no updater rather than a bad id.
  else if (!HAS_UPDATER.has(install.ecosystem)) refusal = `Scout has no updater for ${install.ecosystem} installs`;
  else if (!(arch ? PACMAN_ID.test(install.key) && PACMAN_VERSION.test(target) : ID.test(install.key) && (["winget", "msstore"].includes(install.ecosystem) ? WINDOWS_VERSION : VERSION).test(target))) refusal = "invalid package id or version";
  else if (external && (!external.majorChangeOnly || installedMajor !== null && targetMajor !== null && installedMajor !== targetMajor)) refusal = external.refusal;
  // winget raises the Windows administrator prompt itself, so Scout can run it only where someone can answer: on this computer.
  else if (needsAdmin && !(["winget", "msstore"].includes(install.ecosystem) && machine.transport.type === "local")) refusal = "needs admin; Scout cannot elevate yet";
  else {
    const key = install.key;
    switch (install.ecosystem) {
      case "winget": case "msstore":
        argv = ["winget", "upgrade", "--id", key, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--version", target];
        if (install.ecosystem === "msstore") argv.push("--source", "msstore");
        verify = { argv: ["winget", "list", "--id", key, "--exact"], parse: (s) => parseWinget(key, s) };
        break;
      case "brew":
        argv = ["brew", "upgrade", key];
        verify = { argv: ["brew", "list", "--versions", key], parse: (s) => parseBrew(key, s) };
        break;
      case "cask":
        argv = ["brew", "upgrade", "--cask", key];
        verify = { argv: ["brew", "list", "--versions", "--cask", key], parse: (s) => parseBrew(key, s) };
        break;
      case "npm":
        argv = ["npm", "install", "-g", `${key}@${target}`];
        verify = { argv: ["npm", "ls", "-g", "--json", key], parse: (s) => parseNpm(key, s) };
        break;
      case "pipx":
        argv = ["pipx", "upgrade", key];
        verify = { argv: ["pipx", "list", "--json"], parse: (s) => parsePipx(key, s) };
        break;
      case "uv-tool":
        argv = ["uv", "tool", "upgrade", key];
        verify = { argv: ["uv", "tool", "list"], parse: (s) => parseUv(key, s) };
        break;
      case "pacman": case "aur":
        argv = ["/bin/sh", "-c", ARCH_UPDATE];
        verify = { argv: ["pacman", "-Q", "--", key], parse: (s) => parsePacman(key, s) };
        break;
      case "flatpak": {
        // The scan records which installation holds the app: a system app is updated through sudo, a user app in the scanning account's own installation.
        const scope = install.details?.installation === "user" ? "user" : "system";
        argv = [...(scope === "system" ? ["sudo", "-n"] : []), "flatpak", "update", "-y", "--noninteractive", `--${scope}`, key];
        verify = { argv: ["flatpak", "info", `--${scope}`, key], parse: parseFlatpak };
        guard = { argv: ["/bin/sh", "-c", GAME_GUARD], busyExit: 10, busy: GAME_BUSY };
        break;
      }
      default: refusal = `Scout has no updater for ${install.ecosystem} installs`;
    }
  }
  return { allowed: refusal === null, refusal, command: argv.join(" "), argv, disruptive, needsAdmin, verify, guard };
}

/** The update command without the pinned version, so the package manager can pick the version it still offers. */
export function withoutVersion(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") { i++; continue; }
    out.push(argv[i]!);
  }
  return out;
}

// Fixed scripts resolve the user's folder on the target; input travels only as positional arguments.
const MAC_DOWNLOAD = `set -eu
part="$HOME/Downloads/$2.part"
set -C
: > "$part"
set +C
printf 'created\\n'
trap 'rm -f -- "$part"' EXIT HUP INT TERM
curl -fL --globoff --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize 2147483648 --output "$part" -- "$1"
trap - EXIT HUP INT TERM`;
const MAC_VERIFY = `set -eu
part="$HOME/Downloads/$1.part"
hash=$(shasum -a 256 -- "$part")
[ -z "$2" ] || [ "\${hash%% *}" = "$2" ] || exit 1
if [ "$3" != unknown ]; then
  zmodload zsh/stat
  zstat -A bytes +size "$part"
  [ "$bytes[1]" = "$3" ] || exit 1
fi
stem="$1"
ext=""
if [[ "$1" = *.* ]]; then stem="\${1%.*}"; ext=".\${1##*.}"; fi
dest="$HOME/Downloads/$1"
n=0
while [ -e "$part" ]; do
  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then mv -n -- "$part" "$dest"; fi
  if [ ! -e "$part" ]; then printf '%s\\n' "$dest"; break; fi
  n=$((n + 1))
  [ "$n" -le 10000 ] || exit 1
  dest="$HOME/Downloads/$stem ($n)$ext"
done`;
const MAC_CLEANUP = `rm -f -- "$HOME/Downloads/$1.part"`;
const WINDOWS_FOLDER = `$folder = (Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders' -ErrorAction Stop).'{374DE290-123F-4565-9164-39C4925E467B}'; if (!$folder) { throw 'Downloads folder is unavailable' }; $folder = [Environment]::ExpandEnvironmentVariables($folder);`;
const WINDOWS_DOWNLOAD = `$ErrorActionPreference = 'Stop'; ${WINDOWS_FOLDER}
$part = Join-Path $folder ($args[1] + '.part');
$stream = [IO.File]::Open($part, [IO.FileMode]::CreateNew); $stream.Dispose(); 'created';
try {
  Invoke-WebRequest -Uri $args[0] -OutFile $part -MaximumRedirection 5 -SslProtocol Tls12,Tls13;
  if ((Get-Item -LiteralPath $part).Length -gt 2147483648) { throw 'File exceeds 2 GiB' }
} catch { Remove-Item -LiteralPath $part -Force; throw }`;
const WINDOWS_VERIFY = `$ErrorActionPreference = 'Stop'; ${WINDOWS_FOLDER}
$part = Join-Path $folder ($args[0] + '.part');
$hash = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant();
if ($args[1] -and $hash -ne $args[1]) { throw 'Checksum differs' }
if ($args[2] -ne 'unknown' -and (Get-Item -LiteralPath $part).Length -ne [long]$args[2]) { throw 'Size differs' }
$stem = [IO.Path]::GetFileNameWithoutExtension($args[0]); $ext = [IO.Path]::GetExtension($args[0]);
$dest = Join-Path $folder $args[0]; $n = 0;
while ($true) {
  try { [IO.File]::Move($part, $dest, $false); $dest; break }
  catch [IO.IOException] { if (!(Test-Path -LiteralPath $dest) -or ++$n -gt 10000) { throw }; $dest = Join-Path $folder ($stem + ' (' + $n + ')' + $ext) }
}`;
const WINDOWS_CLEANUP = `$ErrorActionPreference = 'Stop'; ${WINDOWS_FOLDER} Remove-Item -LiteralPath (Join-Path $folder ($args[0] + '.part')) -Force -ErrorAction SilentlyContinue;`;

export function planDownloadCommands(download: ConfirmedDownload): { download: string[]; verify: string[]; cleanup: string[] } {
  const hash = download.sha256 ?? "";
  const size = download.size === null ? "unknown" : String(download.size);
  const command = (script: string, args: string[]): string[] => download.platform === "macos" ? ["zsh", "-c", script, "scout-download", ...args] : ["pwsh", "-NoProfile", "-NonInteractive", "-CommandWithArgs", script, ...args];
  return {
    download: command(download.platform === "macos" ? MAC_DOWNLOAD : WINDOWS_DOWNLOAD, [download.url, download.fileName]),
    verify: command(download.platform === "macos" ? MAC_VERIFY : WINDOWS_VERIFY, [download.fileName, hash, size]),
    cleanup: command(download.platform === "macos" ? MAC_CLEANUP : WINDOWS_CLEANUP, [download.fileName]),
  };
}
