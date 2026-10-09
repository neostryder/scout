export function toolName(word: string): string | null {
  const name = word.replaceAll("\\", "/").split("/").at(-1)?.replace(/\.(exe|cmd|bat)$/i, "") ?? "";
  // Names from code pasted into a shell (__name__, cmd-pickup.c, data files) are not programs a person installed.
  if (name.length > 64 || /\.(c|h|cc|cpp|py|js|mjs|cjs|ts|json|md|txt|yml|yaml|toml|lock|log|csv|html|css)$/i.test(name)) return null;
  return /^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/.test(name) ? name : null;
}

export function commandWords(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  const flushWord = () => { if (word !== "") words.push(word); word = ""; };
  const flushCommand = () => { flushWord(); if (words.length > 0) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? "";
    if (c === "\\" && quote !== "'" && /[\s"'\\;&|]/.test(next)) {
      word += next;
      i++;
    } else if (c === "`" && quote !== "'" && next !== "") {
      word += next;
      i++;
    } else if (quote !== "") {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && word === "") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === ";" || c === "|" || c === "\n" || (c === "&" && next === "&")) {
      flushCommand();
      if (next === c) i++;
    } else if (/\s/.test(c)) {
      flushWord();
    } else {
      word += c;
    }
  }
  // An unfinished quote cannot identify an executable safely.
  if (quote === "") flushCommand();
  return commands;
}

export function commandTools(text: string, depth = 0): string[] {
  if (depth > 12) return [];
  const tools: string[] = [];
  const ignored = new Set(["cd", "echo", "printf", "export", "if", "for", "then", "fi", "else", "elif", "while", "do", "done", "case", "esac", "[", "test", "true", "false", "set", "unset", "read", "exit", "return", "break", "continue", ":", "rem"]);
  const assignment = (word: string) => /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word);
  for (const original of commandWords(text)) {
    const words = [...original];
    for (let step = 0; step < 32 && words.length > 0; step++) {
      const raw = words[0]!;
      if (assignment(raw) || raw === "&" || raw === "(") { words.shift(); continue; }
      const name = toolName(raw.replace(/^(@[^/]+\/)?([^@/]+)@[^/]+$/, "$2"));
      if (name === null) break;
      const lower = name.toLowerCase();
      if (["if", "then", "elif", "else", "while", "do"].includes(lower)) { words.shift(); continue; }
      if (["bash", "sh", "zsh", "pwsh", "powershell", "cmd"].includes(lower)) {
        const flag = words.findIndex((w, i) => i > 0 && (/^-[a-z]*c[a-z]*$/i.test(w) || /^-(command|c)$/i.test(w) || /^\/c$/i.test(w)));
        if (flag > 0 && words[flag + 1]) tools.push(...commandTools(["bash", "sh", "zsh"].includes(lower) ? words[flag + 1]! : words.slice(flag + 1).join(" "), depth + 1));
        else tools.push(name);
        break;
      }
      if ((lower === "python" || lower === "python3") && words[1] === "-m") {
        const module = toolName(words[2] ?? "");
        if (module) tools.push(module);
        break;
      }
      if (["sudo", "env", "command", "time", "nohup", "exec", "nice", "xargs", "npx", "uvx"].includes(lower)) {
        words.shift();
        while (words.length > 0) {
          const option = words[0]!;
          if (assignment(option)) { words.shift(); continue; }
          if (!option.startsWith("-")) break;
          words.shift();
          const valued = lower === "sudo" ? ["-u", "--user", "-g", "--group", "-C", "--chdir"] : lower === "env" ? ["-u", "--unset"] : lower === "nice" ? ["-n", "--adjustment"] : lower === "xargs" ? ["-n", "-P", "-I", "-L"] : lower === "npx" || lower === "uvx" ? ["-p", "--package", "--from"] : [];
          if (valued.includes(option) && words.length > 0) words.shift();
          if (option === "--") break;
        }
        continue;
      }
      if ((lower === "pnpm" && ["dlx", "exec"].includes(words[1] ?? "")) || (lower === "uv" && (words[1] === "run" || (words[1] === "tool" && words[2] === "run")))) {
        words.splice(0, lower === "uv" && words[1] === "tool" ? 3 : 2);
        while (words[0]?.startsWith("-")) {
          const option = words.shift();
          if (["--with", "--from", "--python", "--directory", "--project", "--package"].includes(option ?? "")) words.shift();
        }
        continue;
      }
      if (!ignored.has(lower)) {
        tools.push(name);
      }
      break;
    }
  }
  return tools;
}

export function transcriptTools(line: string, agent: string): { tools: string[]; timestamp: string } | null {
  try {
    const row = JSON.parse(line);
    if (typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) return null;
    const timestamp = new Date(row.timestamp).toISOString();
    const commands: string[] = [];
    if (agent === "claude" && row.message?.role === "assistant" && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block?.type === "tool_use" && ["Bash", "PowerShell"].includes(block.name) && typeof block.input?.command === "string") commands.push(block.input.command);
      }
    } else if (agent === "codex" && row.type === "response_item" && row.payload?.type === "function_call" && typeof row.payload.name === "string" && /shell|exec/.test(row.payload.name)) {
      const args = JSON.parse(row.payload.arguments);
      const command = args.command ?? args.cmd;
      if (typeof command === "string") commands.push(command);
      else if (Array.isArray(command) && command.every((v) => typeof v === "string")) {
        if (["bash", "sh", "zsh", "pwsh", "powershell", "cmd"].includes(toolName(command[0] ?? "")?.toLowerCase() ?? "") && command.length >= 3) commands.push(command.slice(2).join(" "));
        else commands.push(command.map((v) => JSON.stringify(v)).join(" "));
      }
    }
    return { tools: commands.flatMap((command) => commandTools(command)), timestamp };
  } catch {
    return null;
  }
}
