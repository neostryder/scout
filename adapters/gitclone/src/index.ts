import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// The script text is byte-identical to the checked-in probe. A remote machine does not have this repository.
const GITCLONE_PS1 = "# Read-only. Roots are arguments. A missing git is a marker, not a failure.\n# node_modules and names starting with \"_\" or \".\" are not entered. The root\n# argument itself is always entered. A .git file is a worktree or submodule.\n# Each repository runs in a job so a hung git cannot stall the scan.\n$ErrorActionPreference = 'Continue'\n$PSNativeCommandUseErrorActionPreference = $false\n$ProgressPreference = 'SilentlyContinue'\n$roots = @($args)\n\nif (-not (Get-Command git -ErrorAction SilentlyContinue)) {\n  Write-Output '---SCOUT-NO-GIT---'\n  exit 0\n}\n\n$env:GIT_OPTIONAL_LOCKS = '0'\n$env:GIT_TERMINAL_PROMPT = '0'\n\nfunction Expand-Root([string]$root) {\n  if ($root -eq '~') { return $env:USERPROFILE }\n  if ($root.StartsWith('~/') -or $root.StartsWith('~\\')) {\n    return (Join-Path $env:USERPROFILE $root.Substring(2))\n  }\n  return $root\n}\n\nfunction Test-SkippedName([string]$name) {\n  return ($name -eq 'node_modules' -or $name.StartsWith('_') -or $name.StartsWith('.'))\n}\n\nfunction Convert-Forward([string]$path) {\n  return ([IO.Path]::GetFullPath($path)).Replace('\\', '/')\n}\n\nfunction Invoke-Repo([string]$dir) {\n  $full = Convert-Forward $dir\n  $job = Start-Job -ArgumentList $full -ScriptBlock {\n    param($path)\n    $ErrorActionPreference = 'Continue'\n    $PSNativeCommandUseErrorActionPreference = $false\n    $env:GIT_OPTIONAL_LOCKS = '0'\n    $env:GIT_TERMINAL_PROMPT = '0'\n    function Git-Line([string]$repo, [string[]]$gitArgs) {\n      $output = & git -C $repo @gitArgs 2>$null\n      if ($LASTEXITCODE -ne 0 -or $null -eq $output) { return '' }\n      $line = @($output) | Select-Object -First 1\n      return (\"$line\").Trim().Trim(\"`r\")\n    }\n    function Strip-Userinfo([string]$remote) {\n      if ($remote -match '^([a-zA-Z][a-zA-Z0-9.-]*://)[^/@]*:[^@]*@(.*)$') {\n        return ($Matches[1] + $Matches[2])\n      }\n      return $remote\n    }\n    $remote = Git-Line $path @('remote', 'get-url', 'origin')\n    if (-not $remote) {\n      $names = & git -C $path remote 2>$null\n      if ($LASTEXITCODE -eq 0 -and $names) {\n        $first = @($names) | Select-Object -First 1\n        if ($first) { $remote = Git-Line $path @('remote', 'get-url', \"$first\") }\n      }\n    }\n    $remote = Strip-Userinfo \"$remote\"\n    $commit = Git-Line $path @('rev-parse', 'HEAD')\n    $branch = Git-Line $path @('symbolic-ref', '--short', 'HEAD')\n    $default = Git-Line $path @('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')\n    $describe = Git-Line $path @('describe', '--tags', '--always', '--long')\n    $status = & git -C $path status --porcelain 2>$null\n    $dirty = 0\n    if ($LASTEXITCODE -eq 0 -and $null -ne $status) {\n      $dirty = @($status | Where-Object { \"$_\".Trim() -ne '' }).Count\n    }\n    $abText = & git -C $path rev-list --left-right --count 'HEAD...@{upstream}' 2>$null\n    $ahead = ''\n    $behind = ''\n    if ($LASTEXITCODE -eq 0 -and $abText) {\n      $parts = (\"$abText\").Trim() -split '\\s+'\n      if ($parts.Count -ge 2) { $ahead = $parts[0]; $behind = $parts[1] }\n    }\n    $committed = Git-Line $path @('log', '-1', '--format=%cI')\n    $tag = Git-Line $path @('describe', '--tags', '--abbrev=0')\n    Write-Output ('remote=' + $remote)\n    Write-Output ('commit=' + $commit)\n    Write-Output ('branch=' + $branch)\n    Write-Output ('default=' + $default)\n    Write-Output ('describe=' + $describe)\n    Write-Output ('dirty=' + $dirty)\n    Write-Output ('ahead=' + $ahead)\n    Write-Output ('behind=' + $behind)\n    Write-Output ('committed=' + $committed)\n    Write-Output ('tag=' + $tag)\n  }\n  $done = Wait-Job -Job $job -Timeout 20\n  if (-not $done) {\n    Stop-Job -Job $job -ErrorAction SilentlyContinue\n    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue\n    Write-Output '---SCOUT-SKIP---'\n    Write-Output ('path=' + $full)\n    Write-Output 'reason=timeout'\n    return\n  }\n  Write-Output '---SCOUT-REPO---'\n  Write-Output ('path=' + $full)\n  Receive-Job -Job $job | ForEach-Object { Write-Output \"$_\" }\n  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue\n}\n\nfunction Scan-Dir([string]$dir, [int]$depth, [bool]$explicit) {\n  if (-not (Test-Path -LiteralPath $dir)) { return }\n  $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue\n  if (-not $item) { return }\n  if (-not $explicit -and $item.LinkType) { return }\n  if (-not $explicit -and (Test-SkippedName $item.Name)) { return }\n  $gitPath = Join-Path $dir '.git'\n  if (Test-Path -LiteralPath $gitPath) {\n    $gitItem = Get-Item -LiteralPath $gitPath -Force -ErrorAction SilentlyContinue\n    if ($gitItem -and $gitItem.PSIsContainer -and -not $gitItem.LinkType) { Invoke-Repo $dir }\n    return\n  }\n  if ($depth -ge 3) { return }\n  foreach ($child in @(Get-ChildItem -LiteralPath $dir -Force -Directory -ErrorAction SilentlyContinue)) {\n    Scan-Dir $child.FullName ($depth + 1) $false\n  }\n}\n\nforeach ($raw in $roots) {\n  if (-not $raw) { continue }\n  Scan-Dir (Expand-Root \"$raw\") 0 $true\n}\nexit 0\n";
const GITCLONE_SH = "# Read-only. Roots are arguments. A missing git is a marker, not a failure.\n# node_modules and names starting with \"_\" or \".\" are not entered. The root\n# argument itself is always entered. A .git file is a worktree or submodule.\n# GNU timeout is used when it exists. macOS often does not ship it.\n\nif ! command -v git >/dev/null 2>&1; then\n  printf '%s\\n' '---SCOUT-NO-GIT---'\n  exit 0\nfi\n\nexport GIT_OPTIONAL_LOCKS=0\nexport GIT_TERMINAL_PROMPT=0\n\nhave_timeout=0\nif command -v timeout >/dev/null 2>&1 && timeout --version >/dev/null 2>&1; then\n  have_timeout=1\nfi\n\nexpand_root() {\n  case \"$1\" in\n    '~') printf '%s\\n' \"$HOME\" ;;\n    '~/'*) printf '%s\\n' \"$HOME/${1#??}\" ;;\n    *) printf '%s\\n' \"$1\" ;;\n  esac\n}\n\nrun20() {\n  if [ \"$have_timeout\" -eq 1 ]; then\n    timeout 20 \"$@\"\n    return $?\n  fi\n  \"$@\" &\n  pid=$!\n  i=0\n  while [ \"$i\" -lt 20 ]; do\n    if ! kill -0 \"$pid\" 2>/dev/null; then\n      wait \"$pid\"\n      return $?\n    fi\n    i=$((i + 1))\n    sleep 1\n  done\n  kill \"$pid\" 2>/dev/null\n  wait \"$pid\" 2>/dev/null\n  return 124\n}\n\nemit_repo() {\n  # local keeps a nested walk from clobbering the caller's directory.\n  local dir=$1\n  local abs inspect rc\n  abs=$(CDPATH= cd \"$dir\" && pwd -P) || return 0\n  inspect=$(run20 sh -c '\ndir=$1\nexport GIT_OPTIONAL_LOCKS=0\nexport GIT_TERMINAL_PROMPT=0\nfirst() { printf \"%s\\n\" \"$1\" | head -n 1 | tr -d \"\\r\"; }\nremote=$(git -C \"$dir\" remote get-url origin 2>/dev/null || true)\nif [ -z \"$remote\" ]; then\n  name=$(git -C \"$dir\" remote 2>/dev/null | head -n 1 | tr -d \"\\r\")\n  if [ -n \"$name\" ]; then\n    remote=$(git -C \"$dir\" remote get-url \"$name\" 2>/dev/null || true)\n  fi\nfi\ncase \"$remote\" in\n  *://*:*@*)\n    scheme=${remote%%://*}\n    rest=${remote#*://}\n    rest=${rest#*@}\n    remote=\"$scheme://$rest\"\n    ;;\nesac\nremote=$(first \"$remote\")\ncommit=$(first \"$(git -C \"$dir\" rev-parse HEAD 2>/dev/null || true)\")\nbranch=$(first \"$(git -C \"$dir\" symbolic-ref --short HEAD 2>/dev/null || true)\")\ndefault=$(first \"$(git -C \"$dir\" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)\")\ndescribe=$(first \"$(git -C \"$dir\" describe --tags --always --long 2>/dev/null || true)\")\ndirty=$(git -C \"$dir\" status --porcelain 2>/dev/null | wc -l | tr -d \" \\r\")\nab=$(git -C \"$dir\" rev-list --left-right --count \"HEAD...@{upstream}\" 2>/dev/null || true)\nahead=\nbehind=\nset -- $ab\nahead=${1-}\nbehind=${2-}\ncommitted=$(first \"$(git -C \"$dir\" log -1 --format=%cI 2>/dev/null || true)\")\ntag=$(first \"$(git -C \"$dir\" describe --tags --abbrev=0 2>/dev/null || true)\")\nprintf \"remote=%s\\ncommit=%s\\nbranch=%s\\ndefault=%s\\ndescribe=%s\\ndirty=%s\\nahead=%s\\nbehind=%s\\ncommitted=%s\\ntag=%s\\n\" \"$remote\" \"$commit\" \"$branch\" \"$default\" \"$describe\" \"$dirty\" \"$ahead\" \"$behind\" \"$committed\" \"$tag\"\n' _ \"$abs\")\n  rc=$?\n  if [ \"$rc\" -eq 124 ]; then\n    printf '%s\\n' '---SCOUT-SKIP---' \"path=$abs\" 'reason=timeout'\n    return 0\n  fi\n  printf '%s\\n' '---SCOUT-REPO---' \"path=$abs\"\n  printf '%s\\n' \"$inspect\"\n}\n\nscan_dir() {\n  # local keeps the caller's depth. A shared depth stops the walk at the first nested directory.\n  local dir=$1\n  local depth=$2\n  local explicit=$3\n  local name child\n  if [ ! -d \"$dir\" ]; then\n    return 0\n  fi\n  if [ \"$explicit\" != 1 ] && [ -L \"$dir\" ]; then\n    return 0\n  fi\n  name=${dir##*/}\n  if [ \"$explicit\" != 1 ]; then\n    case \"$name\" in\n      node_modules|_*|.*) return 0 ;;\n    esac\n  fi\n  if [ -d \"$dir/.git\" ] && [ ! -L \"$dir/.git\" ]; then\n    emit_repo \"$dir\"\n    return 0\n  fi\n  if [ -e \"$dir/.git\" ]; then\n    return 0\n  fi\n  if [ \"$depth\" -ge 3 ]; then\n    return 0\n  fi\n  for child in \"$dir\"/* \"$dir\"/.[!.]* \"$dir\"/..?*; do\n    if [ -d \"$child\" ] && [ ! -L \"$child\" ]; then\n      scan_dir \"$child\" $((depth + 1)) 0\n    fi\n  done\n}\n\nfor raw in \"$@\"; do\n  root=$(expand_root \"$raw\")\n  scan_dir \"$root\" 0 1\ndone\nexit 0\n";

