import type { Adapter, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

type Selector = NonNullable<ScanResult["selectors"]>[number];

const PROJECT_SH = `set -o pipefail
if [ "$#" -eq 0 ]; then set -- "$HOME"; fi
for root in "$@"; do
  case "$root" in /*) ;; *) exit 2 ;; esac
done
{ find "$@" -maxdepth 5 \\( -type d \\( -name node_modules -o -name .git -o -name Library -o -name .Trash -o -name .cache -o -name cache -o -name caches -o -name Caches -o -name .nvm -o -name .pyenv -o -name .asdf -o -name .rustup -o -name .cargo -o -name '.vscode*' -o -name .cursor -o -name .windsurf -o -name .claude -o -name .codex -o -name .npm -o -name .pnpm-store -o -name .bun \\) -prune \\) -o \\( -type f \\( -name .nvmrc -o -name .node-version -o -name .tool-versions -o -name .python-version -o -name rust-toolchain -o -name rust-toolchain.toml -o -name package.json \\) -print0 \\) 2>/dev/null || true; } |
{
  count=0
  while IFS= read -r -d '' file; do
    if [ "$count" -ge 300 ]; then continue; fi
    case "$file" in
      */package.json)
        # Only two fields matter and they sit anywhere in a large file, so print just those as one small object.
        pm=$(grep -m1 -o '"packageManager"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" || true)
        eng=$(tr -d '\\r\\n' < "$file" | grep -o '"engines"[[:space:]]*:[[:space:]]*{[^}]*}' | head -n 1 || true)
        body="$pm"
        if [ -n "$eng" ]; then body="\${body:+$body,}$eng"; fi
        [ -n "$body" ] || continue
        printf '=== %s\\n{%s}\\n' "$file" "$body"
        ;;
      *)
        printf '=== %s\\n' "$file"
        head -c 400 "$file" || exit 1
        printf '\\n'
        ;;
    esac
    count=$((count + 1))
  done
}
`;

const PROJECT_PS = `$ErrorActionPreference = 'Stop'
$projectRoots = ConvertFrom-Json -InputObject $args[0]
$skip = @('node_modules', '.git', 'Library', '.Trash', '.cache', 'cache', 'caches', 'Caches', '.nvm', '.pyenv', '.asdf', '.rustup', '.cargo', '.cursor', '.windsurf', '.claude', '.codex', '.npm', '.pnpm-store', '.bun')
$names = @('.nvmrc', '.node-version', '.tool-versions', '.python-version', 'rust-toolchain', 'rust-toolchain.toml', 'package.json')
$pending = [System.Collections.Generic.Queue[object]]::new()
foreach ($root in $projectRoots) {
  if (-not [IO.Path]::IsPathFullyQualified($root)) { throw 'Project roots must be absolute paths' }
  $pending.Enqueue(@{ Path = $root; Depth = 0 })
}
$count = 0
while ($pending.Count -gt 0 -and $count -lt 300) {
  $entry = $pending.Dequeue()
  $directory = Get-Item -LiteralPath $entry.Path -Force
  if ($directory.Name -in $skip -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
  foreach ($item in Get-ChildItem -LiteralPath $entry.Path -Force) {
    if ($count -ge 300) { break }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($item.PSIsContainer) {
      if ($entry.Depth -lt 4 -and $item.Name -notin $skip) { $pending.Enqueue(@{ Path = $item.FullName; Depth = $entry.Depth + 1 }) }
    } elseif ($item.Name -in $names) {
      if ($item.Name -eq 'package.json') {
        # Only two fields matter and they sit anywhere in a large file, so print just those as one small object.
        try { $pkg = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($item.FullName)) } catch { continue }
        $small = [ordered]@{}
        if ($pkg.PSObject.Properties['packageManager']) { $small['packageManager'] = $pkg.packageManager }
        if ($pkg.PSObject.Properties['engines']) { $small['engines'] = $pkg.engines }
        if ($small.Count -eq 0) { continue }
        [Console]::WriteLine('=== ' + $item.FullName.Replace([char]92, [char]47))
        [Console]::WriteLine((ConvertTo-Json -InputObject $small -Compress -Depth 4))
      } else {
        $stream = [IO.File]::OpenRead($item.FullName)
        try {
          $buffer = [byte[]]::new(400)
          $length = $stream.Read($buffer, 0, 400)
          [Console]::WriteLine('=== ' + $item.FullName.Replace([char]92, [char]47))
          [Console]::Write([Text.Encoding]::UTF8.GetString($buffer, 0, $length))
          [Console]::WriteLine()
        } finally { $stream.Dispose() }
      }
      $count++
    }
  }
}
`;

const TOOLS: Record<string, Selector["kind"]> = { node: "node", nodejs: "node", python: "python", rust: "rust", golang: "go", go: "go", ruby: "ruby", pnpm: "packageManager", yarn: "packageManager", npm: "packageManager" };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function parseFile(file: string, text: string): Selector[] | null {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const project = file.slice(0, file.lastIndexOf("/")) || "/";
  const selectors: Selector[] = [];
  const add = (kind: Selector["kind"], tool: string, spec: string) => selectors.push({ file, project, kind, tool, spec });
  const lines = text.replace(/^\uFEFF/, "").split("\n").map((line) => line.replace(/\s*#.*$/, "").trim()).filter(Boolean);
  if (name === "package.json") {
    let pkg: unknown;
    try { pkg = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
    if (!object(pkg)) return null;
    if (pkg["packageManager"] !== undefined) {
      if (typeof pkg["packageManager"] !== "string") return null;
      const match = /^(pnpm|yarn|npm)@([^\s]+)$/.exec(pkg["packageManager"]);
      if (!match) return null;
      // Corepack appends a +sha512 integrity hash that means nothing to a person reading the note.
      add("packageManager", match[1]!, match[2]!.replace(/\+.*$/, ""));
    }
    if (pkg["engines"] !== undefined) {
      if (!object(pkg["engines"])) return null;
      for (const [tool, spec] of Object.entries(pkg["engines"])) {
        if (typeof spec !== "string" || spec.trim() === "") return null;
        if (TOOLS[tool]) add("engines", tool === "nodejs" ? "node" : tool === "golang" ? "go" : tool, spec.trim());
      }
    }
    return selectors;
  }
  if (lines.length === 0) return null;
  if (name === ".tool-versions") {
    for (const line of lines) {
      const match = /^(\S+)\s+(.+)$/.exec(line);
      if (!match) return null;
      const tool = match[1]!;
      const kind = TOOLS[tool];
      if (kind) add(kind, tool === "nodejs" ? "node" : tool === "golang" ? "go" : tool, match[2]!);
    }
  } else if (name === "rust-toolchain.toml" || (name === "rust-toolchain" && lines[0] === "[toolchain]")) {
    const section = lines.indexOf("[toolchain]");
    if (section < 0) return null;
    for (const line of lines.slice(section + 1)) {
      if (line.startsWith("[")) break;
      const match = /^channel\s*=\s*["']([^"']+)["']\s*$/.exec(line);
      if (match) { add("rust", "rust", match[1]!); break; }
    }
    if (selectors.length === 0) return null;
  } else {
    const kind = name === ".nvmrc" || name === ".node-version" ? "node" : name === ".python-version" ? "python" : name === "rust-toolchain" ? "rust" : undefined;
    if (!kind || (kind !== "python" && lines.length !== 1) || lines.some((line) => /\s/.test(line))) return null;
    for (const spec of lines) add(kind, kind, spec);
  }
  return selectors;
}

export const adapter: Adapter = {
  sourceKind: "projectsel",
  os: ["macos", "windows", "linux"],
  probes(ctx: ProbeContext, _location: string) {
    const roots = ctx.roots["project"];
    if (ctx.os === "windows") {
      const fallback = Object.values(ctx.roots).flat().filter((root) => root.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase() === "c:/repositories");
      return [{ id: "list", argv: ["pwsh", "-NoProfile", "-NonInteractive", "-CommandWithArgs", PROJECT_PS, JSON.stringify(roots ?? fallback.slice(0, 1))] }];
    }
    if (roots?.length === 0) return [{ id: "list", argv: ["/bin/bash", "-c", "exit 0"] }];
    return [{ id: "list", argv: ["/bin/bash", "-c", PROJECT_SH, "projectsel", ...(roots ?? [])] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const output = outputs["list"];
    const base: ScanResult = { sourceKind: "projectsel", location, status: "ok", installs: [], selectors: [] };
    if (!output) return { ...base, status: "failed", message: "probe output missing" };
    if (output.exitCode !== 0 && output.stdout.trim() === "") return { ...base, status: "failed", message: `project selector probe exited ${output.exitCode}` };
    let file = "";
    let text = "";
    let malformed = 0;
    const flush = () => {
      if (!file) { if (text.trim()) malformed++; return; }
      const parsed = parseFile(file, text);
      if (parsed) base.selectors!.push(...parsed);
      else malformed++;
    };
    for (const line of output.stdout.replace(/^\uFEFF/, "").replaceAll("\r", "").split("\n")) {
      if (line.startsWith("=== ")) {
        flush();
        file = line.slice(4).trim().replaceAll("\\", "/");
        if (!/^(?:\/|[A-Za-z]:\/)/.test(file)) { malformed++; file = ""; }
        text = "";
      } else text += `${line}\n`;
    }
    flush();
    if (malformed || output.exitCode !== 0) return { ...base, status: "partial", message: malformed ? `skipped ${malformed} malformed file(s)` : `project selector probe exited ${output.exitCode}` };
    return base;
  },
};
