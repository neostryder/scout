$ErrorActionPreference = 'Stop'
# Cogitator's home: COGITATOR_HOME, then the per-user folder, then a Cogitator folder at the root of a fixed drive (a moved install).
$data = ''
$candidates = [Collections.Generic.List[string]]::new()
if ($env:COGITATOR_HOME) { $candidates.Add($env:COGITATOR_HOME) }
$candidates.Add((Join-Path $env:LOCALAPPDATA 'Cogitator'))
foreach ($drive in [IO.DriveInfo]::GetDrives()) { if ($drive.DriveType -eq 'Fixed') { $candidates.Add((Join-Path $drive.Name 'Cogitator')) } }
foreach ($candidate in $candidates) {
    if ((Test-Path -LiteralPath $candidate -PathType Container) -and (Test-Path -LiteralPath (Join-Path $candidate 'cogitator.toml') -PathType Leaf)) { $data = $candidate; break }
}
if (-not $data) { exit 0 }
$watch = [Diagnostics.Stopwatch]::StartNew()
$script:count = 0
$script:partial = $false
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$roots = [Collections.Generic.List[string]]::new()
$roots.Add((Join-Path $data 'models'))
$roots.Add((Join-Path $data 'data/models'))
function Strip-Comment([string]$line) {
    $quote = ''; $escaped = $false
    for ($i = 0; $i -lt $line.Length; $i++) {
        $c = [string]$line[$i]
        if ($escaped) { $escaped = $false; continue }
        if ($quote -eq '"' -and $c -eq '\') { $escaped = $true; continue }
        if ($quote) { if ($c -eq $quote) { $quote = '' } }
        elseif ($c -eq '"' -or $c -eq "'") { $quote = $c }
        elseif ($c -eq '#') { return $line.Substring(0, $i) }
    }
    return $line
}
function Values([string]$value) {
    foreach ($m in [regex]::Matches($value, '"(?:\\.|[^"\\])*"|''[^'']*''')) {
        try {
            if ($m.Value.StartsWith("'")) { $m.Value.Substring(1, $m.Value.Length - 2) }
            else { ConvertFrom-Json $m.Value }
        } catch { $script:partial = $true }
    }
}
function Emit-Field([string]$section, [string]$key, [string]$value) {
    if ($section -eq '' -and $key -eq 'data_dir') {
        $items = @(Values $value)
        if ($items.Count -gt 0 -and -not $items[0].Contains('${')) { $roots.Add((Join-Path $items[0] 'models')) }
        return
    }
    $allowed = ($section -eq '[[engines]]' -and $key -in 'id','args') -or ($section -eq '[[roles]]' -and $key -in 'name','chain') -or ($section -eq '[media]' -and $key -in 'model_dirs','store_dir')
    if (-not $allowed) { return }
    $items = @(Values $value)
    if ($section -eq '[[engines]]' -and $key -eq 'args') {
        $keep = [Collections.Generic.List[string]]::new()
        for ($i = 0; $i -lt $items.Count; $i++) {
            if ($items[$i] -in '-m','--model','--mmproj' -and $i + 1 -lt $items.Count -and -not $items[$i + 1].Contains('${')) {
                $keep.Add($items[$i]); $i++; $keep.Add($items[$i]); $roots.Add($items[$i])
            } elseif ($items[$i] -eq '--embeddings') { $keep.Add($items[$i]) }
        }
        $items = @($keep)
    }
    if ($section -eq '[media]') { foreach ($item in $items) { if (-not $item.Contains('${')) { $roots.Add($item) } } }
    if ($key -eq 'chain') { $items = @($items | Where-Object { -not $_.Contains('@') }) }
    $quoted = @($items | ForEach-Object { ConvertTo-Json -Compress -InputObject $_ })
    if ($value.Trim().StartsWith('[')) { "$key = [$($quoted -join ', ')]" }
    elseif ($quoted.Count -gt 0) { "$key = $($quoted[0])" }
}
'---SCOUT-CONFIG---'
$config = Join-Path $data 'cogitator.toml'
if (Test-Path -LiteralPath $config -PathType Leaf) {
    $section = ''; $pendingKey = ''; $pendingValue = ''
    foreach ($raw in [IO.File]::ReadLines($config)) {
        if ($watch.Elapsed.TotalSeconds -ge 20) { $script:partial = $true; break }
        $line = (Strip-Comment $raw).Trim()
        if ($line -match '^\[.+\]$') {
            $section = $line; $pendingKey = ''; $pendingValue = ''
            if ($section -in '[[engines]]','[[roles]]','[media]') { $section }
        } elseif ($pendingKey) {
            $pendingValue += ' ' + $line
            if ($line.EndsWith(']')) { Emit-Field $section $pendingKey $pendingValue; $pendingKey = '' }
        } elseif ($line -match '^(\w+)\s*=\s*(.*)$') {
            $key = $Matches[1]; $value = $Matches[2]
            if ($value.StartsWith('[') -and -not $value.EndsWith(']')) { $pendingKey = $key; $pendingValue = $value }
            else { Emit-Field $section $key $value }
        }
    }
}
function Metadata([string]$path) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        if ($watch.Elapsed.TotalSeconds -ge 20) { $script:partial = $true; return }
        try {
            $item = Get-Item -LiteralPath $path
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
            if ($item.Length -gt 2097152) { $script:partial = $true; return }
            "---SCOUT-META $($path.Replace('\','/'))---"
            [IO.File]::ReadAllText($path)
            '---SCOUT-END---'
        } catch { $script:partial = $true }
    }
}
Metadata (Join-Path $data 'models/lock.json')
Metadata (Join-Path $data 'catalog.local.toml')
Metadata (Join-Path $data 'data/catalog.local.toml')
function Walk([string]$path, [int]$depth) {
    if ($watch.Elapsed.TotalSeconds -ge 20 -or $script:count -ge 2000) { $script:partial = $true; return }
    try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
        if (-not $seen.Add($item.FullName)) { return }
        if ($item.PSIsContainer) {
            $children = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop)
            $folder = ($children.Name -contains 'config.json') -and @($children | Where-Object { $_.Extension -eq '.safetensors' }).Count -gt 0
            if ($folder) { "---SCOUT-FOLDER---`n$($item.FullName.Replace('\','/'))`t$($item.LastWriteTimeUtc.ToString('o'))" }
            foreach ($child in $children) {
                if ($watch.Elapsed.TotalSeconds -ge 20 -or $script:count -ge 2000) { $script:partial = $true; break }
                if ($child.Name -eq 'lock.json' -and $child.FullName.StartsWith(((Join-Path $data 'data/models') + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { Metadata $child.FullName }
                if ($child.PSIsContainer) { if ($depth -gt 0) { Walk $child.FullName ($depth - 1) } }
                else { Walk $child.FullName $depth }
            }
        } elseif ($item.Extension.ToLowerInvariant() -in '.gguf','.safetensors','.ckpt','.pt','.pth','.bin','.onnx','.mlmodel','.npz') {
            if ($item.Extension -eq '.gguf') {
                $stream = [IO.File]::OpenRead($item.FullName)
                try { $bytes = [byte[]]::new(8); $n = $stream.Read($bytes, 0, 8) } finally { $stream.Dispose() }
                if ($n -lt 4 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'GGUF') { $script:partial = $true; return }
            }
            $script:count++
            "---SCOUT-FILE---`n$($item.FullName.Replace('\','/'))`t$($item.Length)`t$($item.LastWriteTimeUtc.ToString('o'))"
            foreach ($suffix in '.cm-info.json','.cogitator.json') { Metadata ([IO.Path]::ChangeExtension($item.FullName, $suffix)) }
        }
    } catch { $script:partial = $true }
}
foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) { Walk $root 4 }
}
if ($script:partial) { '---SCOUT-PARTIAL---' }
'---SCOUT-DONE---'