const FORGES = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);
const TAGGED = /^(.*)-(\d+)-g[0-9a-f]+$/i;

export function stripUserinfo(remote: string): string {
  return remote.trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, "$1");
}

function splitRemote(remote: string): { host: string; path: string } | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)) {
    try {
      const url = new URL(remote);
      const host = url.hostname.toLowerCase();
      if (host === "") return null;
      let path = url.pathname;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        // A broken escape is still a path.
      }
      return { host, path: path.replace(/^\/+/, "") };
    } catch {
      return null;
    }
  }
  // A host without a dot would also match a Windows drive path, so scp form requires one.
  const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(remote);
  const host = scp?.[1];
  const path = scp?.[2];
  if (host?.includes(".") && path !== undefined) return { host: host.toLowerCase(), path };
  return null;
}

export function normalizeRemote(remote: string, location: string): { key: string; name: string; homepage: string | null; remote: string } | null {
  const cleaned = stripUserinfo(remote);
  if (cleaned === "") return null;
  const folder = location.split("/").filter(Boolean).pop() ?? cleaned;
  const parsed = splitRemote(cleaned);
  const path = parsed?.path.replace(/\/+$/, "").replace(/\.git$/i, "") ?? "";
  if (!parsed || parsed.host === "" || path === "") {
    const segment = cleaned.split("/").filter(Boolean).pop();
    return { key: cleaned, name: segment && segment !== cleaned ? segment : folder, homepage: null, remote: cleaned };
  }
  const name = path.split("/").filter(Boolean).pop() ?? folder;
  return {
    key: `${parsed.host}/${path.toLowerCase()}`,
    name,
    homepage: FORGES.has(parsed.host) ? `https://${parsed.host}/${path}` : null,
    remote: cleaned,
  };
}

