import { hubMachineId } from "./hub.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Project {
  machineId: string;
  name: string;
  root: string;
}

export interface ProjectText {
  text: string;
  hash: string;
}

const FILES = ["README.md", "README", "CLAUDE.md", "package.json", "Cargo.toml", "pyproject.toml", ".claude/launch.json", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
// Folders starting with an at sign are private vaults, not software, so they are never read.
const ignored = (name: string): boolean => /^[_.@]/.test(name) || name === "node_modules";

function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

export function findProjects(machineId: string, roots: readonly string[]): Project[] {
  if (machineId !== hubMachineId()) return [];
  const projects = new Map<string, Project>();
  for (const entry of roots) {
    const normalized = entry.replace(/\\/g, "/");
    let candidates: string[] = [];
    if (normalized.endsWith("/*")) {
      const parent = normalized.slice(0, -2);
      try { candidates = readdirSync(parent, { withFileTypes: true }).filter((item) => item.isDirectory() && !ignored(item.name)).map((item) => join(parent, item.name)); } catch { continue; }
    } else candidates = [normalized];
    for (const candidate of candidates) {
      const root = resolve(candidate).replace(/\\/g, "/");
      if (ignored(basename(root))) continue;
      try { if (!lstatSync(root).isDirectory()) continue; } catch { continue; }
      if (!FILES.some((file) => regularFile(join(root, file)))) continue;
      projects.set(root.toLowerCase(), { machineId, name: basename(root), root });
    }
  }
  return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum - count / value.length * Math.log2(count / value.length), 0);
}

export function scrubProjectText(text: string): string {
  return text.split(/\r?\n/).map((line) => {
    const credential = /(?:[\w.-]*(?:key|token|secret|password|bearer)[\w.-]*["']?\s*[:=]\s*["']?\S{12,}|\bbearer\s+\S{12,}|\b(?:sk-|gh[pousr]_|github_pat_|AKIA|AIza)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
    // Assignment-shaped lines match the existing command-output secret filter.
    const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;
    if (credential.test(line) || assignment.test(line)) return "[credential removed]";
    // Only a token that looks like a key goes; paths, links and hyphenated names are prose and stay.
    return line.replace(/[^\s/]{32,}/g, (token, offset: number) => {
      const next = line[offset + token.length];
      if (line[offset - 1] === "/" || next === "/") return token;
      return /\d/.test(token) && /[A-Za-z]/.test(token) && entropy(token) >= 4 ? "[credential removed]" : token;
    });
  }).join("\n");
}

function tomlSection(text: string, section: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n");
}

export function collectProjectText(root: string): ProjectText {
  const sections: string[] = [];
  let length = 0;
  for (const [names, cap, section] of [
    [["README.md", "README"], 9000, null], [["CLAUDE.md"], 9000, null],
    [["package.json"], 3000, null], [["Cargo.toml"], 3000, "package"], [["pyproject.toml"], 3000, "project"],
  ] as const) {
    const file = names.find((name) => regularFile(join(root, name)));
    if (!file) continue;
    let content: string;
    try { content = readFileSync(join(root, file), "utf8"); } catch { continue; }
    if (file === "package.json") {
      try {
        const value: unknown = JSON.parse(content);
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        content = JSON.stringify(Object.fromEntries(["name", "description", "bin", "scripts", "main", "keywords"].filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]])), null, 2);
      } catch { continue; }
    } else if (section) content = tomlSection(content, section);
    if (!content.trim()) continue;
    const header = `--- ${file} ---\n`;
    const separator = sections.length ? "\n\n" : "";
    const available = 24_000 - length - separator.length - header.length;
    if (available <= 0) break;
    const part = separator + header + scrubProjectText(content).slice(0, Math.min(cap, available));
    sections.push(part);
    length += part.length;
  }
  const text = sections.join("");
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}
