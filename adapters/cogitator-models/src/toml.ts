export interface ModelConfig {
  engines: { id: string; args: string[] }[];
  roles: { name: string; chain: string[] }[];
  modelDirs: string[];
  storeDir: string | null;
}

// Quoting matters because paths and comments can both contain brackets.
export function withoutComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === "\\") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

export function strings(value: string): string[] {
  const result: string[] = [];
  for (const m of value.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'/g)) {
    try { result.push(m[0].startsWith("'") ? m[0].slice(1, -1) : JSON.parse(m[0]) as string); } catch { /* A damaged value supplies no path. */ }
  }
  return result;
}

export function assignments(text: string): { section: string; key: string; value: string }[] {
  const out: { section: string; key: string; value: string }[] = [];
  let section = "";
  let pending: { section: string; key: string; value: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = withoutComment(raw).trim();
    if (/^\[.+\]$/.test(line)) {
      pending = null;
      section = line;
      out.push({ section, key: "", value: "" });
      continue;
    }
    if (pending) {
      pending.value += ` ${line}`;
      if (line.endsWith("]")) { out.push(pending); pending = null; }
      continue;
    }
    const m = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const item = { section, key: m[1]!, value: m[2]! };
    if (item.value.startsWith("[") && !item.value.endsWith("]")) pending = item;
    else out.push(item);
  }
  return out;
}

export function readConfig(text: string): ModelConfig {
  const config: ModelConfig = { engines: [], roles: [], modelDirs: [], storeDir: null };
  for (const { section, key, value } of assignments(text)) {
    const values = strings(value);
    if (section === "[[engines]]") {
      if (!key) config.engines.push({ id: "", args: [] });
      const engine = config.engines.at(-1);
      if (engine && key === "id") engine.id = values[0] ?? "";
      if (engine && key === "args") {
        for (let i = 0; i < values.length; i++) {
          if (["-m", "--model", "--mmproj"].includes(values[i]!) && values[i + 1] && !values[i + 1]!.includes("${")) engine.args.push(values[i]!, values[++i]!);
          else if (values[i] === "--embeddings") engine.args.push(values[i]!);
        }
      }
    } else if (section === "[[roles]]") {
      if (!key) config.roles.push({ name: "", chain: [] });
      const role = config.roles.at(-1);
      if (role && key === "name") role.name = values[0] ?? "";
      if (role && key === "chain") role.chain = values.filter((v) => !v.includes("@"));
    } else if (section === "[media]") {
      if (key === "model_dirs") config.modelDirs = values;
      if (key === "store_dir") config.storeDir = values[0] ?? null;
    }
  }
  return config;
}