interface Block {
  kind: "repo" | "skip";
  fields: Record<string, string>;
}

function blocksOf(stdout: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of stdout.split("\n")) {
    if (line === "---SCOUT-REPO---" || line === "---SCOUT-SKIP---") {
      if (current) blocks.push(current);
      current = { kind: line === "---SCOUT-REPO---" ? "repo" : "skip", fields: {} };
      continue;
    }
    if (!current) continue;
    const match = /^([a-z]+)=(.*)$/.exec(line);
    const key = match?.[1];
    if (key && !(key in current.fields)) current.fields[key] = match?.[2] ?? "";
  }
  if (current) blocks.push(current);
  return blocks;
}

function digits(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function orNull(value: string | undefined): string | null {
  return value ? value : null;
}

function versionOf(describe: string, commit: string): string {
  if (describe !== "" && TAGGED.test(describe)) return describe;
  return commit.slice(0, 12);
}

function skippedText(count: number, singular: string, plural: string): string | null {
  if (count === 0) return null;
  return `skipped ${count} ${count === 1 ? singular : plural}`;
}

export const adapter: Adapter = {
  sourceKind: "gitclone",
  os: ["windows", "macos", "linux"],
  probes(ctx: ProbeContext, _location: string) {
    const roots = ctx.roots["clone"] ?? [];
    if (ctx.os === "windows") {
      return [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-CommandWithArgs", GITCLONE_PS1, ...roots] }];
    }
    return [{ id: "list", argv: ["/bin/sh", "-c", GITCLONE_SH, "gitclone", ...roots] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    const empty: ScanResult = { sourceKind: "gitclone", location, status: "ok", installs: [] };
    if (!probe) return { ...empty, status: "failed", message: "probe output missing" };
    const stdout = probe.stdout.replaceAll("\r\n", "\n");
    if (stdout.includes("---SCOUT-NO-GIT---")) return { ...empty, status: "skipped", message: "git is not installed" };
    if (stdout.trim() === "") {
      if (probe.exitCode !== 0) return { ...empty, status: "failed", message: `probe exited ${probe.exitCode}` };
      return empty;
    }
    const installs: InstallRecord[] = [];
    let noRemote = 0;
    let timedOut = 0;
    let unreadable = 0;
    for (const block of blocksOf(stdout)) {
      if (block.kind === "skip") {
        if (block.fields["reason"] === "timeout") timedOut++;
        else unreadable++;
        continue;
      }
      const path = (block.fields["path"] ?? "").replaceAll("\\", "/");
      const commit = block.fields["commit"] ?? "";
      if (path === "" || commit === "") {
        unreadable++;
        continue;
      }
      const normalized = normalizeRemote(block.fields["remote"] ?? "", path);
      if (!normalized) {
        noRemote++;
        continue;
      }
      const describe = block.fields["describe"] ?? "";
      installs.push({
        ecosystem: "gitclone",
        key: normalized.key,
        name: normalized.name,
        kind: "repo",
        version: versionOf(describe, commit),
        location: path,
        ...(normalized.homepage ? { homepage: normalized.homepage } : {}),
        details: {
          commit,
          branch: orNull(block.fields["branch"]),
          defaultBranch: orNull(block.fields["default"]),
          remote: normalized.remote,
          describe: orNull(describe),
          nearestTag: orNull(block.fields["tag"]),
          dirty: digits(block.fields["dirty"]) ?? 0,
          ahead: digits(block.fields["ahead"]),
          behind: digits(block.fields["behind"]),
          lastCommitAt: orNull(block.fields["committed"]),
        },
      });
    }
    const notes = [
      skippedText(noRemote, "clone with no remote", "clones with no remote"),
      skippedText(timedOut, "timed-out repo", "timed-out repos"),
      skippedText(unreadable, "unreadable clone", "unreadable clones"),
      probe.exitCode !== 0 ? `probe exited ${probe.exitCode}` : null,
    ].filter((note): note is string => note !== null);
    if (notes.length > 0) return { ...empty, status: "partial", installs, message: notes.join("; ") };
    return { ...empty, installs };
  },
};
