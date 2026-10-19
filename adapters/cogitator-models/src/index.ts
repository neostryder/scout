import type { Adapter, InstallRecord, ProbeOutputs, ScanResult } from "@scout/core";
import { CATALOG } from "./catalog.ts";
import { LINUX_SH, MACOS_SH, WINDOWS_PS } from "./probes.ts";
import { assignments, readConfig, strings } from "./toml.ts";

export { readConfig } from "./toml.ts";

const slash = (s: string): string => s.replaceAll("\\", "/");
const base = (s: string): string => slash(s).split("/").at(-1) ?? s;
const pathKey = (s: string): string => {
  const path = slash(s).replace(/^\/([a-z])\//i, "$1:/");
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
};
const stem = (s: string): string => base(s).replace(/\.[^.]+$/, "");
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => typeof v === "string" && v !== "" ? v : null;
const hf = (v: unknown): string | null => {
  const m = /^(?:hf:|https:\/\/huggingface\.co\/)?([\w.-]+\/[\w.-]+)\/?$/.exec(typeof v === "string" ? v : "");
  return m ? `hf:${m[1]}` : null;
};

export function quantization(name: string): string | null {
  const file = base(name).replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  return [...file.matchAll(/(?:^|[.-])((?:UD-)?(?:I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4))(?=$|[.-])/gi)].at(-1)?.[1]?.toUpperCase() ?? null;
}

export function sourceFromPath(path: string): string | null {
  const normalized = slash(path);
  const lm = /\/\.lmstudio\/models\/([^/]+)\/([^/]+)\//i.exec(normalized);
  if (lm) return hf(`${lm[1]}/${lm[2]}`);
  for (const part of normalized.split("/").slice(0, -1).reverse()) {
    const m = /^([^/]+?)__([^/]+)$/.exec(part);
    if (m) return hf(`${m[1]}/${m[2]}`);
  }
  return null;
}

interface ModelFile { path: string; size: number; modified: string; folder?: boolean }
interface Metadata { source: string | null; revision: string | null; sha256: string | null; family: string | null }
function metadata(v: unknown): Metadata {
  const doc = object(v);
  return {
    source: hf(doc.source) ?? hf(doc.repo), revision: text(doc.revision),
    sha256: text(doc.sha256) ?? text(object(doc.Hashes).SHA256),
    family: text(doc.family) ?? text(doc.kind) ?? text(doc.BaseModel) ?? text(doc.base),
  };
}

function family(hints: string): string {
  if (/embed/i.test(hints)) return "embedding";
  if (/speech|whisper|asr|parakeet|transcrib|diari|listen|moss/i.test(hints)) return "speech";
  if (/stablediffusion|checkpoints|diffusers|diffusionmodels|lora|(?:^|[/ ])vae(?:[/ ]|$)|safetensors.*(?:flux|sdxl)/i.test(hints)) return "image";
  if (/vision|mmproj/i.test(hints)) return "vision";
  if (/describe|summarize|chat|instruct|(?:^| )text(?: |$)|--model| -m /i.test(hints)) return "llm";
  return "other";
}

export const adapter: Adapter = {
  sourceKind: "cogmodels",
  os: ["windows", "macos", "linux"],
  probes(ctx) {
    return [{ id: "list", argv: ctx.os === "windows" ? ["pwsh", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PS] : ["/bin/bash", "-c", ctx.os === "macos" ? MACOS_SH : LINUX_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const result: ScanResult = { sourceKind: "cogmodels", location, status: "ok", installs: [] };
    const probe = outputs.list;
    if (!probe) return { ...result, status: "failed", message: "probe output missing" };
    if (probe.stdout.trim() === "" && probe.exitCode === 0) return { ...result, status: "skipped", message: "Cogitator is not installed" };
    let partial = probe.exitCode !== 0 || !probe.stdout.includes("---SCOUT-DONE---");
    let mode = "";
    let content = "";
    let metaPath = "";
    let configText = "";
    const files = new Map<string, ModelFile>();
    const locks = new Map<string, Metadata>();
    const sidecars = new Map<string, Metadata>();
    const catalog = new Map<string, { source: string; family: string }>(Object.entries(CATALOG));
    const flush = (): void => {
      if (mode === "config") configText += content;
      if (mode !== "meta") return;
      try {
        if (base(metaPath) === "catalog.local.toml") {
          let source: string | null = null;
          let kind = "other";
          for (const item of assignments(content)) {
            if (item.section === "[[model]]" && !item.key) { source = null; kind = "other"; }
            if (item.section === "[[model]]" && item.key === "source") source = hf(strings(item.value)[0]);
            if (item.section === "[[model]]" && item.key === "kind") kind = strings(item.value)[0] ?? "other";
            if (item.section === "[[model.file]]" && item.key === "path" && source) catalog.set(base(strings(item.value)[0] ?? ""), { source, family: kind });
          }
        } else if (base(metaPath) === "lock.json") {
          const doc = object(JSON.parse(content));
          if (!Array.isArray(doc.models)) { partial = true; return; }
          for (const value of doc.models) {
            const rec = object(value);
            if (typeof rec.path === "string") {
              const path = /^(?:[a-z]:[/\\]|\/)/i.test(rec.path) ? rec.path : `${slash(metaPath).replace(/\/lock\.json$/, "")}/${rec.path}`;
              locks.set(pathKey(path), metadata(rec));
            } else partial = true;
          }
        } else if (/\.(?:cm-info|cogitator)\.json$/.test(metaPath)) {
          const key = pathKey(metaPath.replace(/\.(?:cm-info|cogitator)\.json$/, ""));
          const next = metadata(JSON.parse(content));
          const previous = sidecars.get(key);
          sidecars.set(key, Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v ?? previous?.[k as keyof Metadata] ?? null])) as unknown as Metadata);
        }
      } catch { partial = true; }
    };
    for (const line of probe.stdout.replaceAll("\r\n", "\n").split("\n")) {
      if (line.startsWith("---SCOUT-")) {
        flush(); content = "";
        mode = line === "---SCOUT-CONFIG---" ? "config" : line === "---SCOUT-FILE---" ? "file" : line === "---SCOUT-FOLDER---" ? "folder" : "";
        const match = /^---SCOUT-META (.+)---$/.exec(line);
        if (match) { mode = "meta"; metaPath = match[1]!; }
        if (line === "---SCOUT-PARTIAL---") partial = true;
      } else if (mode === "file" || mode === "folder") {
        if (!line.trim()) continue;
        const fields = line.split("\t");
        const isFolder = mode === "folder";
        const [path = "", size = "", modified = ""] = isFolder ? [fields[0], "0", fields[1]] : fields;
        if (!path || !Number.isFinite(Number(size)) || Number(size) < 0 || !Number.isFinite(Date.parse(modified))) { partial = true; continue; }
        files.set(pathKey(path), { path: slash(path), size: Number(size), modified: new Date(modified).toISOString(), ...(isFolder ? { folder: true } : {}) });
      } else content += `${line}\n`;
    }
    flush();
    const config = readConfig(configText);
    const companions = new Map<string, Set<string>>();
    const attached = new Set<string>();
    const attach = (main: string, other: string): void => {
      if (main === other || !files.has(main) || !files.has(other)) return;
      if (!companions.has(main)) companions.set(main, new Set());
      companions.get(main)!.add(other); attached.add(other);
    };
    for (const engine of config.engines) {
      const paths = engine.args.flatMap((arg, i) => arg === "-m" || arg === "--model" ? [pathKey(engine.args[i + 1] ?? "")] : []);
      const mm = engine.args.indexOf("--mmproj");
      if (paths[0] && mm >= 0) attach(paths[0], pathKey(engine.args[mm + 1] ?? ""));
    }
    for (const [key, file] of files) {
      const shard = /-\d{5}-of-(\d{5})\.gguf$/i.exec(file.path);
      if (shard && !/-00001-of-\d{5}\.gguf$/i.test(file.path)) attach(pathKey(file.path.replace(/-\d{5}-of-(\d{5})\.gguf$/i, "-00001-of-$1.gguf")), key);
      for (const [folderKey, folder] of files) if (folder.folder && key !== folderKey && key.startsWith(`${folderKey}/`)) attach(folderKey, key);
    }
    for (const [key, file] of files) {
      if (attached.has(key)) continue;
      const associated = [key];
      for (let i = 0; i < associated.length; i++) {
        for (const companion of companions.get(associated[i]!) ?? []) if (!associated.includes(companion)) associated.push(companion);
      }
      const engines = config.engines.filter((engine) => engine.args.some((arg) => associated.includes(pathKey(arg))));
      const engineIds = engines.map((e) => e.id).filter(Boolean);
      const roles = config.roles.filter((r) => r.chain.some((id) => engineIds.includes(id))).map((r) => r.name);
      const lock = locks.get(key);
      const sidecar = sidecars.get(pathKey(file.folder ? file.path : file.path.replace(/\.[^./]+$/, "")));
      const entry = catalog.get(base(file.path));
      const pathSource = sourceFromPath(`${file.path}${file.folder ? "/weights.safetensors" : ""}`);
      const source = lock?.source ?? sidecar?.source ?? pathSource ?? entry?.source ?? null;
      const sourceFrom = lock?.source ? "lock" : sidecar?.source ? "sidecar" : pathSource ? "path" : entry?.source ? "catalog" : "none";
      const revision = lock?.revision ?? sidecar?.revision ?? null;
      const sha256 = lock?.sha256 ?? sidecar?.sha256 ?? null;
      const quant = /\.gguf$/i.test(file.path) ? quantization(file.path) : null;
      const repo = source?.slice(3);
      const name = repo?.split("/")[1] ?? (file.folder ? base(file.path) : stem(file.path));
      const related = associated.slice(1).map((k) => files.get(k)!).filter(Boolean);
      const details = {
        quant, format: file.folder ? "mlx" : /\.gguf$/i.test(file.path) ? "gguf" : /\.safetensors$/i.test(file.path) ? "safetensors" : /\.onnx$/i.test(file.path) ? "onnx" : "other",
        family: family(`${file.path} ${sidecar?.family ?? entry?.family ?? ""} ${engineIds.join(" ")} ${roles.join(" ")} ${engines.flatMap((e) => e.args).join(" ")}`),
        sizeBytes: file.size + related.reduce((sum, f) => sum + f.size, 0), modifiedAt: file.modified,
        source, sourceFrom, revision, sha256, engineIds, roles,
        companions: related.map((f) => ({ path: f.path, sizeBytes: f.size, modifiedAt: f.modified })),
      };
      const install: InstallRecord = { ecosystem: "model", kind: "model", key: source ? `${source}${quant ? `:${quant}` : ""}` : `local:${file.folder ? base(file.path) : stem(file.path)}`, name: `${name}${quant ? ` ${quant}` : ""}`, version: (revision ?? sha256)?.slice(0, 12) ?? null, location: file.path, details };
      if (repo) { install.publisher = repo.split("/")[0]!; install.homepage = `https://huggingface.co/${repo}`; }
      result.installs.push(install);
    }
    result.installs.sort((a, b) => a.location.localeCompare(b.location));
    if (partial) { result.status = "partial"; result.message = "model probe was incomplete or contained malformed metadata"; }
    return result;
  },
};
