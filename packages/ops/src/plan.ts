import { compareVersions, type ConfirmedDownload, type Transport } from "@scout/core";

export interface PlanInstall { ecosystem: string; key: string; kind: string; details?: Record<string, unknown> }
export interface PlanMachine { transport: Transport }
export interface UpdatePlan {
  allowed: boolean; refusal: string | null; command: string; argv: string[]; disruptive: boolean; needsAdmin: boolean;
  verify: { argv: string[]; parse: (stdout: string) => string | null };
}

const ID = /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?)$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const versionMatch = (value: string): string | null => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) ? value : null;
const parseBrew = (key: string, stdout: string): string | null => {
  const line = stdout.trim().split(/\r?\n/).find((part) => part.startsWith(`${key} `));
  // Homebrew lists every installed keg on one line; the newest one is what an upgrade produced.
  const versions = (line ? line.slice(key.length + 1).split(/\s+/) : []).map(versionMatch).filter((v): v is string => v !== null);
  return versions.reduce<string | null>((best, v) => best === null || (compareVersions(v, best) ?? 0) > 0 ? v : best, null);
};
const parseWinget = (key: string, stdout: string): string | null => {
  // Columns are fixed-width with a single space when a value fills its column, so split on any whitespace: an id has no spaces and the version follows it.
  for (const line of stdout.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const at = tokens.indexOf(key);
    if (at < 0) continue;
    const version = tokens.slice(at + 1).find((t) => t !== "<" && t !== ">");
    return versionMatch(version ?? "");
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

export function planUpdate(install: PlanInstall, target: string, machine: PlanMachine | null, running = false): UpdatePlan {
  const disruptive = install.kind === "app" || running;
  const needsAdmin = install.details?.scope === "machine" || install.details?.needsAdmin === true || install.details?.requiresSudo === true;
  let refusal: string | null = null;
  let argv: string[] = [];
  let verify: UpdatePlan["verify"] = { argv: [], parse: () => null };
  if (!machine) refusal = "machine is not configured";
  else if (!ID.test(install.key) || !VERSION.test(target)) refusal = "invalid package id or version";
  else if (needsAdmin) refusal = "needs admin; Scout cannot elevate yet";
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
      default: refusal = `Scout has no updater for ${install.ecosystem} installs`;
    }
  }
  return { allowed: refusal === null, refusal, command: argv.join(" "), argv, disruptive, needsAdmin, verify };
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
