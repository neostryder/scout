# Read-only. Roots are arguments. A missing git is a marker, not a failure.
# node_modules and names starting with "_" or "." are not entered. The root
# argument itself is always entered. A .git file is a worktree or submodule.
# Each repository runs in a job so a hung git cannot stall the scan.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = 'SilentlyContinue'
$roots = @($args)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Output '---SCOUT-NO-GIT---'
  exit 0
}

$env:GIT_OPTIONAL_LOCKS = '0'
$env:GIT_TERMINAL_PROMPT = '0'

function Expand-Root([string]$root) {
  if ($root -eq '~') { return $env:USERPROFILE }
  if ($root.StartsWith('~/') -or $root.StartsWith('~\')) {
    return (Join-Path $env:USERPROFILE $root.Substring(2))
  }
  return $root
}

function Test-SkippedName([string]$name) {
  return ($name -eq 'node_modules' -or $name.StartsWith('_') -or $name.StartsWith('.'))
}

function Convert-Forward([string]$path) {
  return ([IO.Path]::GetFullPath($path)).Replace('\', '/')
}

function Invoke-Repo([string]$dir) {
  $full = Convert-Forward $dir
  $job = Start-Job -ArgumentList $full -ScriptBlock {
    param($path)
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $env:GIT_OPTIONAL_LOCKS = '0'
    $env:GIT_TERMINAL_PROMPT = '0'
    function Git-Line([string]$repo, [string[]]$gitArgs) {
      $output = & git -C $repo @gitArgs 2>$null
      if ($LASTEXITCODE -ne 0 -or $null -eq $output) { return '' }
      $line = @($output) | Select-Object -First 1
      return ("$line").Trim().Trim("`r")
    }
    function Strip-Userinfo([string]$remote) {
      if ($remote -match '^([a-zA-Z][a-zA-Z0-9.-]*://)[^/@]*:[^@]*@(.*)$') {
        return ($Matches[1] + $Matches[2])
      }
      return $remote
    }
    $remote = Git-Line $path @('remote', 'get-url', 'origin')
    if (-not $remote) {
      $names = & git -C $path remote 2>$null
      if ($LASTEXITCODE -eq 0 -and $names) {
        $first = @($names) | Select-Object -First 1
        if ($first) { $remote = Git-Line $path @('remote', 'get-url', "$first") }
      }
    }
    $remote = Strip-Userinfo "$remote"
    $commit = Git-Line $path @('rev-parse', 'HEAD')
    $branch = Git-Line $path @('symbolic-ref', '--short', 'HEAD')
    $default = Git-Line $path @('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    $describe = Git-Line $path @('describe', '--tags', '--always', '--long')
    $status = & git -C $path status --porcelain 2>$null
    $dirty = 0
    if ($LASTEXITCODE -eq 0 -and $null -ne $status) {
      $dirty = @($status | Where-Object { "$_".Trim() -ne '' }).Count
    }
    $abText = & git -C $path rev-list --left-right --count 'HEAD...@{upstream}' 2>$null
    $ahead = ''
    $behind = ''
    if ($LASTEXITCODE -eq 0 -and $abText) {
      $parts = ("$abText").Trim() -split '\s+'
      if ($parts.Count -ge 2) { $ahead = $parts[0]; $behind = $parts[1] }
    }
    $committed = Git-Line $path @('log', '-1', '--format=%cI')
    $tag = Git-Line $path @('describe', '--tags', '--abbrev=0')
    Write-Output ('remote=' + $remote)
    Write-Output ('commit=' + $commit)
    Write-Output ('branch=' + $branch)
    Write-Output ('default=' + $default)
    Write-Output ('describe=' + $describe)
    Write-Output ('dirty=' + $dirty)
    Write-Output ('ahead=' + $ahead)
    Write-Output ('behind=' + $behind)
    Write-Output ('committed=' + $committed)
    Write-Output ('tag=' + $tag)
  }
  $done = Wait-Job -Job $job -Timeout 20
  if (-not $done) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    Write-Output '---SCOUT-SKIP---'
    Write-Output ('path=' + $full)
    Write-Output 'reason=timeout'
    return
  }
  Write-Output '---SCOUT-REPO---'
  Write-Output ('path=' + $full)
  Receive-Job -Job $job | ForEach-Object { Write-Output "$_" }
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}

function Scan-Dir([string]$dir, [int]$depth, [bool]$explicit) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $item = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if (-not $explicit -and $item.LinkType) { return }
  if (-not $explicit -and (Test-SkippedName $item.Name)) { return }
  $gitPath = Join-Path $dir '.git'
  if (Test-Path -LiteralPath $gitPath) {
    $gitItem = Get-Item -LiteralPath $gitPath -Force -ErrorAction SilentlyContinue
    if ($gitItem -and $gitItem.PSIsContainer -and -not $gitItem.LinkType) { Invoke-Repo $dir }
    return
  }
  if ($depth -ge 3) { return }
  foreach ($child in @(Get-ChildItem -LiteralPath $dir -Force -Directory -ErrorAction SilentlyContinue)) {
    Scan-Dir $child.FullName ($depth + 1) $false
  }
}

foreach ($raw in $roots) {
  if (-not $raw) { continue }
  Scan-Dir (Expand-Root "$raw") 0 $true
}
exit 0
